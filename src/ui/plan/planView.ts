import { Notice, setIcon, setTooltip } from "obsidian";
import type DarjeelingPlugin from "../../main";
import type { SessionManager } from "../../net/sessionManager";
import { AgentClient } from "../../net/agentClient";
import { createPlanEmptyState } from "../illustrations";
import {
  DarjeelingPlan,
  Finding,
  PlanPhase,
  SEVERITY_ORDER,
  validatePlan,
} from "./planTypes";
import {
  saveArtifact,
  exportToCanvas,
  insertPlanIntoActiveNote,
  loadFromArtifact,
} from "./planArtifacts";
import {
  advanceActivePhase,
  draftPlan,
  handOffPhase,
  phaseBrief,
  verifyPlan,
} from "./planRunner";

/**
 * Creates a button with both an icon and a text label without Obsidian's setIcon wiping out the text (PD-04, DM-05).
 */
function createIconButton(
  parent: HTMLElement,
  icon: string,
  text: string,
  cls = "dj-btn",
  disabled = false
): HTMLButtonElement {
  const btn = parent.createEl("button", {
    cls,
    attr: {
      type: "button",
      "aria-label": text,
    },
  });
  const iconSpan = btn.createSpan({ cls: "dj-btn-icon" });
  setIcon(iconSpan, icon);
  btn.createSpan({ cls: "dj-btn-label", text });
  setTooltip(btn, text);
  if (disabled) {
    btn.disabled = true;
    btn.setAttribute("aria-disabled", "true");
  }
  return btn;
}

interface UnrefableTimer {
  unref?: () => void;
}

export class DarjeelingPlanPanel {
  private plugin: DarjeelingPlugin;
  private sessions: SessionManager;
  private client: AgentClient;
  private hostEl: HTMLElement;
  private bodyEl: HTMLElement | null = null;

  private plan: DarjeelingPlan | null = null;
  private draftText = "";
  private busy = false;
  private busyStep = "";
  private busyStartTime: number | null = null;
  private progressTimer: number | null = null;

  private confirmingDiscard = false;
  private discardTimer: number | null = null;
  private unsubscribeStore: (() => void) | null = null;

  constructor(
    plugin: DarjeelingPlugin,
    sessions: SessionManager,
    client: AgentClient,
    hostEl: HTMLElement
  ) {
    this.plugin = plugin;
    this.sessions = sessions;
    this.client = client;
    this.hostEl = hostEl;

    // Initialize from planStore or settings (PD-33, PD-35)
    this.syncFromStore();
  }

  mount(): void {
    this.hostEl.empty();
    this.bodyEl = this.hostEl.createDiv({ cls: "dj-plan" });

    // Single plan store subscription across leaves/panels (PD-35)
    if (this.plugin.planStore && !this.unsubscribeStore) {
      this.unsubscribeStore = this.plugin.planStore.subscribe(() => {
        this.syncFromStore();
        this.paint();
      });
    }

    this.paint();
  }

  destroy(): void {
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = null;
    }
    this.clearProgressTimer();
    if (this.discardTimer) {
      window.clearTimeout(this.discardTimer);
      this.discardTimer = null;
    }
  }

  private syncFromStore(): void {
    if (this.plugin.planStore) {
      this.plan = this.plugin.planStore.plan;
      this.busy = this.plugin.planStore.isBusy;
      this.busyStep = this.plugin.planStore.label;
      this.busyStartTime = this.plugin.planStore.startTime;
    } else {
      this.plan = validatePlan(this.plugin.settings.currentPlan);
    }
    this.syncProgressTimer();
  }

  private syncProgressTimer(): void {
    if (this.busy) {
      if (!this.progressTimer) {
        const timer = window.setInterval(() => {
          this.updateProgressElapsed();
        }, 1000);
        const unrefable = timer as unknown as UnrefableTimer;
        unrefable.unref?.();
        this.progressTimer = timer;
      }
    } else {
      this.clearProgressTimer();
    }
  }

  private clearProgressTimer(): void {
    if (this.progressTimer) {
      window.clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  private getElapsedTime(): number {
    if (!this.busyStartTime) return 0;
    return Math.max(0, Math.floor((Date.now() - this.busyStartTime) / 1000));
  }

  private updateProgressElapsed(): void {
    if (!this.bodyEl) return;
    const metaEl = this.bodyEl.querySelector<HTMLElement>(".dj-plan-progress-meta");
    if (metaEl) {
      metaEl.setText(`${this.getElapsedTime()}s elapsed`);
    }
  }

  private paint(): void {
    if (!this.bodyEl) return;
    this.bodyEl.empty();

    // Render in-panel progress card when busy (PD-16, DM-26)
    if (this.busy) {
      this.paintProgressCard();
    }

    if (!this.plan) {
      this.paintEmpty();
      return;
    }
    this.paintPlan(this.plan);
  }

  private paintProgressCard(): void {
    if (!this.bodyEl) return;
    const card = this.bodyEl.createDiv({ cls: "dj-plan-progress-card" });
    card.createDiv({ cls: "dj-plan-progress-spinner" });

    const content = card.createDiv({ cls: "dj-plan-progress-content" });
    content.createDiv({
      cls: "dj-plan-progress-label",
      text: this.busyStep || "Working…",
    });
    content.createDiv({
      cls: "dj-plan-progress-meta",
      text: `${this.getElapsedTime()}s elapsed`,
    });

    const cancelBtn = createIconButton(
      card,
      "x",
      "Cancel",
      "dj-btn dj-btn-sm dj-plan-progress-cancel"
    );
    cancelBtn.addEventListener("click", () => {
      this.cancelBusy();
    });
  }

  private cancelBusy(): void {
    this.setBusy(false);
    if (this.plugin.planStore) {
      this.plugin.planStore.cancel();
    }
    if (this.client.isTurnActive) {
      this.client.interrupt();
    }
    new Notice("Plan operation cancelled.");
    this.paint();
  }

  private paintEmpty(): void {
    const empty = this.bodyEl!.createDiv({ cls: "dj-plan-empty" });
    const heroWrap = empty.createDiv({ cls: "dj-empty-hero" });
    heroWrap.appendChild(createPlanEmptyState());
    heroWrap.createEl("h3", { cls: "dj-empty-title", text: "Architectural planning" });
    heroWrap.createEl("p", {
      cls: "dj-empty-subtitle",
      text:
        "Decompose goals into phased tasks, review before anything executes, " +
        "and export directly to interactive Obsidian Canvases.",
    });

    // Retain draftText across panel switches (PD-16)
    const input = empty.createEl("textarea", {
      cls: "dj-input dj-plan-input",
      attr: {
        rows: "3",
        placeholder: "E.g. Reorganise the project notes and write acceptance tests…",
      },
    });
    input.value = this.draftText;
    input.disabled = this.busy;
    input.addEventListener("input", () => {
      this.draftText = input.value;
    });

    const row = empty.createDiv({ cls: "dj-plan-actions dj-plan-actions-center" });

    const planBtn = createIconButton(
      row,
      "file-plus",
      "Draft plan",
      "dj-btn dj-btn-accent",
      this.busy
    );
    planBtn.addEventListener("click", () => {
      const intent = input.value.trim();
      if (!intent) {
        new Notice("Describe the work first.");
        return;
      }
      void this.draftPlan(intent);
    });

    const loadBtn = createIconButton(
      row,
      "folder-open",
      "Open artifact",
      "dj-btn",
      this.busy
    );
    loadBtn.addEventListener("click", () => {
      void (async () => {
        const loaded = await loadFromArtifact(this.sessions);
        if (loaded) {
          await this.setStoredPlan(loaded);
        }
      })();
    });
  }

  private paintPlan(plan: DarjeelingPlan): void {
    const mode = this.client.getEffectiveRuntimeMode?.() ?? this.plugin.settings.runtimeMode;
    const head = this.bodyEl!.createDiv({ cls: "dj-plan-head" });
    const titleWrap = head.createDiv({ cls: "dj-plan-title-wrap" });
    titleWrap.createDiv({ cls: "dj-plan-title", text: plan.title });
    const done = plan.phases.filter((p) => p.status === "done").length;
    titleWrap.createDiv({
      cls: "dj-plan-meta",
      text:
        `${done}/${plan.phases.length} phases · ${plan.model ?? "model?"}` +
        `${plan.effort ? ` · ${plan.effort}` : ""}`,
    });

    if (plan.intent) {
      const intent = this.bodyEl!.createDiv({ cls: "dj-msg is-system" });
      intent.createDiv({ cls: "dj-msg-body", text: plan.intent });
    }

    plan.phases.forEach((phase, index) => this.paintPhase(plan, phase, index));

    if (plan.findings.length) this.paintFindings(plan.findings);

    const actions = this.bodyEl!.createDiv({ cls: "dj-plan-actions" });

    const canvasBtn = createIconButton(
      actions,
      "layout-grid",
      "View in Canvas",
      "dj-btn dj-btn-accent",
      this.busy
    );
    canvasBtn.title = "Export visual 2d interactive canvas into your vault";
    canvasBtn.addEventListener("click", () => void exportToCanvas(this.plugin, plan));

    const insertNoteBtn = createIconButton(
      actions,
      "file-text",
      "Insert into Note",
      "dj-btn",
      this.busy
    );
    insertNoteBtn.title = "Insert plan tasks with dataview metadata into active note";
    insertNoteBtn.addEventListener("click", () =>
      void insertPlanIntoActiveNote(this.plugin, plan)
    );

    const hasExecutedPhase = plan.phases.some((p) => p.status === "done" || Boolean(p.executedAt));
    const canVerify =
      !this.busy &&
      mode !== "direct-api" &&
      !this.client.isTurnActive &&
      hasExecutedPhase;

    const verifyBtn = createIconButton(
      actions,
      "check-square",
      "Verify against plan",
      "dj-btn",
      !canVerify
    );
    verifyBtn.title =
      mode === "direct-api"
        ? "Verification requires file access, which is not available in Direct API mode"
        : !hasExecutedPhase
        ? "Execute or mark at least one phase first"
        : this.client.isTurnActive
        ? "A turn is currently active"
        : "Compare the work to the plan";
    verifyBtn.addEventListener("click", () => void this.verify());

    const saveBtn = createIconButton(
      actions,
      "save",
      "Save artifact",
      "dj-btn",
      this.busy
    );
    saveBtn.addEventListener("click", () => void saveArtifact(this.plugin, this.sessions, plan, true));

    const replanBtn = createIconButton(
      actions,
      "refresh-cw",
      "Re-plan",
      "dj-btn",
      this.busy || this.client.isTurnActive
    );
    replanBtn.addEventListener("click", () => {
      void this.draftPlan(plan.intent || plan.title, plan);
    });

    const discardBtn = createIconButton(
      actions,
      "trash-2",
      this.confirmingDiscard ? "Confirm discard" : "Discard",
      this.confirmingDiscard ? "dj-btn dj-btn-danger is-confirming" : "dj-btn dj-btn-danger",
      this.busy
    );
    discardBtn.addEventListener("click", () => {
      this.handleDiscard(discardBtn, plan);
    });
  }

  private handleDiscard(btn: HTMLButtonElement, plan: DarjeelingPlan): void {
    if (!this.confirmingDiscard) {
      this.confirmingDiscard = true;
      btn.addClass("is-confirming");
      const labelEl = btn.querySelector<HTMLElement>(".dj-btn-label");
      if (labelEl) labelEl.setText("Confirm discard");
      btn.setAttribute("aria-label", "Confirm discard");

      const timer = window.setTimeout(() => {
        this.confirmingDiscard = false;
        btn.removeClass("is-confirming");
        if (labelEl) labelEl.setText("Discard");
        btn.setAttribute("aria-label", "Discard");
        this.discardTimer = null;
      }, 4000);
      const unrefable = timer as unknown as UnrefableTimer;
      unrefable.unref?.();
      this.discardTimer = timer;
      return;
    }

    if (this.discardTimer) {
      window.clearTimeout(this.discardTimer);
      this.discardTimer = null;
    }
    this.confirmingDiscard = false;

    const previousPlan = plan;
    void this.setStoredPlan(null).then(() => {
      const notice = new Notice("Plan discarded. Tap to undo.", 6000);
      const noticeEl = (notice as unknown as { noticeEl?: HTMLElement }).noticeEl;
      noticeEl?.addEventListener?.("click", () => {
        void this.setStoredPlan(previousPlan);
        new Notice("Plan restored.");
      });
    });
  }

  private paintPhase(plan: DarjeelingPlan, phase: PlanPhase, index: number): void {
    const mode = this.client.getEffectiveRuntimeMode?.() ?? this.plugin.settings.runtimeMode;
    const card = this.bodyEl!.createDiv({ cls: `dj-phase is-${phase.status}` });

    // PD-37: Phase header is an accessible button with aria-expanded
    let open = phase.status === "active";
    const head = card.createEl("button", {
      cls: "dj-phase-head",
      attr: {
        type: "button",
        "aria-expanded": String(open),
        "aria-label": `Phase ${index + 1}: ${phase.name}`,
      },
    });

    const statusIcon = head.createSpan({ cls: "dj-phase-status-icon" });
    const iconName =
      phase.status === "done"
        ? "check-circle"
        : phase.status === "active"
        ? "play"
        : "circle";
    setIcon(statusIcon, iconName);
    head.createSpan({ cls: "dj-phase-num", text: String(index + 1) });
    head.createSpan({ cls: "dj-phase-name", text: phase.name });
    const doneCount = phase.tasks.filter((t) => t.done).length;
    head.createSpan({
      cls: "dj-phase-count",
      text: `${doneCount}/${phase.tasks.length}`,
    });

    const body = card.createDiv({ cls: "dj-phase-body" });
    body.hidden = !open;
    head.addEventListener("click", () => {
      open = !open;
      body.hidden = !open;
      head.setAttribute("aria-expanded", String(open));
    });

    if (phase.intent) {
      body.createDiv({
        cls: "dj-plan-meta dj-phase-intent",
        text: phase.intent,
      });
    }

    for (const task of phase.tasks) {
      const row = body.createDiv({ cls: `dj-task${task.done ? " is-done" : ""}` });
      const box = row.createEl("input", { type: "checkbox" });
      box.checked = task.done;
      box.disabled = this.busy;
      box.addEventListener("change", () => {
        task.done = box.checked;
        row.toggleClass("is-done", task.done);
        head.querySelector<HTMLElement>(".dj-phase-count")?.setText(
          `${phase.tasks.filter((t) => t.done).length}/${phase.tasks.length}`
        );
        plan.updatedAt = new Date().toISOString();
        void this.persistPlan();
      });
      const text = row.createDiv({ cls: "dj-task-text" });
      text.createSpan({ text: task.text });
      if (task.files.length) {
        text.createDiv({ cls: "dj-task-file", text: task.files.join("  ·  ") });
      }
    }

    const phaseActions = body.createDiv({ cls: "dj-plan-actions" });

    // PD-07: Direct API providers draft only and get 'Copy phase brief'
    if (mode === "direct-api") {
      const copyBriefBtn = createIconButton(
        phaseActions,
        "clipboard",
        "Copy phase brief",
        "dj-btn dj-btn-accent",
        this.busy
      );
      copyBriefBtn.title = "Direct API cannot execute phases. Copy the prompt brief to clipboard.";
      copyBriefBtn.addEventListener("click", () => {
        void (async () => {
          const brief = phaseBrief(plan, phase, index);
          try {
            if (navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(brief);
            }
            new Notice("Phase brief copied to clipboard.");
          } catch {
            new Notice("Failed to copy phase brief to clipboard.");
          }
        })();
      });
    } else {
      const runBtn = createIconButton(
        phaseActions,
        "play",
        phase.status === "done" ? "Run again" : "Hand off to agent",
        "dj-btn dj-btn-accent",
        this.busy || this.client.isTurnActive
      );
      runBtn.addEventListener("click", () => {
        void (async () => {
          const ok = await handOffPhase(this.plugin, this.client, plan, phase, index);
          if (ok) {
            await this.persistPlan();
            this.paint();
          }
        })();
      });
    }

    const copyBtn = createIconButton(
      phaseActions,
      "message-square",
      "To composer",
      "dj-btn",
      this.busy
    );
    copyBtn.title = "Put this phase's brief in the chat composer instead of running it";
    copyBtn.addEventListener("click", () => {
      this.plugin.prefillChat(phaseBrief(plan, phase, index));
      this.plugin.setMode("chat");
    });

    const toggleBtn = createIconButton(
      phaseActions,
      phase.status === "done" ? "rotate-ccw" : "check",
      phase.status === "done" ? "Mark pending" : "Mark done",
      "dj-btn",
      this.busy
    );
    toggleBtn.addEventListener("click", () => {
      phase.status = phase.status === "done" ? "pending" : "done";
      if (phase.status === "done") {
        for (const task of phase.tasks) task.done = true;
      }
      advanceActivePhase(plan);
      plan.updatedAt = new Date().toISOString();
      void this.persistPlan();
      this.paint();
    });
  }

  private paintFindings(findings: Finding[]): void {
    const heading = this.bodyEl!.createDiv({ cls: "dj-plan-head" });
    heading.createDiv({
      cls: "dj-plan-title",
      text: `Verification — ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
    });

    for (const severity of SEVERITY_ORDER) {
      for (const finding of findings.filter((f) => f.severity === severity)) {
        const card = this.bodyEl!.createDiv({ cls: `dj-finding sev-${severity}` });
        const head = card.createDiv({ cls: "dj-finding-head" });
        head.createSpan({ cls: "dj-sev", text: severity });
        head.createSpan({ text: finding.title });
        if (finding.where) {
          head.createSpan({ cls: "dj-finding-where", text: finding.where });
        }
        if (finding.detail) {
          card.createDiv({ cls: "dj-finding-body", text: finding.detail });
        }
      }
    }
  }

  private async draftPlan(intent: string, previous?: DarjeelingPlan): Promise<void> {
    this.setBusy(true, previous ? "Re-planning…" : "Drafting plan…");
    try {
      const contextPrompt = await this.vaultContext();

      const plan = await draftPlan(
        this.plugin,
        this.client,
        intent,
        contextPrompt,
        previous,
        (turnId) => {
          if (this.plan) {
            this.plan.activeTurnId = turnId;
            void this.persistPlan();
          }
        }
      );
      if (!plan) return;

      await this.setStoredPlan(plan);

      if (this.plugin.settings.autoPullArtifacts) {
        await saveArtifact(this.plugin, this.sessions, plan, false);
      }
      new Notice(`Plan drafted: ${plan.phases.length} phases. Review before running.`);
    } finally {
      this.setBusy(false);
    }
  }

  private async verify(): Promise<void> {
    const plan = this.plan;
    if (!plan) return;
    this.setBusy(true, "Verifying…");

    try {
      const findings = await verifyPlan(
        this.plugin,
        this.client,
        plan,
        (turnId) => {
          plan.activeTurnId = turnId;
          void this.persistPlan();
        }
      );
      if (!findings) return;

      plan.findings = findings;
      plan.updatedAt = new Date().toISOString();
      await this.persistPlan();
      this.paint();

      if (this.plugin.settings.autoPullArtifacts) {
        await saveArtifact(this.plugin, this.sessions, plan, false);
      }

      const critical = plan.findings.filter((f) => f.severity === "critical").length;
      new Notice(
        plan.findings.length === 0
          ? "Verification clean — implementation matches the plan."
          : `${plan.findings.length} finding(s)${critical ? `, ${critical} critical` : ""}.`
      );
    } finally {
      this.setBusy(false);
    }
  }

  private async vaultContext(): Promise<string> {
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file || !this.plugin.settings.attachActiveNote) return "";
    const pushed = await this.sessions.pushFile(file, this.plugin.app.vault);
    return pushed
      ? `\nThe note \`${file.path}\` is the starting context. Read it before planning.`
      : "";
  }

  private setBusy(busy: boolean, label?: string): void {
    this.busy = busy;
    this.busyStep = label ?? (busy ? "Working…" : "");
    this.busyStartTime = busy ? Date.now() : null;

    if (this.plugin.planStore) {
      this.plugin.planStore.setBusy(busy, this.busyStep);
    }
    this.plugin.setBusy(busy, label);
    this.syncProgressTimer();
    this.paint();
  }

  private async setStoredPlan(plan: DarjeelingPlan | null): Promise<void> {
    this.plan = plan;
    if (this.plugin.planStore) {
      await this.plugin.planStore.setPlan(plan);
    } else {
      this.plugin.settings.currentPlan = plan ?? undefined;
      await this.plugin.saveSettings();
    }
    this.paint();
  }

  private async persistPlan(): Promise<void> {
    if (this.plugin.planStore) {
      await this.plugin.planStore.setPlan(this.plan);
    } else {
      this.plugin.settings.currentPlan = this.plan ?? undefined;
      await this.plugin.saveSettings();
    }
  }

  async exportToCanvas(): Promise<void> {
    if (!this.plan) {
      new Notice("No plan to export.");
      return;
    }
    await exportToCanvas(this.plugin, this.plan);
  }

  async insertPlanIntoActiveNote(): Promise<void> {
    if (!this.plan) {
      new Notice("No plan to insert.");
      return;
    }
    await insertPlanIntoActiveNote(this.plugin, this.plan);
  }

  refresh(): void {
    this.syncFromStore();
    this.paint();
  }
}

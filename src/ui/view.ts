import {
  ItemView,
  Menu,
  Notice,
  Platform,
  WorkspaceLeaf,
  setIcon,
  setTooltip,
} from "obsidian";
import type DarjeelingPlugin from "../main";
import {
  SessionManager,
} from "../net/sessionManager";
import { AgentClient, ConnectionState } from "../net/agentClient";
import { DarjeelingChat } from "./chat/chatView";
import { DarjeelingPlanPanel } from "./plan/planView";
import { DarjeelingHostPanel } from "./host/hostView";
import { TerminalPane } from "./terminal/terminalPane";
import { ConversationsSheetModal } from "./conversations";
import { DarjeelingOnboardingView, type OnboardingStep } from "./onboarding/onboardingView";
import { ConfirmModal } from "./modals/confirm";
import { updateRuntimeChip, showRuntimeMenu } from "./header/runtimeChip";
import { updateModelChip, showModelMenu } from "./header/modelChip";
import { DarjeelingQuickSettingsModal } from "../settings/quickSettings";
import { DarjeelingNewSessionModal, SessionTarget } from "./modals/newSessionModal";
import { DARJEELING_ICON } from "./icons";
import { writeClipboard } from "./terminal/clipboard";
import { ViewMode } from "../settings/schema";
import { hasProviderApiKey } from "../settings/secrets";
import {
  getModelForHarness,
  sanitizeModelForHarness,
  setModelForHarness,
} from "../models/registry";
import { setDeviceRuntime } from "../runtime/router";

export const DARJEELING_VIEW_TYPE = "darjeeling-view";

export class DarjeelingView extends ItemView {
  plugin: DarjeelingPlugin;
  sessions: SessionManager;
  agent: AgentClient;

  private mode: ViewMode = "chat";

  public chat: DarjeelingChat | null = null;
  public plan: DarjeelingPlanPanel | null = null;
  public host: DarjeelingHostPanel | null = null;
  public terminalPane: TerminalPane | null = null;

  // Header handles
  private tabs = new Map<ViewMode, HTMLButtonElement>();
  private panes = new Map<ViewMode, HTMLElement>();
  private statusEl: HTMLElement | null = null;
  private statusTextEl: HTMLElement | null = null;
  private runtimeChipEl: HTMLElement | null = null;
  private modelChipEl: HTMLElement | null = null;
  private tabShownListeners: Array<(tab: ViewMode) => void> = [];

  public onTabShown(cb: (tab: ViewMode) => void): () => void {
    this.tabShownListeners.push(cb);
    return () => {
      this.tabShownListeners = this.tabShownListeners.filter((l) => l !== cb);
    };
  }

  private notifyTabShown(tab: ViewMode): void {
    for (const listener of this.tabShownListeners) {
      try {
        listener(tab);
      } catch (err) {
        console.error("[Darjeeling] Error in onTabShown listener:", err);
      }
    }
  }

  constructor(leaf: WorkspaceLeaf, plugin: DarjeelingPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.sessions = plugin.sessionManager;
    this.agent = plugin.agentClient;
    this.mode = plugin.settings.defaultMode;
  }

  getViewType(): string {
    return DARJEELING_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Darjeeling";
  }

  getIcon(): string {
    return DARJEELING_ICON;
  }

  async onOpen(): Promise<void> {
    this.addAction("plus", "New conversation", () => {
      this.startNewSessionWithHostPrompt();
    });
    this.addAction("history", "Conversations", () => {
      this.showConversationsSheet();
    });

    if (!this.plugin.settings.onboardingDone) {
      this.renderOnboarding();
      return;
    }

    await this.initViewContent();
  }

  public renderOnboarding(step?: OnboardingStep, url?: string, code?: string): void {
    const root = (this.containerEl.children[1] as HTMLElement) || this.containerEl;
    root.empty();
    root.addClass("darjeeling-root", "dj-view-root");
    new DarjeelingOnboardingView(
      root,
      this.plugin,
      () => {
        void this.initViewContent();
      },
      step,
      url,
      code
    );
  }

  public async initViewContent(): Promise<void> {
    const root = (this.containerEl.children[1] as HTMLElement) || this.containerEl;
    root.empty();
    root.addClass("darjeeling-root", "dj-view-root");

    this.buildHeader(root);
    this.buildModelBar(root);

    const chatHost = root.createDiv({ cls: "dj-pane" });
    this.panes.set("chat", chatHost);
    this.chat = new DarjeelingChat(
      this.plugin,
      this.sessions,
      this.agent,
      chatHost,
      this
    );
    this.addChild(this.chat);
    this.plugin.registerChat(this.chat);

    const planHost = root.createDiv({ cls: "dj-pane" });
    this.panes.set("plan", planHost);
    this.plan = new DarjeelingPlanPanel(
      this.plugin,
      this.sessions,
      this.agent,
      planHost
    );
    this.plan.mount();
    this.plugin.registerPlan(this.plan);

    const hostPane = root.createDiv({ cls: "dj-pane" });
    this.panes.set("host", hostPane);
    this.host = new DarjeelingHostPanel(this.plugin, this.sessions, hostPane);
    this.host.mount();

    const termPane = root.createDiv({ cls: "dj-pane" });
    this.panes.set("terminal", termPane);
    this.terminalPane = new TerminalPane(this.plugin, this.sessions, termPane);
    this.terminalPane.mount();

    this.plugin.attachView(this);

    this.setMode(this.mode);
    this.agent.connect();
    this.setConnectionState(this.agent.connectionState);
    void this.refreshAgents();
    void this.refreshSessions();
  }

  private buildHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: "dj-header" });
    const row = header.createDiv({ cls: "dj-header-row" });

    const mark = row.createDiv({ cls: "dj-mark" });
    const markIcon = mark.createDiv({ cls: "dj-mark-icon" });
    setIcon(markIcon, DARJEELING_ICON);
    const markText = mark.createDiv({ cls: "dj-mark-text" });
    markText.createSpan({ cls: "dj-mark-label", text: "Darjeeling" });
    markText.createSpan({ cls: "dj-mark-sub", text: "Estate AI" });

    const tabsEl = row.createDiv({
      cls: "dj-tabs",
      attr: { role: "tablist", "aria-label": "Darjeeling views" },
    });
    const makeTab = (mode: ViewMode, label: string, iconName: string) => {
      const btn = tabsEl.createEl("button", {
        cls: "dj-tab",
        attr: {
          type: "button",
          role: "tab",
          "aria-selected": "false",
          "data-mode": mode,
        },
      });
      const iconEl = btn.createSpan({ cls: "dj-tab-icon" });
      setIcon(iconEl, iconName);
      btn.createSpan({ cls: "dj-tab-label", text: label });
      setTooltip(btn, label);

      btn.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        this.setMode(mode);
      });
      this.tabs.set(mode, btn);
    };
    makeTab("chat", "Chat", "message-square");
    makeTab("plan", "Plan", "list-ordered");
    makeTab("terminal", "Terminal", "terminal");
    makeTab("host", "Host", "server");

    row.createDiv({ cls: "dj-spacer" });

    const actions = row.createDiv({ cls: "dj-header-actions" });

    const newSessionBtn = actions.createEl("button", {
      cls: "dj-header-btn dj-new-session-btn",
      attr: { type: "button", "aria-label": "New conversation" },
    });
    setIcon(newSessionBtn, "plus");
    setTooltip(newSessionBtn, "New conversation");
    newSessionBtn.addEventListener("click", () => {
      this.startNewSessionWithHostPrompt();
    });

    const sessionBtn = actions.createEl("button", {
      cls: "dj-header-btn dj-history-btn",
      attr: { type: "button", "aria-label": "Conversations" },
    });
    setIcon(sessionBtn, "history");
    setTooltip(sessionBtn, "Conversations");
    sessionBtn.addEventListener("click", () => this.showConversationsSheet());

    const settingsBtn = actions.createEl("button", {
      cls: "dj-header-btn dj-settings-btn",
      attr: { type: "button", "aria-label": "Darjeeling settings" },
    });
    setIcon(settingsBtn, "sliders-horizontal");
    setTooltip(settingsBtn, "Darjeeling settings");
    settingsBtn.addEventListener("click", () => {
      new DarjeelingQuickSettingsModal(this.app, this.plugin).open();
    });

    const isMainLeaf = this.leaf.getRoot() === this.app.workspace.rootSplit;
    const relocateBtn = actions.createEl("button", {
      cls: "dj-header-btn dj-relocate-btn",
      attr: {
        type: "button",
        "aria-label": isMainLeaf
          ? "Move to right sidebar"
          : "Open in middle panel (tab)",
      },
    });
    setIcon(relocateBtn, isMainLeaf ? "panel-right" : "maximize-2");
    setTooltip(
      relocateBtn,
      isMainLeaf ? "Move to right sidebar" : "Open in middle panel (tab)"
    );
    relocateBtn.addEventListener("click", () => {
      void (async () => {
        if (
          this.agent.isBusy() ||
          this.agent.getEffectiveRuntimeMode() === "local"
        ) {
          const modal = new ConfirmModal(this.app, {
            title: "Relocate Darjeeling view?",
            message:
              "An agent turn or local session may be active. Relocating this view will detach the leaf and could terminate active processes. Do you want to continue?",
            confirmLabel: "Relocate view",
            cancelLabel: "Cancel",
            destructive: true,
          });
          const ok = await modal.promptConfirm();
          if (!ok) return;
        }
        if (isMainLeaf) {
          await this.plugin.openInRightSidebar(this.mode);
        } else {
          await this.plugin.openInMainPanel(this.mode);
        }
      })();
    });
  }

  private buildModelBar(root: HTMLElement): void {
    const header = root.querySelector<HTMLElement>(".dj-header")!;
    const subbar = header.createDiv({ cls: "dj-subbar" });

    // 1. Runtime Chip
    this.runtimeChipEl = subbar.createDiv({ cls: "dj-chip-pill dj-runtime-chip" });
    this.runtimeChipEl.title = "Select host / runtime";
    this.runtimeChipEl.addEventListener("click", (evt) =>
      showRuntimeMenu(this, evt, this.runtimeChipEl)
    );

    // 2. Model & Strategy Chip
    this.modelChipEl = subbar.createDiv({ cls: "dj-chip-pill dj-model-chip" });
    this.modelChipEl.title = "Select model, reasoning effort, and permission mode";
    this.modelChipEl.addEventListener("click", (evt) =>
      showModelMenu(this, evt, this.modelChipEl)
    );

    subbar.createDiv({ cls: "dj-spacer" });

    // 3. Status Chip (DM-08, DM-09, VTH-28)
    this.statusEl = subbar.createDiv({
      cls: "dj-status-chip is-disconnected",
      attr: { role: "status", "aria-live": "polite" },
    });
    this.statusEl.createSpan({ cls: "dj-status-dot" });
    this.statusTextEl = this.statusEl.createSpan({ text: "Checking..." });
    setTooltip(this.statusEl, "Host connection status — click to view host details");
    this.statusEl.addEventListener("click", () => {
      this.setMode("host");
    });

    this.updateRuntimeChip();
    this.updateModelChip();
    this.setConnectionState(this.agent.connectionState);
  }

  updateRuntimeChip(): void {
    if (this.runtimeChipEl) {
      updateRuntimeChip(this, this.runtimeChipEl);
    }
  }

  updateModelChip(): void {
    if (this.modelChipEl) {
      updateModelChip(this, this.modelChipEl);
    }
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    for (const [key, btn] of this.tabs) {
      const isActive = key === mode;
      btn.toggleClass("is-active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
      btn.tabIndex = isActive ? 0 : -1;
    }
    for (const [key, pane] of this.panes) pane.hidden = key !== mode;

    this.host?.setVisible(mode === "host");

    if (mode === "terminal") {
      this.terminalPane?.activate();
    } else if (mode === "plan") {
      this.plan?.refresh();
    }

    this.notifyTabShown(mode);
  }

  async applyHostSelection(target: SessionTarget): Promise<void> {
    setDeviceRuntime(this.app, this.plugin.settings, target.mode);
    if (target.agent) this.plugin.settings.agent = target.agent;
    if (target.provider) this.plugin.settings.directApiProvider = target.provider;
    if (target.meshnetHost) this.plugin.settings.meshnetHost = target.meshnetHost;
    if (target.port) this.plugin.settings.port = target.port;

    const harness =
      target.mode === "direct-api"
        ? target.provider || this.plugin.settings.directApiProvider || "deepseek"
        : target.agent || this.plugin.settings.agent || "agy";

    const candidateModel =
      target.model !== undefined
        ? target.model
        : getModelForHarness(this.plugin.settings, harness);
    const validModel = sanitizeModelForHarness(harness, candidateModel);

    this.plugin.settings.model = validModel;
    setModelForHarness(this.plugin.settings, harness, validModel);

    if (harness === "deepseek" || harness === "openai-compatible") {
      this.plugin.settings.openaiModel = validModel;
      if (harness === "deepseek" && !this.plugin.settings.openaiBaseUrl) {
        this.plugin.settings.openaiBaseUrl = "https://api.deepseek.com";
      }
    }

    await this.plugin.saveSettings();
    this.agent.updateSettings(this.plugin.settings);
    this.sessions.updateSettings(this.plugin.settings);

    if (target.mode === "remote") {
      this.agent.connect();
    }

    this.populateHostOptions();
    await this.refreshAgents();
    this.paintModelOptions();
    this.updateRuntimeChip();
    this.updateModelChip();
    this.setConnectionState(this.agent.connectionState);

    const desc =
      target.mode === "local"
        ? `Local Machine (${this.plugin.settings.agent} · ${validModel})`
        : target.mode === "remote"
        ? `Remote Host (${this.plugin.settings.meshnetHost || "server"})`
        : `Direct API (${this.plugin.settings.directApiProvider} · ${validModel})`;
    new Notice(`Host set to: ${desc}`);
  }

  populateHostOptions(): void {
    this.updateRuntimeChip();
  }

  startNewSessionWithHostPrompt(): void {
    if (this.plugin.settings.askHostOnNewSession) {
      new DarjeelingNewSessionModal(this.app, this.plugin, (target) => {
        void (async () => {
          this.setMode("chat");
          this.chat?.showSessionStarting(target);
          try {
            await this.applyHostSelection(target);
          } catch (err) {
            console.error("[Darjeeling] Error applying host selection:", err);
          } finally {
            if (
              target.mode === "remote" &&
              this.agent.connectionState !== "open" &&
              this.agent.connectionState !== "connecting"
            ) {
              this.chat?.showRemoteOfflineCard("New Session");
            } else {
              this.chat?.newConversation();
            }
            this.chat?.focus();
          }
        })();
      }).open();
    } else {
      this.setMode("chat");
      this.chat?.newConversation();
      this.chat?.focus();
    }
  }

  async refreshAgents(): Promise<void> {
    await this.plugin.refreshAgents();
    this.paintAgentOptions();
    this.paintModelOptions();
  }

  private paintAgentOptions(): void {
    this.updateRuntimeChip();
  }

  paintModelOptions(): void {
    this.updateModelChip();
  }

  setConnectionState(state: ConnectionState): void {
    if (!this.statusEl || !this.statusTextEl) return;
    const mode = this.agent.getEffectiveRuntimeMode();

    let cls = "is-disconnected";
    let label = "Unreachable";

    if (mode === "local") {
      if (Platform.isDesktopApp) {
        const hasCli = this.plugin.availableAgents.some(
          (a) => a.key === this.plugin.settings.agent && a.available
        );
        if (hasCli) {
          cls = "is-connected";
          label = "Ready";
        } else {
          cls = "is-disconnected";
          label = "Needs setup";
        }
      } else {
        cls = "is-disconnected";
        label = "Needs setup";
      }
    } else if (mode === "direct-api") {
      const provider = this.plugin.settings.directApiProvider;
      const hasKey =
        provider === "ollama" ||
        hasProviderApiKey(this.plugin.secretStorage, this.plugin.settings, provider);
      if (hasKey) {
        cls = "is-connected";
        label = "Ready";
      } else {
        cls = "is-disconnected";
        label = "Needs setup";
      }
    } else {
      if (state === "open") {
        cls = "is-connected";
        label = "Ready";
      } else if (state === "connecting") {
        cls = "is-connecting";
        label = "Connecting";
      } else if (state === "unauthorized") {
        cls = "is-disconnected";
        label = "Needs setup";
      } else {
        cls = "is-disconnected";
        label = "Unreachable";
      }
    }

    this.statusEl.className = `dj-status-chip ${cls}`;
    this.statusTextEl.setText(label);
    this.updateRuntimeChip();
    this.updateModelChip();
  }

  setBusy(_busy: boolean, _label?: string): void {
    if (!this.statusEl || !this.statusTextEl) return;
    this.setConnectionState(this.agent.connectionState);
  }

  setDetail(_text: string): void {
    /* detailEl removed */
  }

  async refreshSessions(): Promise<void> {
    await this.terminalPane?.refreshSessions();
  }

  showSessionMenu(event: MouseEvent): void {
    const settings = this.plugin.settings;
    const menu = new Menu();

    const current = this.agent.resumeId ?? settings.lastAgentSessionId;
    if (current) {
      menu.addItem((item) =>
        item.setTitle(`Current: ${current.slice(0, 8)}`).setDisabled(true)
      );
      menu.addItem((item) =>
        item
          .setTitle("Copy session id")
          .setIcon("copy")
          .onClick(() =>
            void writeClipboard(current).then((ok) =>
              new Notice(ok ? "Session id copied" : "Copy failed")
            )
          )
      );
      menu.addItem((item) =>
        item
          .setTitle("Copy terminal attach command")
          .setIcon("terminal-square")
          .onClick(() =>
            void writeClipboard(`claude --resume ${current}`).then((ok) =>
              new Notice(
                ok
                  ? "Copied — paste into the Terminal tab to attach interactively"
                  : "Copy failed"
              )
            )
          )
      );
      menu.addSeparator();
    }

    menu.addItem((item) =>
      item
        .setTitle("Resume a conversation…")
        .setIcon("history")
        .onClick(() => void this.pickConversation())
    );

    if (settings.previousAgentSessionId) {
      const prev = settings.previousAgentSessionId;
      menu.addItem((item) =>
        item
          .setTitle(`Reopen previous (${prev.slice(0, 8)})`)
          .setIcon("corner-up-left")
          .onClick(() => void this.resumeConversation(prev))
      );
    }

    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("New conversation (select host)…")
        .setIcon("plus")
        .onClick(() => {
          this.startNewSessionWithHostPrompt();
        })
    );

    if (event && (event.clientX || event.clientY)) {
      menu.showAtMouseEvent(event);
    } else {
      const target = (event?.currentTarget || event?.target) as HTMLElement | null;
      const rect = target?.getBoundingClientRect?.();
      if (rect) {
        menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
      } else {
        menu.showAtMouseEvent(event);
      }
    }
  }

  public showConversationsSheet(): void {
    void (async () => {
      const runningTurns = await this.sessions.listRunningTurns().catch(() => []);
      const runningIds = new Set(runningTurns.map((t) => t.session_id));
      new ConversationsSheetModal(
        this.app,
        this.plugin,
        (summary) => {
          void this.resumeConversation(summary.sessionId);
        },
        runningIds
      ).open();
    })();
  }

  private async pickConversation(): Promise<void> {
    this.showConversationsSheet();
  }

  private async resumeConversation(sessionId: string): Promise<void> {
    const messages = await this.sessions.readConversation(
      sessionId,
      this.plugin.settings.remoteCwd || undefined
    );

    this.agent.adoptSession(sessionId);
    this.plugin.settings.lastAgentSessionId = sessionId;
    await this.plugin.saveSettings();

    this.setMode("chat");
    await this.chat?.rehydrate(sessionId, messages);
    new Notice(`Resumed ${sessionId.slice(0, 8)} — ${messages.length} message(s)`);
  }

  refreshTerminalSettings(): void {
    this.terminalPane?.refreshSettings();
  }

  prefillChat(text: string): void {
    this.chat?.prefill(text);
  }

  noteInChat(markdown: string): void {
    this.chat?.systemNotice(markdown);
  }

  async onClose(): Promise<void> {
    this.plan?.destroy();
    this.plan = null;
    this.host?.destroy();
    this.host = null;
    this.terminalPane?.destroy();
    this.terminalPane = null;
    this.plugin.detachView(this);
  }

  private shortModel(model: string | null): string {
    if (!model) return "unknown";
    return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  }
}

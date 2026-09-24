import assert from "node:assert/strict";
import test from "node:test";
import { DarjeelingPlanPanel } from "../../src/ui/plan/planView";
import { PlanStore } from "../../src/ui/plan/planStore";
import { notices, resetNotices, setIcon } from "./stubs/obsidian";
import type { DarjeelingPlan } from "../../src/ui/plan/planTypes";

function makeDomElement(tag = "div"): any {
  const el: any = {
    tagName: tag.toUpperCase(),
    children: [] as any[],
    classList: new Set<string>(),
    attributes: new Map<string, string>(),
    dataset: {} as Record<string, string>,
    _textContent: "",
    get textContent(): string {
      if (el._textContent) return el._textContent;
      let text = "";
      for (const child of el.children) {
        text += child.textContent;
      }
      return text;
    },
    set textContent(t: string) {
      el._textContent = t;
    },
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    offsetParent: {},
    isConnected: true,
    listeners: new Map<string, Array<(...args: any[]) => void>>(),
    setText(t: string) {
      el.textContent = t;
      return el;
    },
    getText() {
      return el.textContent;
    },
    empty() {
      el.children.length = 0;
      el.textContent = "";
    },
    appendChild(child: any) {
      el.children.push(child);
      return child;
    },
    removeChild(child: any) {
      const idx = el.children.indexOf(child);
      if (idx !== -1) el.children.splice(idx, 1);
      return child;
    },
    get firstChild() {
      return el.children[0] ?? null;
    },
    createDiv(opts?: any) {
      return el.createEl("div", opts);
    },
    createSpan(opts?: any) {
      return el.createEl("span", opts);
    },
    createEl(t: string, opts?: any) {
      const child = makeDomElement(t);
      if (opts?.cls) {
        for (const c of opts.cls.split(" ")) {
          if (c) child.classList.add(c);
        }
      }
      if (opts?.text) child.textContent = opts.text;
      if (opts?.attr) {
        for (const [k, v] of Object.entries(opts.attr)) {
          child.setAttribute(k, String(v));
        }
      }
      el.children.push(child);
      return child;
    },
    setAttribute(k: string, v: string) {
      el.attributes.set(k, v);
    },
    getAttribute(k: string) {
      return el.attributes.get(k) ?? null;
    },
    addClass(cls: string) {
      el.classList.add(cls);
    },
    removeClass(cls: string) {
      el.classList.delete(cls);
    },
    toggleClass(cls: string, val: boolean) {
      if (val) el.classList.add(cls);
      else el.classList.delete(cls);
    },
    hasClass(cls: string) {
      return el.classList.has(cls);
    },
    remove() {
      el.removed = true;
    },
    addEventListener(type: string, fn: (...args: any[]) => void) {
      if (!el.listeners.has(type)) {
        el.listeners.set(type, []);
      }
      el.listeners.get(type)!.push(fn);
    },
    click() {
      const fns = el.listeners.get("click") || [];
      for (const fn of fns) fn();
    },
    querySelector(selector: string) {
      const matches: any[] = [];
      findInEl(el, selector, matches);
      return matches[0] ?? null;
    },
    querySelectorAll(selector: string) {
      const matches: any[] = [];
      findInEl(el, selector, matches);
      return matches;
    },
  };
  return el;
}

function findInEl(parent: any, selector: string, matches: any[]): void {
  for (const child of parent.children) {
    if (matchesSelector(child, selector)) {
      matches.push(child);
    }
    findInEl(child, selector, matches);
  }
}

function matchesSelector(el: any, sel: string): boolean {
  if (sel.startsWith(".")) {
    const cls = sel.slice(1);
    return el.classList.has(cls);
  }
  if (sel === "button") return el.tagName === "BUTTON";
  if (sel === "textarea") return el.tagName === "TEXTAREA";
  if (sel === "input") return el.tagName === "INPUT";
  if (sel === "button.dj-phase-head") {
    return el.tagName === "BUTTON" && el.classList.has("dj-phase-head");
  }
  return false;
}

function makeSamplePlan(): DarjeelingPlan {
  return {
    id: "plan-s3",
    title: "Plan UI Modernization",
    intent: "Elevate planning view to native mobile quality",
    createdAt: "2026-09-23T12:00:00.000Z",
    updatedAt: "2026-09-23T12:00:00.000Z",
    model: "claude-3-7-sonnet",
    effort: "high",
    phases: [
      {
        id: "p1",
        name: "Phase 1 - Accessibility",
        intent: "Screen reader labels and keyboard headers",
        status: "active",
        tasks: [
          { id: "t1", text: "Separate icon and label spans", files: ["src/ui/plan/planView.ts"], done: false },
          { id: "t2", text: "Phase head button with aria-expanded", files: ["src/ui/plan/planView.ts"], done: true },
        ],
      },
      {
        id: "p2",
        name: "Phase 2 - Progress & Discard",
        intent: "In-panel progress card and 2-step discard",
        status: "pending",
        tasks: [
          { id: "t3", text: "Progress spinner with timer and Cancel", files: ["src/ui/plan/planView.ts"], done: false },
        ],
      },
    ],
    findings: [],
  };
}

function createMockEnvironment(initialPlan: DarjeelingPlan | null = null) {
  const settings: any = {
    runtimeMode: "local",
    permissionMode: "plan",
    agent: "claude",
    model: "claude-3-7-sonnet",
    currentPlan: initialPlan ?? undefined,
  };

  const plugin: any = {
    settings,
    saveSettings: async () => {},
    setMode: () => {},
    noteInChat: () => {},
    prefillChat: () => {},
    setBusy: () => {},
    app: {
      workspace: { getActiveFile: () => null },
      vault: {
        getAbstractFileByPath: () => null,
        getFileByPath: () => null,
      },
    },
  };

  plugin.planStore = new PlanStore(plugin);

  const sessions: any = {
    writeArtifact: async () => {},
  };

  const client: any = {
    getEffectiveRuntimeMode: () => "local",
    isTurnActive: false,
    interrupt: () => {},
  };

  return { plugin, sessions, client };
}

test("planView: every plan button has visible text after setIcon and aria-label (PD-04, DM-05)", () => {
  const { plugin, sessions, client } = createMockEnvironment(makeSamplePlan());
  const hostEl = makeDomElement("div");

  const panel = new DarjeelingPlanPanel(plugin, sessions, client, hostEl);
  panel.mount();

  const buttons = hostEl.querySelectorAll("button");
  assert.ok(buttons.length >= 6, `Expected at least 6 action buttons, found ${buttons.length}`);

  for (const btn of buttons) {
    const ariaLabel = btn.getAttribute("aria-label");
    assert.ok(ariaLabel && ariaLabel.trim().length > 0, `Button must have non-empty aria-label`);

    const labelSpan = btn.querySelector(".dj-btn-label");
    if (labelSpan) {
      assert.ok(
        labelSpan.textContent.trim().length > 0,
        `Button with label span must have non-empty text: ${ariaLabel}`
      );
      assert.ok(
        btn.textContent.includes(labelSpan.textContent),
        `Button must retain visible label text even after setIcon: ${ariaLabel}`
      );
    }
  }

  panel.destroy();
});

test("planView: Discard requires confirmation before deleting plan (PD-04, DM-05)", async () => {
  resetNotices();
  const samplePlan = makeSamplePlan();
  const { plugin, sessions, client } = createMockEnvironment(samplePlan);
  const hostEl = makeDomElement("div");

  const panel = new DarjeelingPlanPanel(plugin, sessions, client, hostEl);
  panel.mount();

  assert.notStrictEqual(plugin.planStore.plan, null, "Plan must initially exist");

  const discardBtn = hostEl.querySelectorAll("button").find(
    (b: any) => b.getAttribute("aria-label") === "Discard"
  );
  assert.ok(discardBtn, "Discard button must exist in plan actions");

  // First tap: Enters confirming state, does NOT discard yet
  discardBtn.click();
  assert.strictEqual(
    discardBtn.getAttribute("aria-label"),
    "Confirm discard",
    "Discard button aria-label should switch to 'Confirm discard'"
  );
  assert.ok(discardBtn.hasClass("is-confirming"), "Button should receive is-confirming class");
  assert.notStrictEqual(plugin.planStore.plan, null, "Plan must NOT be discarded on first click");

  // Second tap: Confirms discard
  discardBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(plugin.planStore.plan, null, "Plan should be null after second click (confirm)");
  assert.ok(
    notices.some((m) => m.includes("Plan discarded")),
    "Notice should inform user of plan discard"
  );

  panel.destroy();
});

test("planView: draft text is preserved across panel repaints/tab switches (PD-16)", () => {
  const { plugin, sessions, client } = createMockEnvironment(null); // empty state
  const hostEl = makeDomElement("div");

  const panel = new DarjeelingPlanPanel(plugin, sessions, client, hostEl);
  panel.mount();

  const textarea = hostEl.querySelector("textarea");
  assert.ok(textarea, "Empty state must render draft textarea");

  textarea.value = "Plan out Sprint 3 documentation rewrite";
  const inputListeners = textarea.listeners.get("input") || [];
  for (const fn of inputListeners) fn();

  // Simulate tab switch / unmount & re-mount
  hostEl.empty();
  panel.mount();

  const restoredTextarea = hostEl.querySelector("textarea");
  assert.ok(restoredTextarea, "Restored panel must render textarea");
  assert.strictEqual(
    restoredTextarea.value,
    "Plan out Sprint 3 documentation rewrite",
    "Draft text must be preserved across mounts"
  );

  panel.destroy();
});

test("planView: busy state disables action buttons and paints progress card with Cancel (PD-16, DM-26)", () => {
  const { plugin, sessions, client } = createMockEnvironment(makeSamplePlan());
  const hostEl = makeDomElement("div");

  const panel = new DarjeelingPlanPanel(plugin, sessions, client, hostEl);
  panel.mount();

  // Simulate busy operation
  plugin.planStore.setBusy(true, "Synthesizing vault architecture…");

  // Check progress card
  const progressCard = hostEl.querySelector(".dj-plan-progress-card");
  assert.ok(progressCard, "Progress card must be visible when busy");

  const label = hostEl.querySelector(".dj-plan-progress-label");
  assert.ok(label, "Progress card must display label");
  assert.strictEqual(label.textContent, "Synthesizing vault architecture…");

  const cancelBtn = hostEl.querySelector(".dj-plan-progress-cancel");
  assert.ok(cancelBtn, "Cancel button must be rendered on progress card");

  // Check all regular action buttons are disabled while busy
  const planButtons = hostEl.querySelectorAll("button").filter(
    (b: any) => !b.hasClass("dj-plan-progress-cancel") && b.hasClass("dj-btn")
  );
  assert.ok(planButtons.length >= 6, "Must find action buttons to check disabled state");
  for (const btn of planButtons) {
    assert.strictEqual(btn.disabled, true, "Buttons must be disabled while busy");
    assert.strictEqual(btn.getAttribute("aria-disabled"), "true");
  }

  // Cancel operation
  cancelBtn.click();
  assert.strictEqual(plugin.planStore.isBusy, false, "Cancelling must reset busy state in planStore");

  panel.destroy();
});

test("planView: phase header is an accessible button with aria-expanded (PD-37)", () => {
  const { plugin, sessions, client } = createMockEnvironment(makeSamplePlan());
  const hostEl = makeDomElement("div");

  const panel = new DarjeelingPlanPanel(plugin, sessions, client, hostEl);
  panel.mount();

  const phaseHeads = hostEl.querySelectorAll("button.dj-phase-head");
  assert.strictEqual(phaseHeads.length, 2, "Each phase must have a button.dj-phase-head");

  const firstHead = phaseHeads[0];
  assert.strictEqual(firstHead.getAttribute("type"), "button");
  assert.strictEqual(firstHead.getAttribute("aria-expanded"), "true", "Active phase starts open");

  const secondHead = phaseHeads[1];
  assert.strictEqual(secondHead.getAttribute("aria-expanded"), "false", "Pending phase starts closed");

  // Click to toggle
  secondHead.click();
  assert.strictEqual(secondHead.getAttribute("aria-expanded"), "true", "Clicking expands the phase");

  panel.destroy();
});

test("planView: multiple panels stay synchronized via shared PlanStore (PD-35)", async () => {
  const { plugin, sessions, client } = createMockEnvironment(null);
  const hostEl1 = makeDomElement("div");
  const hostEl2 = makeDomElement("div");

  const panel1 = new DarjeelingPlanPanel(plugin, sessions, client, hostEl1);
  const panel2 = new DarjeelingPlanPanel(plugin, sessions, client, hostEl2);

  panel1.mount();
  panel2.mount();

  assert.ok(hostEl1.querySelector(".dj-plan-empty"), "Panel 1 starts empty");
  assert.ok(hostEl2.querySelector(".dj-plan-empty"), "Panel 2 starts empty");

  // Update plan in planStore
  const newPlan = makeSamplePlan();
  await plugin.planStore.setPlan(newPlan);

  // Both panels should re-render with the new plan
  assert.ok(hostEl1.querySelector(".dj-plan-title"), "Panel 1 receives plan");
  assert.ok(hostEl2.querySelector(".dj-plan-title"), "Panel 2 receives plan");
  assert.strictEqual(
    hostEl1.querySelector(".dj-plan-title").textContent,
    "Plan UI Modernization"
  );
  assert.strictEqual(
    hostEl2.querySelector(".dj-plan-title").textContent,
    "Plan UI Modernization"
  );

  panel1.destroy();
  panel2.destroy();
});

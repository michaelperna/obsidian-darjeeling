import test from "node:test";
import assert from "node:assert/strict";
import { DarjeelingOnboardingView } from "../../src/ui/onboarding/onboardingView";
import { generateQrSvg } from "../../src/net/qr";
import { createDefaultSettings } from "../../src/settings/schema";
import { Platform } from "./stubs/obsidian";

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

function findInEl(el: any, selector: string, matches: any[]): void {
  const isClass = selector.startsWith(".");
  const name = isClass ? selector.slice(1) : selector.toUpperCase();
  for (const child of el.children) {
    if (isClass && child.classList.has(name)) {
      matches.push(child);
    } else if (!isClass && child.tagName === name) {
      matches.push(child);
    }
    findInEl(child, selector, matches);
  }
}

function makeMockPlugin(settingsOverrides = {}, storageMap: Record<string, string> = {}) {
  const settings = {
    ...createDefaultSettings(),
    ...settingsOverrides,
  };
  return {
    app: {
      vault: {
        getMarkdownFiles: () => [],
      },
      loadLocalStorage: (k: string) => storageMap[k] ?? null,
    },
    settings,
    saveSettings: async () => {},
    addHost: async (h: any) => {
      settings.hosts.push(h);
    },
    availableAgents: [],
    secretStorage: {
      getSecret: async (k: string) => storageMap[`dj_secret_${k}`] ?? null,
      setSecret: async (k: string, v: string) => {
        storageMap[`dj_secret_${k}`] = v;
      },
      peek: (k: string) => storageMap[`dj_secret_${k}`] ?? "",
      generateSecretId: () => "dj_test_sec",
      storeSecretWithVerification: async (_v: string) => "dj_test_sec",
    },
  } as any;
}

test("Onboarding: first-run mounts s0_welcome", () => {
  const parent = makeDomElement("div");
  const plugin = makeMockPlugin();
  let completed = false;

  const view = new DarjeelingOnboardingView(parent, plugin, () => {
    completed = true;
  });

  assert.equal(view.getCurrentStep(), "s0_welcome");
  assert.equal(completed, false);

  const title = parent.querySelector(".dj-onboarding-title");
  assert.ok(title, "Title element rendered");
  assert.ok(title.textContent.includes("Darjeeling"), "Welcome message rendered");

  const getStartedBtn = parent.querySelector(".dj-btn-primary");
  assert.ok(getStartedBtn, "Primary CTA rendered");
});

test("Onboarding: 'Set up later' marks onboardingDone = true", async () => {
  const parent = makeDomElement("div");
  const plugin = makeMockPlugin();
  let completed = false;

  const _view = new DarjeelingOnboardingView(parent, plugin, () => {
    completed = true;
  });

  const buttons = parent.querySelectorAll("button");
  const laterBtn = buttons.find((b: any) => b.textContent.includes("Set up later"));
  assert.ok(laterBtn, "'Set up later' button rendered");

  laterBtn.click();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(plugin.settings.onboardingDone, true);
  assert.equal(completed, true);
});

test("Onboarding: mobile environment skips 'This computer' option", () => {
  const prevIsMobile = Platform.isMobile;
  const prevIsDesktop = Platform.isDesktop;
  const prevIsDesktopApp = Platform.isDesktopApp;
  const prevIsPhone = Platform.isPhone;

  try {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    Platform.isDesktopApp = false;
    Platform.isPhone = true;

    const parent = makeDomElement("div");
    const plugin = makeMockPlugin();

    const _view = new DarjeelingOnboardingView(parent, plugin, () => {});

    const cards = parent.querySelectorAll(".dj-onboarding-card");
    assert.ok(cards.length > 0, "Cards rendered");

    // On mobile, "This computer" should not be present
    const thisComputer = cards.find((c: any) =>
      c.textContent.includes("This computer")
    );
    assert.equal(thisComputer, undefined, "This computer option should be omitted on mobile");

    // "Your own server" and "An AI provider directly" should still be present
    const serverCard = cards.find((c: any) =>
      c.textContent.includes("Your own server")
    );
    assert.ok(serverCard, "Your own server option should be visible on mobile");
  } finally {
    Platform.isMobile = prevIsMobile;
    Platform.isDesktop = prevIsDesktop;
    Platform.isDesktopApp = prevIsDesktopApp;
    Platform.isPhone = prevIsPhone;
  }
});

test("Onboarding: host without secret routes to pair_this_device (G-36)", () => {
  const parent = makeDomElement("div");
  // Synced host present, but no local secret stored
  const plugin = makeMockPlugin({
    hosts: [
      {
        id: "thinkpad-1",
        name: "ThinkPad Lab",
        baseUrl: "http://100.64.0.12:8765",
        tokenSecretId: "sec-thinkpad-1",
      },
    ],
    activeHostId: "thinkpad-1",
  });

  const view = new DarjeelingOnboardingView(parent, plugin, () => {});

  assert.equal(view.shouldShowPairThisDevice(), true);
  assert.equal(view.getCurrentStep(), "pair_this_device");

  const title = parent.querySelector(".dj-onboarding-title");
  assert.ok(title, "Title element rendered");
  assert.ok(title.textContent.includes("Pair this device"), "Pair this device screen rendered");
});

test("Onboarding: zero-dependency SVG QR code generator", () => {
  const deepLink = "obsidian://darjeeling?action=pair&url=http%3A%2F%2F100.64.0.12%3A8765&code=12345678";
  const svg = generateQrSvg(deepLink, 180);

  assert.ok(svg.startsWith("<svg"), "Produces SVG element");
  assert.ok(svg.includes('width="180"'), "Sets requested width");
  assert.ok(svg.includes('height="180"'), "Sets requested height");
  assert.ok(svg.includes("<path"), "Includes path elements");
  assert.ok(svg.endsWith("</svg>"), "Closes SVG tag");
});

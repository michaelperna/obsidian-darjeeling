import test from "node:test";
import assert from "node:assert/strict";
import { installFakeWebSocket } from "./stubs/fakeWebSocket";
import { TerminalPane } from "../../src/ui/terminal/terminalPane";
import { createDefaultSettings } from "../../src/settings/schema";
import { Terminal } from "./stubs/xterm";

function makeFakeElement(tag = "div"): any {
  const el: any = {
    tagName: tag.toUpperCase(),
    children: [],
    classList: new Set<string>(),
    attributes: new Map<string, string>(),
    style: {},
    clientWidth: 800,
    clientHeight: 600,
    textContent: "",
    value: "",
    title: "",
    setText(text: string) {
      el.textContent = text;
      return el;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
    createDiv(opts?: any) {
      const child = makeFakeElement("div");
      if (opts?.cls) child.addClass(opts.cls);
      el.children.push(child);
      return child;
    },
    createEl(t: string, opts?: any) {
      const child = makeFakeElement(t);
      if (opts?.cls) child.addClass(opts.cls);
      if (opts?.text) child.textContent = opts.text;
      if (opts?.value) child.value = opts.value;
      el.children.push(child);
      return child;
    },
    createSpan(opts?: any) {
      return el.createEl("span", opts);
    },
    addClass(cls: string) {
      el.classList.add(cls);
    },
    removeClass(cls: string) {
      el.classList.delete(cls);
    },
    toggleClass(cls: string, val?: boolean) {
      if (val === undefined) val = !el.classList.has(cls);
      if (val) el.classList.add(cls);
      else el.classList.delete(cls);
    },
    hasClass(cls: string) {
      return el.classList.has(cls);
    },
    empty() {
      el.children.length = 0;
    },
    setAttribute(name: string, value: string) {
      el.attributes.set(name, value);
    },
    getAttribute(name: string) {
      return el.attributes.get(name) ?? null;
    },
    removeAttribute(name: string) {
      el.attributes.delete(name);
    },
    querySelector(_sel: string) {
      return null;
    },
    querySelectorAll(_sel: string) {
      return [];
    },
    addEventListener(_type: string, _cb: any) {},
    removeEventListener(_type: string, _cb: any) {},
  };
  return el;
}

if (typeof (globalThis as any).window !== "undefined") {
  if (typeof (globalThis as any).window.addEventListener === "undefined") {
    (globalThis as any).window.addEventListener = () => {};
    (globalThis as any).window.removeEventListener = () => {};
  }
}

if (typeof (globalThis as any).document === "undefined") {
  (globalThis as any).document = {
    body: makeFakeElement("body"),
    createElement: (tag: string) => makeFakeElement(tag),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

function createTestHarness() {
  const settings = createDefaultSettings();
  settings.terminalProfiles = [
    {
      id: "remote-test",
      name: "Remote Tmux",
      type: "remote",
      sessionName: "darjeeling",
    },
  ];
  settings.activeTerminalProfileId = "remote-test";
  settings.meshnetHost = "127.0.0.1";
  settings.port = 8765;
  settings.authToken = "secret-token-123";
  settings.sessionName = "darjeeling";

  const plugin: any = {
    app: {
      workspace: {
        on: () => ({}),
        offref: () => {},
      },
      vault: {
        adapter: {
          getBasePath: () => "/tmp/vault",
        },
      },
    },
    settings,
    saveSettings: async () => {},
  };

  const sessions: any = {
    listSessions: async () => [
      { name: "darjeeling", command: "bash" },
      { name: "work", command: "htop" },
    ],
    createSession: async (name: string) => ({ ok: true, name: name.replace(/\s+/g, "_") }),
    deleteSession: async () => true,
  };

  const containerEl = makeFakeElement("div");
  const pane = new TerminalPane(plugin, sessions, containerEl);
  pane.mount();
  pane.activate();

  return { plugin, sessions, containerEl, pane };
}

test("Terminal options: convertEol is false, macOptionIsMeta defaults to false (VTH-19, VTH-20)", () => {
  const wsCtrl = installFakeWebSocket();
  try {
    const { pane } = createTestHarness();
    const term = (pane as any).terminal as Terminal;
    assert.ok(term);
    assert.equal(term.options.convertEol, false);
    assert.equal(term.options.macOptionIsMeta, false);
    pane.destroy();
  } finally {
    wsCtrl.restore();
  }
});

test("Instance-safe sockets: Restart twice leaves exactly one live socket receiving input (VTH-02, VTH-13)", async () => {
  const wsCtrl = installFakeWebSocket();
  try {
    const { pane } = createTestHarness();

    // Initial mount and ensureTerminal already triggered connectTerminal #1
    assert.equal(wsCtrl.sockets.length, 1);
    const sock1 = wsCtrl.sockets[0];

    // Trigger restart 1
    await pane.connectTerminal();
    assert.equal(wsCtrl.sockets.length, 2);
    const sock2 = wsCtrl.sockets[1];

    // Trigger restart 2
    await pane.connectTerminal();
    assert.equal(wsCtrl.sockets.length, 3);
    const sock3 = wsCtrl.sockets[2];

    // sock1 and sock2 were closed
    assert.equal(sock1.readyState, sock1.CLOSING);
    assert.equal(sock2.readyState, sock2.CLOSING);

    // Open sock3
    sock3.serverOpen();
    assert.equal(sock3.readyState, sock3.OPEN);

    // Send input from terminal
    pane.sendRaw("ls -la\r");

    // Only sock3 should have received the frame
    assert.deepEqual(sock1.sent, []);
    assert.deepEqual(sock2.sent, []);
    assert.ok(sock3.sent.includes("ls -la\r"));

    // Stale messages on sock1 or sock2 should be ignored completely
    const term = (pane as any).terminal as Terminal;
    const writtenBefore = term.written.length;
    sock1.serverSend("stale message from sock1\r\n");
    sock2.serverSend("stale message from sock2\r\n");
    assert.equal(term.written.length, writtenBefore);

    // Stale closes on sock1 or sock2 should not detach pane
    sock1.serverClose(1006, "abnormal closure");
    assert.equal((pane as any).termSocket, sock3);
    assert.equal((pane as any).termReconnect, null);

    pane.destroy();
  } finally {
    wsCtrl.restore();
  }
});

test("Close code 4401 surfaces Token rejected and does NOT retry (VTH-07)", async () => {
  const wsCtrl = installFakeWebSocket();
  try {
    const { pane } = createTestHarness();
    const sock = wsCtrl.last!;
    sock.serverOpen();

    // Server closes with 4401 (Unauthorized)
    sock.serverClose(4401, "unauthorized");

    const term = (pane as any).terminal as Terminal;
    const output = term.written.join("");
    assert.ok(output.includes("Token rejected"), "should display token rejected banner");
    assert.equal((pane as any).termSocket, null);
    assert.equal((pane as any).termReconnect, null, "should NOT schedule reconnect for 4401");

    pane.destroy();
  } finally {
    wsCtrl.restore();
  }
});

test("Close code 4000 surfaces Shell ended and does NOT auto-retry (VTH-10)", async () => {
  const wsCtrl = installFakeWebSocket();
  try {
    const { pane } = createTestHarness();
    const sock = wsCtrl.last!;
    sock.serverOpen();

    // Server closes with 4000 (Shell ended)
    sock.serverClose(4000, "Shell ended");

    const term = (pane as any).terminal as Terminal;
    const output = term.written.join("");
    assert.ok(output.includes("Shell ended"), "should display shell ended banner");
    assert.equal((pane as any).termSocket, null);
    assert.equal((pane as any).termReconnect, null, "should NOT auto-retry after shell ended");

    pane.destroy();
  } finally {
    wsCtrl.restore();
  }
});

test("Session switching uses single source of truth for attached session (VTH-03)", async () => {
  const wsCtrl = installFakeWebSocket();
  try {
    const { plugin, pane } = createTestHarness();

    // Socket 1 connected to darjeeling
    const sock1 = wsCtrl.last!;
    assert.ok(sock1.url.includes("session=darjeeling"));

    // Switch session to "work"
    plugin.settings.sessionName = "work";
    await pane.connectTerminal();

    const sock2 = wsCtrl.last!;
    assert.ok(sock2.url.includes("session=work"), "reconnected to work session");
    assert.equal(plugin.settings.sessionName, "work");

    pane.destroy();
  } finally {
    wsCtrl.restore();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { DarjeelingChat } from "../../src/ui/chat/chatView";
import type { StreamResult } from "../../src/net/agentClient";
import { createDefaultSettings } from "../../src/settings/schema";
import { Component, Notice, notices, resetNotices } from "./stubs/obsidian";
import { AgentClient } from "../../src/net/agentClient";
import {
  clearBypassConfirmed,
  setBypassConfirmedForConversation,
} from "../../src/ui/modals/confirm";
import { resolveEffectivePermissionMode } from "../../src/ui/chat/send";

function makeDomElement(tag = "div"): any {
  const el: any = {
    tagName: tag.toUpperCase(),
    children: [] as any[],
    classList: new Set<string>(),
    attributes: new Map<string, string>(),
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    textContent: "",
    value: "",
    checked: false,
    offsetParent: {},
    isConnected: true,
    scrollTop: 0,
    scrollHeight: 100,
    clientHeight: 100,
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
    setCssProps(_props: Record<string, string>) {
      return el;
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
    toggleClass(cls: string, val?: boolean) {
      const add = val !== undefined ? val : !el.hasClass(cls);
      if (add) el.addClass(cls);
      else el.removeClass(cls);
    },
    insertBefore(newChild: any, refChild: any) {
      const idx = el.children.indexOf(refChild);
      if (idx !== -1) el.children.splice(idx, 0, newChild);
      else el.children.push(newChild);
      return newChild;
    },
    remove() {
      el.removed = true;
    },
    show() {},
    hide() {},
    focus() {},
    blur() {},
    scrollIntoView() {},
    scrollTo() {},
    addEventListener(type: string, fn: (...args: any[]) => void) {
      if (!el.listeners.has(type)) el.listeners.set(type, []);
      el.listeners.get(type).push(fn);
    },
    dispatchEvent(evt: any) {
      const fns = el.listeners.get(evt.type) || [];
      for (const fn of fns) fn(evt);
    },
    querySelector(sel: string): any {
      const all = el.querySelectorAll(sel);
      return all[0] ?? null;
    },
    querySelectorAll(selector: string): any[] {
      const matched: any[] = [];
      const traverse = (n: any) => {
        if (!n) return;
        if (selector.startsWith(".")) {
          const cls = selector.slice(1);
          if (typeof n.hasClass === "function" ? n.hasClass(cls) : n.classList?.has?.(cls)) {
            matched.push(n);
          }
        } else if (selector.toUpperCase() === n.tagName) {
          matched.push(n);
        }
        if (n.children && Array.isArray(n.children)) {
          for (const c of n.children) traverse(c);
        }
      };
      for (const c of el.children) traverse(c);
      return matched;
    },
  };
  return el;
}

function createTestHarness() {
  const settings = createDefaultSettings();
  settings.streaming = true;

  const plugin: any = {
    app: {
      workspace: {
        on: () => ({ name: "test-event" }),
        getActiveFile: () => null,
      },
      vault: {
        read: async () => "note content",
        getName: () => "test-vault",
        getAbstractFileByPath: (_path: string) => null,
        adapter: {
          getBasePath: () => "/test/vault",
          basePath: "/test/vault",
        },
      },
      metadataCache: {
        getFirstLinkpathDest: () => null,
      },
    },
    settings,
    agentLabel: "Darjeeling Agent",
    saveSettings: async () => {},
    setHeaderDetail: () => {},
    onConnectionState: () => {},
  };

  const sessions: any = {
    listConversations: async () => [],
    readConversation: async () => [],
    listRunningTurns: async () => [],
    pushFile: async () => true,
  };

  let clientHandlers: any = {};
  let interruptCalls = 0;
  let sentTurns: any[] = [];

  const client: any = {
    connectionState: "open",
    setHandlers(h: any) {
      clientHandlers = h;
    },
    getEffectiveRuntimeMode: () => "local",
    interrupt: () => {
      interruptCalls++;
    },
    sendTurn: async (turn: any) => {
      sentTurns.push(turn);
      return true;
    },
    resetConversation: () => {},
    getConversationKey: () => "conv-test",
  };

  const hostEl = makeDomElement("div");
  const chat = new DarjeelingChat(plugin, sessions, client, hostEl);
  chat.load();

  return {
    chat,
    plugin,
    client,
    getHandlers: () => clientHandlers,
    getInterruptCalls: () => interruptCalls,
    getSentTurns: () => sentTurns,
  };
}

test("dj.error drains the queue", async () => {
  const { chat, getHandlers } = createTestHarness();

  // Enqueue turn 1
  await chat.executeTurn("Turn 1");
  assert.equal(chat.isBusy(), true);

  // Queue turn 2 while turn 1 is busy
  await (chat as any).dispatcher.enqueueTurn("Turn 2");

  // An error occurs on Turn 1
  const handlers = getHandlers();
  handlers.onError("Something failed");
  await new Promise((r) => setTimeout(r, 60));

  // finishTurn should have freed the lock and drained Turn 2
  assert.equal(chat.isBusy(), true); // Now busy executing Turn 2!
  assert.equal((chat as any).dispatcher.getQueuedCount(), 0);
  chat.clearTurnWatchdog();
});

test("answer only in result is shown when streaming yields no chunks", async () => {
  const { chat, getHandlers } = createTestHarness();

  await chat.executeTurn("Tell me the answer");
  assert.equal(chat.getActiveTurn(), null);

  const handlers = getHandlers();
  // Server directly sends onResult without previous assistant text
  const resultEvent: StreamResult = {
    result: "Calculated answer: 42",
    is_error: false,
    duration_ms: 1200,
    usage: {
      input_tokens: 15,
      output_tokens: 10,
    },
  };
  handlers.onResult(resultEvent);

  const activeTurn = chat.getActiveTurn();
  assert.notEqual(activeTurn, null);
  assert.ok(activeTurn!.text.includes("Calculated answer: 42"));
});

test("replay result frame with same dj_seq is ignored by chat view", async () => {
  const { chat, getHandlers } = createTestHarness();

  await chat.executeTurn("Testing deduplication");
  const handlers = getHandlers();

  // First result frame with dj_seq: 1
  handlers.onResult({
    result: "First result",
    is_error: false,
    dj_seq: 1,
  } as any);

  const turn = chat.getActiveTurn();
  assert.notEqual(turn, null);
  assert.equal(turn!.text, "First result");

  // Replay result frame with same dj_seq: 1
  handlers.onResult({
    result: "Duplicate result",
    is_error: false,
    dj_seq: 1,
  } as any);

  // Still has first result because duplicate dj_seq was dropped
  assert.equal(turn!.text, "First result");
});

test("newConversation interrupts active turn and ignores old turn frames", async () => {
  const { chat, getHandlers, getInterruptCalls } = createTestHarness();

  await chat.executeTurn("First session question");
  assert.equal(chat.isBusy(), true);

  // User resets or /clears conversation
  chat.newConversation();

  // Client interrupt should have been called
  assert.equal(getInterruptCalls(), 1);
  assert.equal(chat.isBusy(), false);

  // Old delayed frame arrives from old turn
  const handlers = getHandlers();
  handlers.onAssistantText("Late answer from previous session", undefined);

  // The late answer must not be attached to the new conversation
  const turn = chat.getActiveTurn();
  assert.equal(turn, null);
});

test("onResult safely handles NaN or malformed usage statistics without throwing", async () => {
  const { chat, getHandlers } = createTestHarness();

  await chat.executeTurn("Usage test");
  const handlers = getHandlers();

  const malformedResult: StreamResult = {
    result: "Result with weird numbers",
    is_error: false,
    duration_ms: NaN,
    usage: {
      input_tokens: "invalid" as any,
      output_tokens: 50,
    },
    total_cost_usd: NaN,
  };

  // Should not throw
  assert.doesNotThrow(() => {
    handlers.onResult(malformedResult);
  });

  const turn = chat.getActiveTurn();
  assert.notEqual(turn, null);
  assert.ok(turn!.text.includes("Result with weird numbers"));
});

test("send() syncs active epoch and accepts assistant text and result frames without thinking UI hang", async () => {
  const { chat, getHandlers } = createTestHarness();

  // New conversation increments conversationEpoch to 1 while activeEpoch starts at 0
  chat.newConversation();

  // User types into input and sends
  (chat as any).inputEl.value = "Why is the grass green?";
  await chat.send();

  assert.equal(chat.isBusy(), true);

  const handlers = getHandlers();
  handlers.onAssistantText("Because of chlorophyll.", undefined);

  const resultEvent: StreamResult = {
    result: "Because of chlorophyll.",
    is_error: false,
    duration_ms: 1000,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
  handlers.onResult(resultEvent);

  // Thinking indicator should be removed and turn finished
  assert.equal(chat.isBusy(), false);
  const activeTurn = chat.getActiveTurn();
  assert.notEqual(activeTurn, null);
  assert.ok(activeTurn!.text.includes("Because of chlorophyll."));
});

test("dispatcher.executeTurn() syncs active epoch even when invoked directly", async () => {
  const { chat, getHandlers } = createTestHarness();

  chat.newConversation();
  await (chat as any).dispatcher.executeTurn("Direct invocation");

  assert.equal(chat.isBusy(), true);

  const handlers = getHandlers();
  handlers.onAssistantText("Direct turn answered", undefined);
  handlers.onResult({
    result: "Direct turn answered",
    is_error: false,
  });

  assert.equal(chat.isBusy(), false);
  const activeTurn = chat.getActiveTurn();
  assert.notEqual(activeTurn, null);
  assert.ok(activeTurn!.text.includes("Direct turn answered"));
});

test("bypass on a brand-new chat: confirmation keyed to the client conversation id is honoured", async () => {
  clearBypassConfirmed();
  resetNotices();
  const { chat, plugin, getSentTurns } = createTestHarness();
  plugin.settings.agent = "claude";
  plugin.settings.permissionMode = "bypassPermissions";

  // The conversation id exists before any agent session id does.
  const convId = chat.getActiveConversationId();
  assert.equal(convId, "conv-test");
  assert.equal(plugin.settings.lastAgentSessionId, "");
  setBypassConfirmedForConversation(convId);

  await chat.executeTurn("rm the temp files");
  assert.equal(getSentTurns()[0].permission_mode, "bypassPermissions");
  assert.equal(plugin.settings.permissionMode, "bypassPermissions");
  assert.ok(!notices.some((n) => n.startsWith("Running as")));
  chat.clearTurnWatchdog();
  clearBypassConfirmed();
});

test("clamped mode is never silent: Notice + chip moves to the real mode", async () => {
  clearBypassConfirmed();
  resetNotices();
  const { chat, plugin, getSentTurns } = createTestHarness();
  let chipUpdates = 0;
  (chat as any).view = { updateModelChip: () => chipUpdates++ };
  plugin.settings.agent = "claude";
  plugin.settings.permissionMode = "bypassPermissions"; // chip says Bypass, never confirmed

  await chat.executeTurn("do something");
  assert.equal(getSentTurns()[0].permission_mode, "plan");
  assert.equal(plugin.settings.permissionMode, "plan");
  assert.ok(chipUpdates > 0, "chip refreshed to the effective mode");
  assert.ok(notices.some((n) => n.startsWith("Running as Plan only")));
  chat.clearTurnWatchdog();
});

test("resolveEffectivePermissionMode clamps unsupported modes", () => {
  clearBypassConfirmed();
  assert.equal(resolveEffectivePermissionMode("bypassPermissions", "claude", "c1"), "plan");
  setBypassConfirmedForConversation("c1");
  assert.equal(resolveEffectivePermissionMode("bypassPermissions", "claude", "c1"), "bypassPermissions");
  assert.equal(resolveEffectivePermissionMode("bypassPermissions", "agy", "c1"), "plan");
  assert.equal(resolveEffectivePermissionMode("acceptEdits", "agy", "c1"), "acceptEdits");
  clearBypassConfirmed();
});

test("AgentClient mints a conversation key at start and a new one per conversation", () => {
  const settings = createDefaultSettings();
  settings.runtimeMode = "direct-api";
  const client = new AgentClient(settings);
  const first = client.getConversationKey();
  assert.ok(first);
  assert.equal(client.getSessionId() !== first, true);
  client.resetConversation();
  assert.notEqual(client.getConversationKey(), first);
  client.destroy();
});

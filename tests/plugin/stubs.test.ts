// The shared test doubles, checked on their own. These tests use no src/
// behaviour beyond "the plugin bundles and loads against the stubs", so a
// change in src/ never breaks them; if one fails, fix the harness first.
import { test } from "node:test";
import assert from "node:assert/strict";
import DarjeelingPlugin from "../../src/main";
import { Notice, Platform, notices, requestUrl, resetNotices } from "./stubs/obsidian";
import { jsonResponse, recordRequestUrl } from "./stubs/requestUrl";
import { installFakeWebSocket } from "./stubs/fakeWebSocket";
import { installFakeChildProcess } from "./stubs/fakeChildProcess";
import { overrideRequire } from "./stubs/nodeRequire";

test("the whole plugin bundles and loads against the stubs", () => {
  // esbuild refuses to bundle when src/ imports a name the obsidian stub
  // does not export, so reaching this line checks the stub's API surface.
  assert.equal(typeof DarjeelingPlugin, "function");
});

test("requestUrl recorder records calls and throws like Obsidian", async () => {
  const rec = recordRequestUrl((req) =>
    req.url.endsWith("/missing") ? jsonResponse({ detail: "no" }, 404) : jsonResponse({ ok: true })
  );
  try {
    const res = await requestUrl({ url: "http://host/api", method: "POST", body: '{"a":1}' });
    assert.deepEqual(res.json, { ok: true });
    assert.equal(rec.calls[0].method, "POST");
    assert.deepEqual(rec.body(0), { a: 1 });
    await assert.rejects(requestUrl({ url: "http://host/missing" }), /status 404/);
    const soft = await requestUrl({ url: "http://host/missing", throw: false });
    assert.equal(soft.status, 404);
  } finally {
    rec.restore();
  }
  await assert.rejects(requestUrl({ url: "http://host/api" }), /network disabled/);
});

test("fake WebSocket replaces the global and is driven by the test", () => {
  const original = globalThis.WebSocket;
  const ws = installFakeWebSocket();
  try {
    const socket = new WebSocket("ws://host/ws/agent", ["darjeeling.token.t"]);
    const events: string[] = [];
    socket.onopen = () => events.push("open");
    socket.onmessage = (e) => events.push(`msg:${JSON.parse(e.data).type}`);
    socket.onclose = (e) => events.push(`close:${e.code}`);
    assert.equal(socket.readyState, WebSocket.CONNECTING);
    ws.last!.serverOpen();
    socket.send(JSON.stringify({ type: "ping" }));
    ws.last!.serverSend({ type: "dj.pong" });
    socket.close();
    assert.equal(ws.live().length, 0);
    ws.last!.flushClose();
    assert.deepEqual(events, ["open", "msg:dj.pong", "close:1005"]);
    assert.deepEqual(ws.last!.sentJson(), [{ type: "ping" }]);
    assert.deepEqual(ws.last!.protocols, ["darjeeling.token.t"]);
  } finally {
    ws.restore();
  }
  assert.equal(globalThis.WebSocket, original);
});

test("fake child_process answers lazy require() calls", () => {
  const cp = installFakeChildProcess();
  let fakeSpawn: unknown;
  try {
    const childProcess = require("node:child_process");
    fakeSpawn = childProcess.spawn;
    cp.execSyncResult = "output";
    assert.equal(childProcess.execSync("echo"), "output");

    const child = childProcess.spawn("claude", ["-p"], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
    const seen: string[] = [];
    child.stdout.on("data", (chunk: Buffer) => seen.push(chunk.toString()));
    child.on("close", (code: number) => seen.push(`close:${code}`));
    child.stdin.write("prompt");
    child.stdio[3].write("80x24\n");
    child.stdout.write("line");
    child.exit(0);

    assert.equal(cp.spawns[0].command, "claude");
    assert.deepEqual(cp.spawns[0].args, ["-p"]);
    assert.equal(child.stdinText(), "prompt");
    assert.equal(child.pipeText(3), "80x24\n");
    assert.deepEqual(seen, ["line", "close:0"]);
  } finally {
    cp.restore();
  }
  assert.notEqual(require("child_process").spawn, fakeSpawn, "restore() brings back Node's module");
});

test("overrideRequire swaps any builtin and restores it", () => {
  const restore = overrideRequire("fs", { existsSync: () => true });
  try {
    assert.equal(require("fs").existsSync("/definitely/not/here"), true);
  } finally {
    restore();
  }
  assert.equal(require("fs").existsSync("/definitely/not/here"), false);
});

test("Notice records messages; Platform is a plain mutable object", () => {
  resetNotices();
  new Notice("hello");
  assert.deepEqual(notices, ["hello"]);
  Platform.isMobile = true;
  try {
    assert.equal(Platform.isMobile, true);
  } finally {
    Platform.isMobile = false;
  }
});

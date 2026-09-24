import { test, describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AgentClient, type AgentEvent } from "../../src/net/agentClient";
import { createMockSettings, installFakeWebSocket } from "./helpers/transport";
import { setRequestUrlHandler } from "./stubs/obsidian";

describe("AgentClient transport & protocol v2", () => {
  let fakeWs: ReturnType<typeof installFakeWebSocket>;

  beforeEach(() => {
    fakeWs = installFakeWebSocket();
    setRequestUrlHandler(null);
  });

  afterEach(() => {
    fakeWs.restore();
    setRequestUrlHandler(null);
  });

  it("connects with auth token in subprotocol and formats websocket url", () => {
    const settings = createMockSettings({
      meshnetHost: "100.101.102.103",
      port: 8765,
      authToken: "my-secret-token",
    });
    const client = new AgentClient(settings);
    client.connect();

    assert.equal(fakeWs.sockets.length, 1);
    const sock = fakeWs.last!;
    assert.equal(sock.url, "ws://100.101.102.103:8765/ws/agent");
    assert.deepEqual(sock.protocols, ["darjeeling.token.my-secret-token"]);
    assert.equal(client.connectionState, "connecting");

    sock.serverOpen();
    assert.equal(client.connectionState, "open");
    client.destroy();
  });

  it("reconnects when host or connection snapshot changes", () => {
    const settings = createMockSettings({
      meshnetHost: "100.101.102.103",
      port: 8765,
    });
    const client = new AgentClient(settings);
    client.connect();

    const sock1 = fakeWs.last!;
    sock1.serverOpen();
    assert.equal(client.connectionState, "open");

    // Update settings with a new host baseUrl
    const updatedSettings = createMockSettings({
      hosts: [
        {
          id: "host-2",
          name: "ThinkPad Backup",
          baseUrl: "http://100.64.0.11:8765",
        },
      ],
      activeHostId: "host-2",
    });
    client.updateSettings(updatedSettings);

    // Old socket closed, new socket created for host-2
    assert.equal(fakeWs.sockets.length, 2);
    const sock2 = fakeWs.last!;
    assert.equal(sock2.url, "ws://100.64.0.11:8765/ws/agent");
    client.destroy();
  });

  it("ignores stale onclose event from a replaced socket", () => {
    const settings = createMockSettings();
    const client = new AgentClient(settings);
    client.connect();

    const sock1 = fakeWs.last!;
    sock1.serverOpen();

    // Reconnect / new socket
    client.disconnect();
    client.connect();
    const sock2 = fakeWs.last!;
    sock2.serverOpen();
    assert.equal(client.connectionState, "open");

    // Old socket fires close
    sock1.serverClose(1006, "stale close");

    // Current connection remains open!
    assert.equal(client.connectionState, "open");
    client.destroy();
  });

  it("close code 4401 stops reconnect retries immediately", () => {
    const settings = createMockSettings();
    let connError: any = null;
    const client = new AgentClient(settings);
    client.setHandlers({
      onConnectionError: (err) => {
        connError = err;
      },
    });
    client.connect();

    const sock = fakeWs.last!;
    sock.serverOpen();
    sock.serverClose(4401, "unauthorized");

    assert.equal(client.connectionState, "unauthorized");
    assert.ok(connError);
    assert.equal(connError.state, "token_rejected");
    client.destroy();
  });

  it("sends turn with client_turn_id and deduplicates replay events by dj_seq", async () => {
    const settings = createMockSettings();
    const client = new AgentClient(settings);
    client.connect();
    const sock = fakeWs.last!;
    sock.serverOpen();

    const receivedEvents: AgentEvent[] = [];
    client.addListener((ev) => {
      receivedEvents.push(ev);
    });

    const sent = await client.sendTurn({
      agent: "claude",
      prompt: "test prompt",
    });
    assert.ok(sent);

    const sentFrames = sock.sentJson();
    assert.equal(sentFrames.length, 1);
    const turnFrame = sentFrames[0];
    assert.equal(turnFrame.type, "turn");
    assert.ok(turnFrame.client_turn_id.startsWith("ct_"));

    // Server sends first event
    sock.serverSend({
      type: "assistant",
      dj_turn: "turn-1",
      dj_seq: 1,
      message: { content: [{ type: "text", text: "Hello" }] },
    });
    assert.equal(receivedEvents.length, 1);

    // Server sends duplicate replay frame with same dj_seq
    sock.serverSend({
      type: "assistant",
      dj_turn: "turn-1",
      dj_seq: 1,
      message: { content: [{ type: "text", text: "Hello" }] },
    });
    // Deduplicated! Length still 1
    assert.equal(receivedEvents.length, 1);

    // Server sends next frame with dj_seq 2
    sock.serverSend({
      type: "result",
      subtype: "success",
      dj_turn: "turn-1",
      dj_seq: 2,
      result: "Done",
      session_id: "sess-abc",
    });
    assert.equal(receivedEvents.length, 2);
    assert.equal(client.getSessionId(), "sess-abc");
    client.destroy();
  });

  it("reconnects mid-turn and sends attach with active turn_id and lastSeq", async () => {
    const settings = createMockSettings();
    const client = new AgentClient(settings);
    client.connect();
    const sock1 = fakeWs.last!;
    sock1.serverOpen();

    await client.sendTurn({
      agent: "claude",
      prompt: "long running prompt",
    });

    // Stream first event
    sock1.serverSend({
      type: "assistant",
      dj_turn: "turn-999",
      dj_seq: 5,
      message: { content: [{ type: "text", text: "Working..." }] },
    });

    // Connection drops mid-turn
    sock1.serverClose(1006, "network drop");

    // Reconnect
    client.connect();
    const sock2 = fakeWs.last!;
    sock2.serverOpen();

    // Socket 2 should immediately send attach frame
    const sock2Frames = sock2.sentJson();
    assert.ok(sock2Frames.length >= 1);
    const attachFrame = sock2Frames.find((f) => f.type === "attach");
    assert.ok(attachFrame);
    assert.equal(attachFrame.turn_id, "turn-999");
    assert.equal(attachFrame.since_seq, 5);
    client.destroy();
  });

  it("foreground event sends ping and triggers reconnect on half-open socket", async () => {
    const settings = createMockSettings();
    const client = new AgentClient(settings);
    client.connect();
    const sock1 = fakeWs.last!;
    sock1.serverOpen();

    // Foreground event
    client.handleForeground();

    // Ping frame sent
    const frames = sock1.sentJson();
    assert.ok(frames.some((f) => f.type === "ping"));

    client.destroy();
  });

  it("checks /health protocol compatibility", async () => {
    const settings = createMockSettings({
      meshnetHost: "100.101.102.103",
      port: 8765,
    });
    const client = new AgentClient(settings);

    // 1. Server running protocol v1 (incompatible, needs update)
    setRequestUrlHandler(async () => ({
      status: 200,
      headers: {},
      text: JSON.stringify({ api: 1, api_min: 1 }),
      json: { api: 1, api_min: 1 },
      arrayBuffer: new ArrayBuffer(0),
    }));

    const check1 = await client.checkServerProtocol();
    assert.equal(check1.ok, false);
    assert.equal(check1.state, "protocol_mismatch");
    assert.ok(check1.message.includes("Update your server"));

    // 2. Server requiring future protocol v3 (plugin needs update)
    setRequestUrlHandler(async () => ({
      status: 200,
      headers: {},
      text: JSON.stringify({ api: 3, api_min: 3 }),
      json: { api: 3, api_min: 3 },
      arrayBuffer: new ArrayBuffer(0),
    }));

    const check2 = await client.checkServerProtocol();
    assert.equal(check2.ok, false);
    assert.equal(check2.state, "protocol_mismatch");
    assert.ok(check2.message.includes("Update the plugin"));

    // 3. Server running compatible protocol v2
    setRequestUrlHandler(async () => ({
      status: 200,
      headers: {},
      text: JSON.stringify({ api: 2, api_min: 2 }),
      json: { api: 2, api_min: 2 },
      arrayBuffer: new ArrayBuffer(0),
    }));

    const check3 = await client.checkServerProtocol();
    assert.equal(check3.ok, true);
    client.destroy();
  });

  it("startAsyncTurn, pollTurn, and pushFile send correct HTTP payloads", async () => {
    const settings = createMockSettings({
      meshnetHost: "100.101.102.103",
      port: 8765,
      authToken: "secret",
    });
    const client = new AgentClient(settings);

    let lastRequest: any = null;
    setRequestUrlHandler(async (req) => {
      lastRequest = req;
      if (req.url.includes("/api/agent/turn")) {
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({ turn_id: "t-1", status: "queued" }),
          json: { turn_id: "t-1", status: "queued" },
          arrayBuffer: new ArrayBuffer(0),
        };
      }
      if (req.url.includes("/api/turns/t-1/events")) {
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({ turn_id: "t-1", events: [], is_active: false, latest_seq: 10 }),
          json: { turn_id: "t-1", events: [], is_active: false, latest_seq: 10 },
          arrayBuffer: new ArrayBuffer(0),
        };
      }
      if (req.url.includes("/api/vault/push")) {
        return {
          status: 200,
          headers: {},
          text: "{}",
          json: {},
          arrayBuffer: new ArrayBuffer(0),
        };
      }
      return { status: 404, headers: {}, text: "", json: null, arrayBuffer: new ArrayBuffer(0) };
    });

    const asyncRes = await client.startAsyncTurn({ agent: "claude", prompt: "async test" });
    assert.deepEqual(asyncRes, { turn_id: "t-1", status: "queued" });
    assert.ok(lastRequest.body.includes('"async":true'));

    const pollRes = await client.pollTurn("t-1", 5, 10);
    assert.equal(pollRes?.turn_id, "t-1");
    assert.equal(pollRes?.latest_seq, 10);
    assert.ok(lastRequest.url.includes("since_seq=5"));

    const pushRes = await client.pushFile("note.md", "abc123sha", "# Content");
    assert.equal(pushRes.ok, true);
    assert.ok(lastRequest.body.includes('"path":"note.md"'));
    client.destroy();
  });
});

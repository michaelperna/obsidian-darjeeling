import test from "node:test";
import assert from "node:assert/strict";
import { AgentClient } from "../../src/net/agentClient";
import { DEFAULT_SETTINGS } from "../../src/settings/schema";
import {
  isBypassConfirmedForConversation,
  setBypassConfirmedForConversation,
  clearBypassConfirmed,
} from "../../src/ui/modals/confirm";
import { installFakeWebSocket } from "./stubs/fakeWebSocket";

test("isBypassConfirmedForConversation manages conversation bypass confirmation state", () => {
  clearBypassConfirmed();
  const convA = "conv-123";
  const convB = "conv-456";

  assert.equal(isBypassConfirmedForConversation(convA), false);
  assert.equal(isBypassConfirmedForConversation(convB), false);

  setBypassConfirmedForConversation(convA);
  assert.equal(isBypassConfirmedForConversation(convA), true);
  assert.equal(isBypassConfirmedForConversation(convB), false);

  clearBypassConfirmed(convA);
  assert.equal(isBypassConfirmedForConversation(convA), false);

  setBypassConfirmedForConversation(convA);
  setBypassConfirmedForConversation(convB);
  clearBypassConfirmed(); // clears all
  assert.equal(isBypassConfirmedForConversation(convA), false);
  assert.equal(isBypassConfirmedForConversation(convB), false);
});

test("AgentClient.sendTurn clamps bypassPermissions to plan if unconfirmed", async () => {
  clearBypassConfirmed();
  const ws = installFakeWebSocket();
  let client: AgentClient | undefined;

  try {
    const settings = {
      ...DEFAULT_SETTINGS,
      runtimeMode: "remote" as const,
      meshnetHost: "127.0.0.1",
      port: 8765,
      agent: "claude",
    };
    client = new AgentClient(settings, "/test/vault");
    client.connect();
    ws.last!.serverOpen();

    // Confirmation is keyed to the client-side conversation id, which exists
    // from chat start (no agent session id yet).
    const convId = client.getConversationKey();
    assert.ok(convId);
    const options = {
      agent: "claude",
      prompt: "Execute bash command",
      permission_mode: "bypassPermissions" as const,
    };

    // 1. Unconfirmed -> must be clamped to plan
    await client.sendTurn(options);
    const sentFrames = ws.last!.sentJson();
    assert.equal(sentFrames.length, 1);
    assert.equal((sentFrames[0] as any).permission_mode, "plan");
    (client as any).turnActive = false;

    // 2. Confirmed -> bypassPermissions is preserved for claude
    setBypassConfirmedForConversation(convId);
    options.permission_mode = "bypassPermissions";
    await client.sendTurn(options);
    const sentFrames2 = ws.last!.sentJson();
    assert.equal(sentFrames2.length, 2);
    assert.equal((sentFrames2[1] as any).permission_mode, "bypassPermissions");
    (client as any).turnActive = false;

    // 3. For agent not supporting bypass (e.g. agy), clamped to plan even if confirmed
    const agyOptions = {
      agent: "agy",
      prompt: "Agy turn",
      permission_mode: "bypassPermissions" as const,
    };
    await client.sendTurn(agyOptions);
    const sentFrames3 = ws.last!.sentJson();
    assert.equal(sentFrames3.length, 3);
    assert.equal((sentFrames3[2] as any).permission_mode, "plan");
    (client as any).turnActive = false;
  } catch (err) {
    console.error("DISPATCH TEST ERROR:", err);
    throw err;
  } finally {
    clearBypassConfirmed();
    client?.disconnect();
    ws.restore();
  }
});

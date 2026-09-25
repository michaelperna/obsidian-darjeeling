import test from "node:test";
import assert from "node:assert/strict";
import { setRequestUrlHandler } from "./stubs/obsidian";
import { DirectApiRunner } from "../../src/runtime/directApi";
import { createDefaultSettings, type DarjeelingSettings } from "../../src/settings/schema";
import { secretsWithKeys } from "./helpers/secrets";
import type { AgentEvent, StreamResult } from "../../src/net/agentClient";

function createTestSettings(overrides: Partial<DarjeelingSettings> = {}): DarjeelingSettings {
  return {
    ...createDefaultSettings(),
    runtimeMode: "direct-api",
    directApiProvider: "gemini",
    ...overrides,
  };
}

/** Runner whose keys live in secret storage, as in the shipped plugin. */
async function createRunner(
  settings: DarjeelingSettings = createTestSettings(),
  keys: Record<string, string> = { gemini: "test-gemini-key" }
): Promise<DirectApiRunner> {
  return new DirectApiRunner(settings, await secretsWithKeys(settings, keys));
}

test("DirectApiRunner: rejects concurrent turns", async () => {
  let resolveResponse: () => void;
  const barrier = new Promise<void>((r) => {
    resolveResponse = r;
  });

  setRequestUrlHandler(async () => {
    await barrier;
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Done" }] } }],
      }),
      json: {
        candidates: [{ content: { parts: [{ text: "Done" }] } }],
      },
      arrayBuffer: new ArrayBuffer(0),
    };
  });

  const runner = await createRunner();
  let errorMessage = "";
  runner.setHandlers({
    onError: (msg) => {
      errorMessage = msg;
    },
  });

  const turn1 = runner.sendTurn({ prompt: "First" });
  assert.equal(runner.isTurnActive, true);

  const turn2 = await runner.sendTurn({ prompt: "Second" });
  assert.equal(turn2, false);
  assert.equal(errorMessage, "A turn is already running. Stop it first.");

  resolveResponse!();
  const res1 = await turn1;
  assert.equal(res1, true);
  assert.equal(runner.isTurnActive, false);

  setRequestUrlHandler(null);
});

test("DirectApiRunner: late replies are discarded when interrupted (PD-12)", async () => {
  let resolveResponse: () => void;
  const barrier = new Promise<void>((r) => {
    resolveResponse = r;
  });

  setRequestUrlHandler(async () => {
    await barrier;
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Late response" }] } }],
      }),
      json: {
        candidates: [{ content: { parts: [{ text: "Late response" }] } }],
      },
      arrayBuffer: new ArrayBuffer(0),
    };
  });

  const runner = await createRunner();
  let receivedText = "";
  let receivedResult = false;
  let statusState = "";

  runner.setHandlers({
    onAssistantText: (t) => {
      receivedText += t;
    },
    onResult: () => {
      receivedResult = true;
    },
    onStatus: (s) => {
      statusState = s.state;
    },
  });

  const turnPromise = runner.sendTurn({ prompt: "Thinking..." });
  assert.equal(runner.isTurnActive, true);

  // Stop / interrupt while in flight
  runner.interrupt();
  assert.equal(runner.isTurnActive, false);
  assert.equal(statusState, "interrupted");

  // Release backend response
  resolveResponse!();
  const completed = await turnPromise;

  assert.equal(completed, false, "Late reply turn must return false");
  assert.equal(receivedText, "", "No assistant text emitted for interrupted turn");
  assert.equal(receivedResult, false, "No onResult emitted for interrupted turn");

  setRequestUrlHandler(null);
});

test("DirectApiRunner: history is committed only after successful non-empty reply", async () => {
  let shouldFail = true;
  setRequestUrlHandler(async () => {
    if (shouldFail) {
      return {
        status: 500,
        headers: {},
        text: JSON.stringify({ error: { message: "Server error" } }),
        json: { error: { message: "Server error" } },
        arrayBuffer: new ArrayBuffer(0),
      };
    }
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Success reply" }] } }],
      }),
      json: {
        candidates: [{ content: { parts: [{ text: "Success reply" }] } }],
      },
      arrayBuffer: new ArrayBuffer(0),
    };
  });

  const runner = await createRunner();
  let lastError = "";
  runner.setHandlers({
    onError: (msg) => {
      lastError = msg;
    },
  });

  // Turn 1 fails
  const ok1 = await runner.sendTurn({ prompt: "Failed prompt" });
  assert.equal(ok1, false);
  assert.ok(lastError.includes("Server error"));

  // Check history - nothing committed
  shouldFail = false;
  let sentContents: any = null;
  setRequestUrlHandler(async (req) => {
    sentContents = JSON.parse(req.body as string).contents;
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Success reply" }] } }],
      }),
      json: {
        candidates: [{ content: { parts: [{ text: "Success reply" }] } }],
      },
      arrayBuffer: new ArrayBuffer(0),
    };
  });

  const ok2 = await runner.sendTurn({ prompt: "Second attempt" });
  assert.equal(ok2, true);
  // Verify that "Failed prompt" is NOT in the sent contents
  assert.equal(sentContents.length, 1);
  assert.equal(sentContents[0].parts[0].text, "Second attempt");

  setRequestUrlHandler(null);
});

test("DirectApiRunner: runBuffered executes one-off turn without polluting chat history (CORE-06, PD-01)", async () => {
  setRequestUrlHandler(async (req) => {
    const body = JSON.parse(req.body as string);
    if (body.generationConfig?.responseSchema) {
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"plan": ["step 1", "step 2"]}' }] } }],
        }),
        json: {
          candidates: [{ content: { parts: [{ text: '{"plan": ["step 1", "step 2"]}' }] } }],
        },
        arrayBuffer: new ArrayBuffer(0),
      };
    }
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Normal chat reply" }] } }],
      }),
      json: {
        candidates: [{ content: { parts: [{ text: "Normal chat reply" }] } }],
      },
      arrayBuffer: new ArrayBuffer(0),
    };
  });

  const runner = await createRunner();

  // Run buffered turn (e.g. Plan engine generating plan steps)
  const schema = { type: "OBJECT", properties: { plan: { type: "ARRAY" } } };
  const events = await runner.runBuffered({
    prompt: "Generate plan for refactoring",
    json_schema: schema,
  });

  assert.equal(events.length, 1);
  const resultEvent = events[0] as StreamResult;
  assert.equal(resultEvent.type, "result");
  assert.equal(resultEvent.subtype, "turn_complete");
  assert.deepEqual(resultEvent.structured_output, { plan: ["step 1", "step 2"] });

  // Now run normal chat turn, ensure previous runBuffered did NOT affect history
  let chatBody: any = null;
  setRequestUrlHandler(async (req) => {
    chatBody = JSON.parse(req.body as string);
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Normal chat reply" }] } }],
      }),
      json: {
        candidates: [{ content: { parts: [{ text: "Normal chat reply" }] } }],
      },
      arrayBuffer: new ArrayBuffer(0),
    };
  });

  await runner.sendTurn({ prompt: "Hello chat" });
  assert.equal(chatBody.contents.length, 1);
  assert.equal(chatBody.contents[0].parts[0].text, "Hello chat");

  setRequestUrlHandler(null);
});

test("DirectApiRunner: emits onThinking when reasoning content is returned", async () => {
  setRequestUrlHandler(async () => {
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({
        choices: [
          {
            message: {
              content: "42",
              reasoning_content: "Calculating 6 * 7...",
            },
          },
        ],
      }),
      json: {
        choices: [
          {
            message: {
              content: "42",
              reasoning_content: "Calculating 6 * 7...",
            },
          },
        ],
      },
      arrayBuffer: new ArrayBuffer(0),
    };
  });

  const settings = createTestSettings({
    directApiProvider: "deepseek",
  });
  const runner = await createRunner(settings, { deepseek: "sk-ds-key" });

  let thinkingReceived = "";
  let assistantReceived = "";
  runner.setHandlers({
    onThinking: (t) => {
      thinkingReceived = t;
    },
    onAssistantText: (t) => {
      assistantReceived = t;
    },
  });

  const ok = await runner.sendTurn({ prompt: "What is 6 * 7?" });
  assert.equal(ok, true);
  assert.equal(thinkingReceived, "Calculating 6 * 7...");
  assert.equal(assistantReceived, "42");

  setRequestUrlHandler(null);
});

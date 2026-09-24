import test from "node:test";
import assert from "node:assert/strict";
import { LocalAgentRunner, detectLocalBinary } from "../../src/runtime/localAgentRunner";
import { DEFAULT_SETTINGS } from "../../src/settings/schema";
import { installFakeChildProcess } from "./stubs/fakeChildProcess";
import { overrideRequire } from "./stubs/nodeRequire";

test("detectLocalBinary probes only requested agent family", () => {
  const cp = installFakeChildProcess();
  const restoreFs = overrideRequire("fs", {
    existsSync: (filePath: string) => filePath.endsWith("/agy"),
    realpathSync: (filePath: string) => filePath,
    accessSync: (filePath: string) => {
      if (!filePath.endsWith("/agy")) {
        throw new Error("ENOENT");
      }
    },
    statSync: () => ({ mode: 0o755, isFile: () => true }),
    constants: { X_OK: 1 },
  });

  try {
    // Requesting claude when only agy exists must return null (no fallback to agy)
    const claudeResult = detectLocalBinary("claude");
    assert.equal(claudeResult, null);

    // Requesting agy returns the agy binary path
    const agyResult = detectLocalBinary("agy");
    assert.ok(agyResult && agyResult.endsWith("agy"));
  } finally {
    cp.restore();
    restoreFs();
  }
});

test("LocalAgentRunner with claude delivers prompt on stdin and maps canonical permission mode", async () => {
  const cp = installFakeChildProcess();
  const restoreFs = overrideRequire("fs", {
    existsSync: () => true,
    realpathSync: (p: string) => p,
    accessSync: () => true,
    statSync: () => ({ mode: 0o755, isFile: () => true }),
    constants: { X_OK: 1 },
  });

  try {
    const settings = {
      ...DEFAULT_SETTINGS,
      agent: "claude",
      permissionMode: "plan",
    };
    const runner = new LocalAgentRunner(settings, "/test/vault");
    let resultEvent: any = null;
    let assistantText = "";

    runner.setHandlers({
      onAssistantText: (text) => {
        assistantText += text;
      },
      onResult: (res) => {
        resultEvent = res;
      },
    });

    const sent = await runner.sendTurn({
      agent: "claude",
      prompt: "Hello Claude via stdin",
      permission_mode: "plan",
      model: "claude-custom-v1",
    });

    assert.equal(sent, true);
    assert.equal(cp.spawns.length, 1);

    const spawnCall = cp.spawns[0];
    assert.ok(spawnCall.command.includes("claude"));

    // Argv assertions
    assert.ok(spawnCall.args.includes("--output-format"));
    assert.ok(spawnCall.args.includes("stream-json"));
    assert.ok(spawnCall.args.includes("--verbose"));
    assert.ok(spawnCall.args.includes("--permission-mode"));
    assert.ok(spawnCall.args.includes("plan"));
    assert.ok(spawnCall.args.includes("--model"));
    assert.ok(spawnCall.args.includes("claude-custom-v1"));

    // Prompt MUST NOT be in argv for claude
    assert.equal(spawnCall.args.includes("-p"), false);
    assert.equal(spawnCall.args.includes("Hello Claude via stdin"), false);

    // Prompt MUST be delivered via stdin
    const child = cp.lastChild!;
    assert.equal(child.stdinText(), "Hello Claude via stdin");

    // Simulate stdout response
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello from Claude!" }] },
      }) + "\n"
    );
    child.stdout.write(
      JSON.stringify({
        type: "result",
        subtype: "turn_complete",
        result: "Done",
        duration_ms: 1200,
        usage: { input_tokens: 10, output_tokens: 20 },
        total_cost_usd: 0.005,
      }) + "\n"
    );
    child.exit(0);

    assert.equal(assistantText, "Hello from Claude!");
    assert.ok(resultEvent);
    assert.equal(resultEvent.result, "Done");
    assert.equal(resultEvent.duration_ms, 1200);
    assert.equal(resultEvent.total_cost_usd, 0.005);
    assert.deepEqual(resultEvent.usage, { input_tokens: 10, output_tokens: 20 });
  } finally {
    cp.restore();
    restoreFs();
  }
});

test("LocalAgentRunner with agy CLI passes -p=prompt and rejects prompts > 100 KiB", async () => {
  const cp = installFakeChildProcess();
  const restoreFs = overrideRequire("fs", {
    existsSync: () => true,
    realpathSync: (p: string) => p,
    accessSync: () => true,
    statSync: () => ({ mode: 0o755, isFile: () => true }),
    constants: { X_OK: 1 },
  });

  try {
    const settings = {
      ...DEFAULT_SETTINGS,
      agent: "agy",
      permissionMode: "plan",
    };
    const runner = new LocalAgentRunner(settings, "/test/vault");
    let errorMsg = "";
    runner.setHandlers({
      onError: (err) => {
        errorMsg = err;
      },
    });

    // 1. Normal prompt under 100 KiB
    const sent = await runner.sendTurn({
      agent: "agy",
      prompt: "Small agy prompt",
      permission_mode: "plan",
    });
    assert.equal(sent, true);
    assert.equal(cp.spawns.length, 1);
    const spawnCall = cp.spawns[0];
    assert.ok(spawnCall.command.includes("agy"));
    assert.ok(spawnCall.args.includes("-p=Small agy prompt"));
    assert.ok(spawnCall.args.includes("--mode"));
    assert.ok(spawnCall.args.includes("plan"));
    cp.lastChild!.exit(0);

    // 2. Large prompt exceeding 100 KiB
    const largePrompt = "X".repeat(101 * 1024);
    const sentLarge = await runner.sendTurn({
      agent: "agy",
      prompt: largePrompt,
    });
    assert.equal(sentLarge, false);
    assert.ok(errorMsg.includes("100 KiB"));
  } finally {
    cp.restore();
    restoreFs();
  }
});

test("LocalAgentRunner interrupt signals SIGINT", async () => {
  const cp = installFakeChildProcess();
  const restoreFs = overrideRequire("fs", {
    existsSync: () => true,
    realpathSync: (p: string) => p,
    accessSync: () => true,
    statSync: () => ({ mode: 0o755, isFile: () => true }),
    constants: { X_OK: 1 },
  });

  try {
    const settings = {
      ...DEFAULT_SETTINGS,
      agent: "claude",
    };
    const runner = new LocalAgentRunner(settings, "/test/vault");
    let statusState = "";
    runner.setHandlers({
      onStatus: (st) => {
        statusState = st.state;
      },
    });

    await runner.sendTurn({
      agent: "claude",
      prompt: "Long running turn",
    });

    assert.equal(runner.isTurnActive, true);
    const child = cp.lastChild!;
    runner.interrupt();

    assert.ok(child.signals.includes("SIGINT"));
    assert.equal(statusState, "interrupted");
    assert.equal(runner.isTurnActive, false);
    child.exit(0);
  } finally {
    cp.restore();
    restoreFs();
  }
});

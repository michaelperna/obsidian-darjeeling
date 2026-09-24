import assert from "node:assert";
import test from "node:test";
import { notices } from "./stubs/obsidian";
import {
  DarjeelingPlan,
  PlanPhase,
  normaliseFindings,
  normalisePlan,
  planFromMarkdown,
  planToMarkdown,
  planToMarkdownBody,
  validatePlan,
} from "../../src/ui/plan/planTypes";
import {
  draftPlan,
  handOffPhase,
  phaseBrief,
  runStructured,
  verifyPlan,
} from "../../src/ui/plan/planRunner";
import type { AgentEvent, StreamResult } from "../../src/net/agentClient";

function makeSamplePlan(id = "plan-1", title = "Sprint 2 Architecture"): DarjeelingPlan {
  return {
    id,
    title,
    intent: "Implement session follow-you mechanics across all runtimes",
    createdAt: "2026-09-23T10:00:00.000Z",
    updatedAt: "2026-09-23T10:00:00.000Z",
    model: "claude-3-7-sonnet",
    effort: "high",
    phases: [
      {
        id: "p1",
        name: "Pairing and Auth",
        intent: "Establish secure device authentication",
        status: "done",
        executedAt: "2026-09-23T10:30:00.000Z",
        executedBy: "local-claude",
        tasks: [
          { id: "t1", text: "Create pairing endpoint", files: ["server/auth.py"], done: true },
          { id: "t2", text: "Validate pairing tokens", files: ["src/net/pairing.ts"], done: true },
        ],
      },
      {
        id: "p2",
        name: "Plan Engine Hardening",
        intent: "Enforce contract tests and capability gating",
        status: "active",
        tasks: [
          { id: "t3", text: "Implement runStructured contract", files: ["src/ui/plan/planRunner.ts"], done: false },
        ],
      },
    ],
    findings: [],
  };
}

function createMockPlugin(mode = "remote", perm = "acceptEdits") {
  const settings = {
    runtimeMode: mode,
    permissionMode: perm,
    agent: "claude",
    model: "claude-3-7-sonnet",
    effort: "high",
    remoteCwd: "/workspace/darjeeling",
    currentPlan: undefined as DarjeelingPlan | undefined,
    attachActiveNote: false,
    autoPullArtifacts: false,
    partialMessages: true,
  };

  const plugin: any = {
    settings,
    saveSettings: async () => {},
    setMode: () => {},
    noteInChat: () => {},
    prefillChat: () => {},
    setBusy: () => {},
    vaultHarness: {
      loadHarness: async () => ({ systemPrompt: "Harness prompt" }),
    },
    app: {
      workspace: { getActiveFile: () => null },
      vault: {
        adapter: { getBasePath: () => "/local/vault" },
        getFileByPath: () => null,
        getAbstractFileByPath: () => null,
      },
    },
    runBufferedTurn: async () => [],
  };

  return plugin;
}

// ----------------------------------------------------------------- Contract tests
test("runStructured: prefers result.structured_output over prose and result text (PD-02)", async () => {
  const plugin = createMockPlugin("local");
  const client: any = {
    getEffectiveRuntimeMode: () => "local",
    isTurnActive: false,
  };

  const expectedData = { title: "From Structured Output", phases: [] };
  plugin.runBufferedTurn = async () => [
    {
      type: "result",
      result: '{"title": "From Result String"}',
      structured_output: expectedData,
      is_error: false,
    } as StreamResult,
  ];

  const output = await runStructured(plugin, client, "Prompt", {} as any, "plan");
  assert.deepStrictEqual(output, expectedData);
});

test("runStructured: falls back to parseLooseJson when structured_output is absent (G-01)", async () => {
  const plugin = createMockPlugin("direct-api");
  const client: any = {
    getEffectiveRuntimeMode: () => "direct-api",
    isTurnActive: false,
  };

  const prose = 'Here is the plan:\n```json\n{"title": "From Loose JSON", "phases": []}\n```\nEnjoy!';
  plugin.runBufferedTurn = async () => [
    {
      type: "result",
      result: prose,
      is_error: false,
    } as StreamResult,
  ];

  const output = await runStructured(plugin, client, "Prompt", {} as any, "plan");
  assert.deepStrictEqual(output, { title: "From Loose JSON", phases: [] });
});

test("runStructured: surfaces error with buffered transcript on is_error (PD-31)", async () => {
  notices.length = 0;
  const plugin = createMockPlugin("local");
  const client: any = {
    getEffectiveRuntimeMode: () => "local",
    isTurnActive: false,
  };

  plugin.runBufferedTurn = async () => [
    { type: "text_delta", text: "Failed to compile prompt\n" },
    {
      type: "result",
      result: "Context length exceeded",
      is_error: true,
    } as StreamResult,
  ];

  const output = await runStructured(plugin, client, "Prompt", {} as any, "plan");
  assert.strictEqual(output, null);
  assert.ok(notices.some((n) => n.includes("plan failed: Context length exceeded")));
});

test("runStructured: uses remote async turn polling and captures turn ID (PD-23)", async () => {
  const plugin = createMockPlugin("remote");
  let capturedTurnId: string | null = null;

  const client: any = {
    getEffectiveRuntimeMode: () => "remote",
    isTurnActive: false,
    startAsyncTurn: async () => ({ turn_id: "turn-remote-999" }),
    pollTurn: async () => {
      return {
        events: [
          {
            type: "result",
            result: "",
            structured_output: { title: "Remote Plan", phases: [] },
            is_error: false,
          } as StreamResult,
        ],
        is_active: false,
        latest_seq: 1,
      };
    },
  };

  const output = await runStructured(
    plugin,
    client,
    "Prompt",
    {} as any,
    "plan",
    (turnId) => {
      capturedTurnId = turnId;
    }
  );

  assert.strictEqual(capturedTurnId, "turn-remote-999");
  assert.deepStrictEqual(output, { title: "Remote Plan", phases: [] });
});

// ----------------------------------------------------------------- Normalisation & Validation
test("normalisePlan: type-checks, coerces tasks, and strips malformed fields (PD-08, PD-33)", () => {
  const raw = {
    title: 12345, // coerce to string
    intent: null,
    phases: [
      {
        name: "Phase 1",
        intent: "Do stuff",
        tasks: [
          "Bare string task",
          { text: "Object task", files: ["valid.ts", 42, null], done: 1 },
          null, // ignored
        ],
      },
      null, // ignored
    ],
  };

  const plan = normalisePlan(raw, { model: "test-model", effort: "low" });
  assert.ok(plan);
  assert.strictEqual(plan.title, "12345");
  assert.strictEqual(plan.phases.length, 1);
  assert.strictEqual(plan.phases[0].tasks.length, 2);
  assert.strictEqual(plan.phases[0].tasks[0].text, "Bare string task");
  assert.strictEqual(plan.phases[0].tasks[0].done, false);
  assert.strictEqual(plan.phases[0].tasks[1].text, "Object task");
  assert.deepStrictEqual(plan.phases[0].tasks[1].files, ["valid.ts"]);
  assert.strictEqual(plan.phases[0].tasks[1].done, true);
});

test("validatePlan: checks schema and discards invalid stored plans (PD-33)", () => {
  assert.strictEqual(validatePlan(null), null);
  assert.strictEqual(validatePlan(undefined), null);
  assert.strictEqual(validatePlan("not-an-object"), null);
  assert.strictEqual(validatePlan({}), null);
  assert.strictEqual(validatePlan({ title: "No phases" }), null);

  const valid = makeSamplePlan();
  const loaded = validatePlan(valid);
  assert.ok(loaded);
  assert.strictEqual(loaded.id, valid.id);
  assert.strictEqual(loaded.phases.length, 2);
});

// ----------------------------------------------------------------- Lossless Artifact Roundtrip
test("plan artifact round-trip: embeds machine payload and recovers with 100% fidelity (PD-09, PD-32)", () => {
  const original = makeSamplePlan();
  original.findings = [
    {
      id: "f1",
      severity: "critical",
      title: "Broken route",
      detail: "Line 1\nLine 2 indented\nLine 3",
      where: "server/routes.py:42",
    },
  ];

  const markdown = planToMarkdown(original);

  // PD-32: String frontmatter values are quoted
  assert.ok(markdown.includes('type: "darjeeling-plan"'));
  assert.ok(markdown.includes('plan-id: "plan-1"'));
  assert.ok(markdown.includes('title: "Sprint 2 Architecture"'));

  // PD-09: Embedded fenced machine payload
  assert.ok(markdown.includes("```darjeeling-plan"));

  // Recover from markdown
  const recovered = planFromMarkdown(markdown);
  assert.ok(recovered);
  assert.strictEqual(recovered.id, original.id);
  assert.strictEqual(recovered.title, original.title);
  assert.strictEqual(recovered.phases.length, 2);
  assert.strictEqual(recovered.phases[0].tasks[0].done, true);
  assert.strictEqual(recovered.phases[0].executedBy, "local-claude");
  assert.strictEqual(recovered.findings.length, 1);
  assert.strictEqual(recovered.findings[0].severity, "critical");

  // CORE-02, PD-18: planToMarkdownBody strips frontmatter and fenced payload
  const body = planToMarkdownBody(original);
  assert.ok(!body.includes("---"));
  assert.ok(!body.includes("```darjeeling-plan"));
  assert.ok(body.includes("Phase 1 — Pairing and Auth"));
  assert.ok(body.includes("- [x] Create core module") || body.includes("- [x] Create pairing endpoint"));
});

// ----------------------------------------------------------------- Gating & State Machine
test("handOffPhase: direct API cannot hand off phases (PD-07)", async () => {
  notices.length = 0;
  const plugin = createMockPlugin("direct-api");
  const client: any = {
    getEffectiveRuntimeMode: () => "direct-api",
    connectionState: "open",
    isTurnActive: false,
  };
  const plan = makeSamplePlan();

  const ok = await handOffPhase(plugin, client, plan, plan.phases[1], 1);
  assert.strictEqual(ok, false);
  assert.ok(notices.some((n) => n.includes("Direct API mode can draft plans, but cannot execute phases")));
  // Status must remain unchanged
  assert.strictEqual(plan.phases[1].status, "active");
});

test("handOffPhase: checks preconditions before mutating phase status (PD-29)", async () => {
  notices.length = 0;
  const plugin = createMockPlugin("remote", "plan"); // plan-only mode
  const client: any = {
    getEffectiveRuntimeMode: () => "remote",
    connectionState: "open",
    isTurnActive: false,
  };
  const plan = makeSamplePlan();
  plan.phases[1].status = "pending";

  const ok = await handOffPhase(plugin, client, plan, plan.phases[1], 1);
  assert.strictEqual(ok, false);
  assert.strictEqual(plan.phases[1].status, "pending"); // Not mutated!
  assert.ok(notices.some((n) => n.includes("Permission mode is 'Plan only'")));
});

test("handOffPhase: executes successfully, advances phases, and records metadata (PD-29)", async () => {
  const plugin = createMockPlugin("remote", "acceptEdits");
  let sentTurnOpts: any = null;
  const client: any = {
    getEffectiveRuntimeMode: () => "remote",
    connectionState: "open",
    isTurnActive: false,
    resumeId: "session-abc",
    sendTurn: async (opts: any) => {
      sentTurnOpts = opts;
      return true;
    },
  };
  const plan = makeSamplePlan();
  plan.phases[1].status = "pending";

  const ok = await handOffPhase(plugin, client, plan, plan.phases[1], 1);
  assert.strictEqual(ok, true);
  assert.strictEqual(plan.phases[1].status, "active");
  assert.ok(plan.phases[1].executedAt);
  assert.strictEqual(plan.phases[1].executedBy, "session-abc");
  assert.ok(sentTurnOpts.prompt.includes("Implement phase 2"));
});

test("verifyPlan: gated on direct API and executed phases (PD-07, PD-29)", async () => {
  notices.length = 0;
  const directPlugin = createMockPlugin("direct-api");
  const directClient: any = { getEffectiveRuntimeMode: () => "direct-api" };
  const plan = makeSamplePlan();

  const directRes = await verifyPlan(directPlugin, directClient, plan);
  assert.strictEqual(directRes, null);
  assert.ok(notices.some((n) => n.toLowerCase().includes("direct api mode")));

  // Unexecuted plan in remote mode
  notices.length = 0;
  const remotePlugin = createMockPlugin("remote");
  const remoteClient: any = {
    getEffectiveRuntimeMode: () => "remote",
    isTurnActive: false,
  };
  const unexecutedPlan = makeSamplePlan();
  unexecutedPlan.phases.forEach((p) => {
    p.status = "pending";
    p.executedAt = undefined;
  });

  const unexecutedRes = await verifyPlan(remotePlugin, remoteClient, unexecutedPlan);
  assert.strictEqual(unexecutedRes, null);
  assert.ok(notices.some((n) => n.includes("No phases have been executed yet")));
});

test("draftPlan: re-plan carries over completed tasks and earlier context (PD-24)", async () => {
  const plugin = createMockPlugin("local");
  let sentPrompt = "";
  const client: any = {
    getEffectiveRuntimeMode: () => "local",
    isTurnActive: false,
  };

  const previous = makeSamplePlan();
  previous.findings = [
    { id: "f1", severity: "major", title: "Route missing", detail: "404 on /pair" },
  ];

  plugin.runBufferedTurn = async (opts: any) => {
    sentPrompt = opts.prompt;
    return [
      {
        type: "result",
        result: "",
        structured_output: {
          title: "Revised Sprint 2",
          intent: "Updated intent",
          phases: [
            {
              name: "Revised Phase 1",
              tasks: [
                { text: "Create pairing endpoint", files: ["server/auth.py"] }, // was done in previous!
                { text: "New Task", files: [] },
              ],
            },
          ],
        },
        is_error: false,
      } as StreamResult,
    ];
  };

  const newPlan = await draftPlan(plugin, client, "Update auth", "Context", previous);
  assert.ok(newPlan);
  // Prompt contains earlier findings
  assert.ok(sentPrompt.includes("Earlier plan: Sprint 2 Architecture"));
  assert.ok(sentPrompt.includes("Route missing: 404 on /pair"));

  // Completed task carried over
  assert.strictEqual(newPlan.phases[0].tasks[0].done, true);
  assert.strictEqual(newPlan.phases[0].tasks[1].done, false);
});

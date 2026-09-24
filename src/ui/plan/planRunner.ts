import { FileSystemAdapter, Notice } from "obsidian";
import type DarjeelingPlugin from "../../main";
import type { AgentClient, AgentEvent, StreamResult, TurnOptions } from "../../net/agentClient";
import {
  DarjeelingPlan,
  Finding,
  PLAN_SCHEMA,
  PlanPhase,
  VERIFY_SCHEMA,
  normaliseFindings,
  normalisePlan,
} from "./planTypes";

function getVaultBasePath(adapter: unknown): string {
  if (adapter instanceof FileSystemAdapter) {
    return adapter.getBasePath();
  }
  return "";
}

export function parseLooseJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* fall through */
    }
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      return null;
    }
  }
  return null;
}

export async function runStructured(
  plugin: DarjeelingPlugin,
  client: AgentClient,
  prompt: string,
  schema: unknown,
  label: string,
  onTurnId?: (turnId: string) => void
): Promise<unknown> {
  const settings = plugin.settings;
  const localVaultPath = getVaultBasePath(plugin.app.vault.adapter);
  const mode = client.getEffectiveRuntimeMode?.() ?? settings.runtimeMode;
  const targetCwd =
    mode === "remote" ? (settings.remoteCwd || undefined) : (localVaultPath || undefined);
  const activeFile = plugin.app.workspace.getActiveFile();
  const harness = await plugin.vaultHarness.loadHarness(activeFile?.path);

  const turnOpts: TurnOptions = {
    agent: settings.agent,
    prompt,
    model: settings.model || undefined,
    fallback_model: settings.fallbackModel || undefined,
    effort: settings.effort || undefined,
    permission_mode: "plan",
    cwd: targetCwd,
    append_system_prompt: harness.systemPrompt || undefined,
    json_schema: schema as Record<string, unknown>,
    is_plan_turn: true,
    is_buffered_turn: true,
  };

  try {
    let events: AgentEvent[] | null = null;

    // PD-23: For long plan passes in remote mode, prefer async REST turn so another device can reattach
    if (mode === "remote" && typeof client.startAsyncTurn === "function") {
      const asyncRes = await client.startAsyncTurn(turnOpts);
      if (asyncRes?.turn_id) {
        onTurnId?.(asyncRes.turn_id);
        const collected: AgentEvent[] = [];
        let seq = 0;
        while (true) {
          const poll = await client.pollTurn(asyncRes.turn_id, seq, 25);
          if (!poll) break;
          if (Array.isArray(poll.events)) {
            collected.push(...poll.events);
          }
          seq = poll.latest_seq;
          if (!poll.is_active) {
            events = collected;
            break;
          }
        }
      }
    }

    if (!events) {
      events = await plugin.runBufferedTurn(turnOpts);
    }

    if (!events) {
      new Notice(`${label} failed: the host did not respond.`);
      return null;
    }

    const error = events.find((e) => e.type === "dj.error") as
      | { message?: string }
      | undefined;
    if (error) {
      new Notice(`${label} failed: ${error.message ?? "unknown error"}`);
      return null;
    }

    const result = events.find((e) => e.type === "result") as StreamResult | undefined;
    if (!result) {
      new Notice(`${label} produced no result.`);
      return null;
    }

    // PD-31: is_error results shown with the buffered transcript
    if (result.is_error) {
      const errDetail = result.result?.trim() || "The model or agent reported an error.";
      new Notice(`${label} failed: ${errDetail}`);
      return null;
    }

    // PD-02: Prefer structured_output, fallback to parseLooseJson(result.result)
    if (result.structured_output !== undefined && result.structured_output !== null) {
      return result.structured_output;
    }

    if (result.result) {
      const parsed = parseLooseJson(result.result);
      if (parsed !== null) return parsed;
    }

    new Notice(`${label} produced no result.`);
    return null;
  } catch (err) {
    new Notice(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function phaseBrief(plan: DarjeelingPlan, phase: PlanPhase, index: number): string {
  const lines = [
    `Implement phase ${index + 1} of the plan "${plan.title}", and only this phase.`,
    "",
    `Phase: ${phase.name}`,
    phase.intent ? `Goal: ${phase.intent}` : "",
    "",
    "Tasks:",
  ];
  phase.tasks.forEach((task, i) => {
    lines.push(
      `${i + 1}. ${task.text}` +
        (task.files.length ? ` — files: ${task.files.join(", ")}` : "")
    );
  });
  lines.push(
    "",
    "Do not start later phases. If a task turns out to be wrong or impossible,",
    "stop and say so rather than improvising around it.",
    "When you are done, list what you changed, file by file."
  );
  return lines.filter((line) => line !== "").join("\n");
}

export function advanceActivePhase(plan: DarjeelingPlan, keepActive?: string): void {
  let assigned = false;
  for (const phase of plan.phases) {
    if (phase.id === keepActive) {
      assigned = true;
      continue;
    }
    if (phase.status === "done") continue;
    if (!assigned) {
      phase.status = "active";
      assigned = true;
    } else if (phase.status === "active") {
      phase.status = "pending";
    }
  }
}

export async function handOffPhase(
  plugin: DarjeelingPlugin,
  client: AgentClient,
  plan: DarjeelingPlan,
  phase: PlanPhase,
  index: number
): Promise<boolean> {
  const mode = client.getEffectiveRuntimeMode?.() ?? plugin.settings.runtimeMode;
  if (mode === "direct-api") {
    new Notice("Direct API mode can draft plans, but cannot execute phases or edit files. Copy the phase brief instead.");
    return false;
  }

  const settings = plugin.settings;

  // PD-29: Validate all preconditions BEFORE mutating phase status
  if (settings.permissionMode === "plan") {
    new Notice(
      "Permission mode is 'Plan only', so the agent cannot make changes. " +
        "Switch it in the header to hand off."
    );
    return false;
  }

  if (client.connectionState !== "open") {
    new Notice("Not connected to the host.");
    return false;
  }

  if (client.isTurnActive) {
    new Notice("A turn is already running. Please wait for it to finish or interrupt it.");
    return false;
  }

  phase.status = "active";
  advanceActivePhase(plan, phase.id);
  plan.updatedAt = new Date().toISOString();

  plugin.setMode("chat");
  plugin.noteInChat(
    `**Handing off phase ${index + 1} — ${phase.name}**\n\n` +
      `Permission mode: \`${settings.permissionMode}\` · Model: ` +
      `\`${settings.model || "default"}\``
  );

  const localVaultPath = getVaultBasePath(plugin.app.vault.adapter);
  const targetCwd =
    mode === "remote" ? (settings.remoteCwd || undefined) : (localVaultPath || undefined);
  const activeFile = plugin.app.workspace.getActiveFile();
  const harness = await plugin.vaultHarness.loadHarness(activeFile?.path);

  const sent = await client.sendTurn({
    agent: settings.agent,
    prompt: phaseBrief(plan, phase, index),
    model: settings.model || undefined,
    fallback_model: settings.fallbackModel || undefined,
    effort: settings.effort || undefined,
    permission_mode: settings.permissionMode,
    cwd: targetCwd,
    append_system_prompt: harness.systemPrompt || undefined,
    partial_messages: settings.partialMessages,
  });

  if (!sent) return false;

  phase.executedAt = new Date().toISOString();
  phase.executedBy = client.resumeId ?? plugin.settings.agent;
  return true;
}

export async function draftPlan(
  plugin: DarjeelingPlugin,
  client: AgentClient,
  intent: string,
  vaultContextPrompt: string,
  previous?: DarjeelingPlan,
  onTurnId?: (turnId: string) => void
): Promise<DarjeelingPlan | null> {
  const settings = plugin.settings;

  const promptParts = [
    "You are decomposing a piece of work into reviewable phases.",
    "",
    `Objective: ${intent}`,
    vaultContextPrompt,
    "",
    "Rules:",
    "- Between 1 and 8 phases (typically 2 to 6). Each must be independently reviewable and leave things in a working state.",
    "- Order them so that earlier phases do not depend on later ones.",
    "- Tasks must be concrete changes, not restatements of the objective.",
    "- Name the files each task touches where you can determine them. Read the",
    "  working directory to find out rather than guessing.",
    "- If the objective is ambiguous, pick the most defensible reading and",
    "  state it in the intent field.",
  ];

  // PD-24: Re-planning includes previous plan and verification findings
  if (previous) {
    promptParts.push(
      "",
      "This replaces an earlier plan. Carry over tasks and phases that still hold; fix or replace what did not.",
      "",
      `Earlier plan: ${previous.title}`,
      previous.intent ? `Earlier intent: ${previous.intent}` : "",
      "Earlier phases and tasks:",
      ...previous.phases.map((p, idx) => {
        const tasks = p.tasks
          .map((t) => `    - [${t.done ? "x" : " "}] ${t.text}${t.files.length ? ` (files: ${t.files.join(", ")})` : ""}`)
          .join("\n");
        return `  Phase ${idx + 1}: ${p.name} [status: ${p.status}]\n${tasks}`;
      })
    );
    if (previous.findings && previous.findings.length > 0) {
      promptParts.push(
        "",
        "Findings from verification of the earlier plan to fix:",
        ...previous.findings.map((f) => `  - [${f.severity.toUpperCase()}] ${f.title}: ${f.detail}`)
      );
    }
  }

  promptParts.push("", "Return only JSON matching the provided schema.");
  const prompt = promptParts.filter((p) => p !== "").join("\n");

  const result = await runStructured(plugin, client, prompt, PLAN_SCHEMA, "plan", onTurnId);
  if (!result) return null;

  const plan = normalisePlan(result, {
    model: settings.model || "default",
    effort: settings.effort,
  });
  if (!plan) {
    new Notice("The agent did not return a usable plan. See chat for its reply.");
    return null;
  }

  if (previous) {
    if (previous.artifactPath) plan.artifactPath = previous.artifactPath;
    // PD-24: Carry over completed tasks to the newly drafted plan
    const doneTasks = new Set(
      previous.phases
        .flatMap((p) => p.tasks)
        .filter((t) => t.done)
        .map((t) => t.text.toLowerCase().trim())
    );
    for (const phase of plan.phases) {
      for (const task of phase.tasks) {
        if (doneTasks.has(task.text.toLowerCase().trim())) {
          task.done = true;
        }
      }
    }
  }

  return plan;
}

export async function verifyPlan(
  plugin: DarjeelingPlugin,
  client: AgentClient,
  plan: DarjeelingPlan,
  onTurnId?: (turnId: string) => void
): Promise<Finding[] | null> {
  const mode = client.getEffectiveRuntimeMode?.() ?? plugin.settings.runtimeMode;
  if (mode === "direct-api") {
    new Notice("Verification requires file inspection, which is not available in direct API mode.");
    return null;
  }

  const executed = plan.phases.filter((p) => p.status === "done" || p.executedAt);
  if (executed.length === 0) {
    new Notice("No phases have been executed yet to verify.");
    return null;
  }

  const prompt = [
    "Verify an implementation against the plan it was supposed to follow.",
    "",
    `Plan: ${plan.title}`,
    plan.intent ? `Intent: ${plan.intent}` : "",
    "",
    "Phases that were handed off:",
    ...executed.map((phase, i) => {
      const tasks = phase.tasks
        .map((task) => `    - ${task.text}${task.files.length ? ` [${task.files.join(", ")}]` : ""}`)
        .join("\n");
      return `  ${i + 1}. ${phase.name}\n${tasks}`;
    }),
    "",
    "Inspect the working directory and judge what was actually done. For each",
    "discrepancy emit a finding:",
    "  critical — the change breaks something or contradicts the plan",
    "  major    — a planned item is missing or implemented wrongly",
    "  minor    — cosmetic or stylistic divergence",
    "  outdated — the plan item no longer applies, and why",
    "",
    "Report only what you verified by reading files. Do not speculate. If the",
    "implementation is faithful, return an empty findings array.",
    "",
    "Return only JSON matching the provided schema.",
  ]
    .filter((line) => line !== "")
    .join("\n");

  const result = await runStructured(plugin, client, prompt, VERIFY_SCHEMA, "verification", onTurnId);
  if (!result) return null;

  return normaliseFindings(result);
}

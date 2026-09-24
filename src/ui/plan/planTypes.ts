/**
 * The Traycer layer's data model.
 *
 * Traycer's pipeline is intent -> Phases (decomposition) -> Plans (tactical,
 * file-level) -> Handoff (to a coding agent) -> Verification (implementation
 * compared against the plan, findings graded). v2 reduced all of that to four
 * buttons that prepended a sentence to the composer.
 *
 * The one adaptation worth making: Traycer keeps artifacts in its own store,
 * and we already have Obsidian. Plans and verifications are vault notes, so
 * they are searchable, linkable and survive the plugin.
 */

export type PhaseStatus = "pending" | "active" | "done";
export type Severity = "critical" | "major" | "minor" | "outdated";

export interface PlanTask {
  id: string;
  text: string;
  /** Files the task expects to touch. Traycer's plans are file-level. */
  files: string[];
  done: boolean;
}

export interface PlanPhase {
  id: string;
  name: string;
  /** Why this phase exists and what "finished" means for it. */
  intent: string;
  tasks: PlanTask[];
  status: PhaseStatus;
  /** Agent session that executed this phase, for audit. */
  executedBy?: string;
  executedAt?: string;
}

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  where?: string;
}

export interface DarjeelingPlan {
  id: string;
  title: string;
  intent: string;
  createdAt: string;
  updatedAt: string;
  /** Model that produced the plan, so a re-plan on a different model is visible. */
  model?: string;
  effort?: string;
  phases: PlanPhase[];
  findings: Finding[];
  /** Vault path of the artifact note, once written. */
  artifactPath?: string;
  /** Active remote turn ID for async turn recovery (PD-23). */
  activeTurnId?: string;
}

export const SEVERITY_ORDER: Severity[] = ["critical", "major", "minor", "outdated"];

/**
 * Schema handed to the CLI's --json-schema so the plan comes back parseable
 * instead of as prose we would have to scrape.
 */
export const PLAN_SCHEMA = {
  type: "object",
  required: ["title", "phases"],
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "Short imperative title for the work." },
    intent: {
      type: "string",
      description: "One paragraph: what done looks like and why it matters.",
    },
    phases: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        required: ["name", "intent", "tasks"],
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          intent: {
            type: "string",
            description: "What this phase achieves and its completion condition.",
          },
          tasks: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["text"],
              additionalProperties: false,
              properties: {
                text: { type: "string", description: "One concrete change." },
                files: {
                  type: "array",
                  items: { type: "string" },
                  description: "Paths this task touches, relative to the working dir.",
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

export const VERIFY_SCHEMA = {
  type: "object",
  required: ["findings"],
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "title", "detail"],
        additionalProperties: false,
        properties: {
          severity: {
            type: "string",
            enum: ["critical", "major", "minor", "outdated"],
            description:
              "critical: breaks or contradicts the plan. major: plan item " +
              "missed or wrong. minor: cosmetic. outdated: plan item no " +
              "longer applies.",
          },
          title: { type: "string" },
          detail: { type: "string" },
          where: { type: "string", description: "file:line or file path" },
        },
      },
    },
  },
} as const;

let counter = 0;
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/**
 * Normalises raw model output or loaded plan data into a typed DarjeelingPlan.
 * Coerces and type-checks every field to prevent unhandled exceptions (PD-08, PD-33).
 */
export function normalisePlan(
  raw: unknown,
  meta: { model?: string; effort?: string }
): DarjeelingPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;

  const rawPhases: unknown[] = Array.isArray(data.phases) ? (data.phases as unknown[]) : [];
  if (rawPhases.length === 0) return null;

  const now = new Date().toISOString();
  const validPhases: PlanPhase[] = [];

  for (let index = 0; index < rawPhases.length; index++) {
    const rawPhase: unknown = rawPhases[index];
    if (!rawPhase || typeof rawPhase !== "object") continue;
    const p = rawPhase as Record<string, unknown>;

    const phaseName =
      typeof p.name === "string" && p.name.trim()
        ? p.name.trim()
        : typeof p.title === "string" && p.title.trim()
        ? p.title.trim()
        : `Phase ${index + 1}`;

    const phaseIntent =
      typeof p.intent === "string"
        ? p.intent.trim()
        : typeof p.description === "string"
        ? p.description.trim()
        : "";

    const rawTasks: unknown[] = Array.isArray(p.tasks) ? (p.tasks as unknown[]) : [];
    const validTasks: PlanTask[] = [];

    for (let tIdx = 0; tIdx < rawTasks.length; tIdx++) {
      const rawTask: unknown = rawTasks[tIdx];
      let taskText = "";
      let taskFiles: string[] = [];
      let isDone = false;

      if (typeof rawTask === "string" && rawTask.trim()) {
        taskText = rawTask.trim();
      } else if (rawTask && typeof rawTask === "object") {
        const t = rawTask as Record<string, unknown>;
        if (typeof t.text === "string" && t.text.trim()) {
          taskText = t.text.trim();
        } else if (typeof t.title === "string" && t.title.trim()) {
          taskText = t.title.trim();
        } else if (typeof t.name === "string" && t.name.trim()) {
          taskText = t.name.trim();
        }
        if (Array.isArray(t.files)) {
          taskFiles = t.files
            .filter((f): f is string => typeof f === "string" && !!f.trim())
            .map((f) => f.trim());
        }
        isDone = Boolean(t.done);
      }

      if (taskText) {
        validTasks.push({
          id:
            rawTask && typeof rawTask === "object" && typeof (rawTask as Record<string, unknown>).id === "string"
              ? ((rawTask as Record<string, unknown>).id as string)
              : newId("task"),
          text: taskText,
          files: taskFiles,
          done: isDone,
        });
      }
    }

    const phaseStatus: PhaseStatus =
      p.status === "done" || p.status === "active" || p.status === "pending"
        ? p.status
        : validPhases.length === 0
        ? "active"
        : "pending";

    validPhases.push({
      id: typeof p.id === "string" && p.id.trim() ? p.id.trim() : newId("phase"),
      name: phaseName,
      intent: phaseIntent,
      status: phaseStatus,
      tasks: validTasks,
      executedBy: typeof p.executedBy === "string" ? p.executedBy : undefined,
      executedAt: typeof p.executedAt === "string" ? p.executedAt : undefined,
    });
  }

  if (validPhases.length === 0) return null;

  const title =
    typeof data.title === "string" && data.title.trim()
      ? data.title.trim()
      : typeof data.title === "number"
      ? String(data.title)
      : "Untitled plan";

  const intent =
    typeof data.intent === "string"
      ? data.intent.trim()
      : typeof data.description === "string"
      ? data.description.trim()
      : "";

  const planId =
    typeof data.id === "string" && data.id.trim() ? data.id.trim() : newId("plan");

  const createdAt =
    typeof data.createdAt === "string" && data.createdAt ? data.createdAt : now;
  const updatedAt =
    typeof data.updatedAt === "string" && data.updatedAt ? data.updatedAt : now;

  return {
    id: planId,
    title,
    intent,
    createdAt,
    updatedAt,
    model: typeof meta.model === "string" ? meta.model : typeof data.model === "string" ? data.model : undefined,
    effort: typeof meta.effort === "string" ? meta.effort : typeof data.effort === "string" ? data.effort : undefined,
    phases: validPhases,
    findings: normaliseFindings(data.findings ? { findings: data.findings } : raw),
    artifactPath: typeof data.artifactPath === "string" ? data.artifactPath : undefined,
    activeTurnId: typeof data.activeTurnId === "string" ? data.activeTurnId : undefined,
  };
}

/**
 * Validates a loaded plan (e.g. from plugin settings), guaranteeing memory safety (PD-33).
 */
export function validatePlan(raw: unknown): DarjeelingPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const plan = normalisePlan(raw, {});
  if (!plan || !plan.phases.length) return null;
  return plan;
}

export function normaliseFindings(raw: unknown): Finding[] {
  if (!raw || typeof raw !== "object") return [];
  const list = Array.isArray(raw)
    ? raw
    : (raw as { findings?: unknown }).findings;
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const finding = item as Record<string, unknown>;
      const rawSev = typeof finding.severity === "string" ? finding.severity.toLowerCase() : "";
      const severity: Severity = SEVERITY_ORDER.includes(rawSev as Severity)
        ? (rawSev as Severity)
        : "minor";
      return {
        id: typeof finding.id === "string" && finding.id ? finding.id : newId("finding"),
        severity,
        title: typeof finding.title === "string" && finding.title.trim() ? finding.title.trim() : "Untitled finding",
        detail: typeof finding.detail === "string" ? finding.detail.trim() : "",
        where: typeof finding.where === "string" ? finding.where.trim() : undefined,
      };
    })
    .sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
    );
}

/** Render a plan as an Obsidian note with embedded machine-readable payload (PD-09, PD-32). */
export function planToMarkdown(plan: DarjeelingPlan): string {
  const done = plan.phases.filter((p) => p.status === "done").length;
  const lines: string[] = [
    "---",
    'type: "darjeeling-plan"',
    `plan-id: "${plan.id}"`,
    `title: ${JSON.stringify(plan.title)}`,
    `created: "${plan.createdAt}"`,
    `updated: "${plan.updatedAt}"`,
    `model: ${JSON.stringify(plan.model ?? "unknown")}`,
    `effort: ${JSON.stringify(plan.effort ?? "unknown")}`,
    `phases: ${plan.phases.length}`,
    `phases-done: ${done}`,
    "tags:",
    '  - "darjeeling/plan"',
    '  - "ai/plan"',
    "---",
    "",
    `# ${plan.title}`,
    "",
  ];

  if (plan.intent) lines.push(plan.intent, "");

  lines.push(`> [!info] Plan of ${plan.phases.length} phases, ${done} complete.`, "");

  plan.phases.forEach((phase, index) => {
    const mark = phase.status === "done" ? "[x]" : phase.status === "active" ? "[>]" : "[ ]";
    lines.push(`## ${mark} Phase ${index + 1} — ${phase.name}`, "");
    if (phase.intent) {
      const intentQuote = phase.intent.includes("\n")
        ? phase.intent.split("\n").map((l) => `> ${l}`).join("\n")
        : `*${phase.intent}*`;
      lines.push(intentQuote, "");
    }
    for (const task of phase.tasks) {
      const files = task.files.length ? `  \`${task.files.join("`, `")}\`` : "";
      lines.push(`- [${task.done ? "x" : " "}] ${task.text}${files} [phase:: ${index + 1}] [status:: ${phase.status}]`);
    }
    if (phase.executedAt) {
      lines.push("", `Executed ${phase.executedAt}` +
        (phase.executedBy ? ` (session \`${phase.executedBy}\`)` : ""));
    }
    lines.push("");
  });

  if (plan.findings.length) {
    lines.push("## Verification", "");
    for (const severity of SEVERITY_ORDER) {
      const group = plan.findings.filter((f) => f.severity === severity);
      if (!group.length) continue;
      lines.push(`### ${severity[0].toUpperCase()}${severity.slice(1)}`, "");
      for (const finding of group) {
        lines.push(
          `- **${finding.title}**${finding.where ? ` — \`${finding.where}\`` : ""}`
        );
        if (finding.detail) {
          const detailLines = finding.detail.split("\n").map((l) => `    ${l}`).join("\n");
          lines.push(detailLines);
        }
      }
      lines.push("");
    }
  }

  // Machine-readable plan payload (PD-09)
  lines.push(
    "```darjeeling-plan",
    JSON.stringify(plan, null, 2),
    "```",
    ""
  );

  return lines.join("\n");
}

/** Render only the body of a plan (omitting YAML frontmatter and machine payload) for note insertion (CORE-02, PD-18). */
export function planToMarkdownBody(plan: DarjeelingPlan): string {
  const full = planToMarkdown(plan);
  return full
    .replace(/^---[\s\S]*?---\n*/, "")
    .replace(/```darjeeling-plan[\s\S]*?```\s*$/, "")
    .trim();
}

/** Recover a plan from its markdown artifact (PD-09, PD-32). */
export function planFromMarkdown(markdown: string): DarjeelingPlan | null {
  if (!markdown) return null;

  // 1. Try extracting embedded machine-readable JSON payload first (lossless PD-09)
  const jsonMatch = markdown.match(/```(?:darjeeling-plan|json:darjeeling-plan)\s*\n([\s\S]*?)\n```/);
  if (jsonMatch) {
    try {
      const parsed: unknown = JSON.parse(jsonMatch[1]);
      const plan = normalisePlan(parsed, {});
      if (plan) return plan;
    } catch {
      /* fall through to markdown recovery */
    }
  }

  // 2. Markdown recovery fallback
  if (!markdown.includes("darjeeling-plan")) return null;

  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---/);
  const meta: Record<string, string> = {};
  if (frontmatter) {
    for (const line of frontmatter[1].split("\n")) {
      const [key, ...rest] = line.split(":");
      if (key && rest.length) {
        let val = rest.join(":").trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        meta[key.trim()] = val;
      }
    }
  }

  const phases: PlanPhase[] = [];
  const phaseRe = /^##\s+(?:(\[x\]|\[>\]|\[ \]|✓|▶|·)\s+)?Phase\s+\d+\s+—\s+(.+)$/gm;
  const headings = [...markdown.matchAll(phaseRe)];

  headings.forEach((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index : markdown.length;
    const block = markdown.slice(start, end);

    const intentMatch = block.match(/^\s*(?:\*|>)\s*(.+?)(?:\*|$)\s*$/m);
    const tasks = [...block.matchAll(/^- \[([ x])\]\s+(.+)$/gm)].map((task) => {
      let raw = task[2];
      // Strip dataview fields like [phase:: 1] [status:: done] (PD-09)
      raw = raw.replace(/\[\w+::\s*[^\]]+\]/g, "").trim();
      const files = [...raw.matchAll(/`([^`]+)`/g)].map((f) => f[1]);
      return {
        id: newId("task"),
        text: raw.replace(/\s*`[^`]+`/g, "").trim(),
        files,
        done: task[1] === "x",
      };
    });

    const mark = match[1] || "";
    const status: PlanPhase["status"] =
      mark === "✓" || mark === "[x]"
        ? "done"
        : mark === "▶" || mark === "[>]"
        ? "active"
        : "pending";

    phases.push({
      id: newId("phase"),
      name: match[2].trim(),
      intent: intentMatch ? intentMatch[1].trim() : "",
      status,
      tasks,
    });
  });

  if (!phases.length) return null;

  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const now = new Date().toISOString();

  return {
    id: meta["plan-id"] || newId("plan"),
    title: titleMatch ? titleMatch[1].trim() : "Recovered plan",
    intent: "",
    createdAt: meta["created"] || now,
    updatedAt: now,
    model: meta["model"],
    effort: meta["effort"],
    phases,
    findings: [],
  };
}

import { App, TFile, normalizePath } from "obsidian";
import type { DarjeelingPlan, Finding, PlanPhase, PlanTask } from "./planTypes";

export interface CanvasTextNode {
  id: string;
  type: "text";
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color?: string;
}

export interface CanvasGroupNode {
  id: string;
  type: "group";
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  color?: string;
}

export interface CanvasFileNode {
  id: string;
  type: "file";
  x: number;
  y: number;
  width: number;
  height: number;
  file: string;
}

export type CanvasNode = CanvasTextNode | CanvasGroupNode | CanvasFileNode;

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide: "top" | "right" | "bottom" | "left";
  toNode: string;
  toSide: "top" | "right" | "bottom" | "left";
  fromEnd?: "none" | "arrow";
  toEnd?: "none" | "arrow";
  label?: string;
  color?: string;
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/**
 * Obsidian Canvas Standard Color Codes:
 * "1" = Red (#ef4444)
 * "2" = Orange / Amber (#f97316)
 * "3" = Yellow (#eab308)
 * "4" = Green (#10b981)
 * "5" = Cyan / Light Blue (#06b6d4)
 * "6" = Purple (#a855f7)
 */
const COLOR_RED = "1";
const COLOR_ORANGE = "2";
const COLOR_YELLOW = "3";
const COLOR_GREEN = "4";
const COLOR_CYAN = "5";
const COLOR_PURPLE = "6";

function resolvesInVault(app: App | undefined, path: string): boolean {
  if (!app?.vault) {
    return typeof path === "string" && (path.endsWith(".md") || path.endsWith(".canvas"));
  }
  try {
    const normalized = normalizePath(path);
    const file =
      app.vault.getFileByPath?.(normalized) ??
      app.vault.getAbstractFileByPath?.(normalized);
    return file instanceof TFile || (file !== null && typeof file === "object" && "extension" in file);
  } catch {
    return false;
  }
}

/**
 * Generates an Obsidian .canvas (JSON Canvas 1.0) representation of a Darjeeling Plan.
 * Organizes phases into Kanban columns, tasks into cards, and links touched vault files (PD-22).
 */
export function generatePlanCanvas(plan: DarjeelingPlan, app?: App): CanvasData {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];

  const totalTasks = plan.phases.reduce((acc, p) => acc + p.tasks.length, 0);
  const doneTasks = plan.phases.reduce(
    (acc, p) => acc + p.tasks.filter((t) => t.done).length,
    0
  );
  const percent = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  // 1. Plan Summary Hero Card
  const summaryNodeId = `plan-summary-${plan.id}`;
  nodes.push({
    id: summaryNodeId,
    type: "text",
    x: -520,
    y: 0,
    width: 440,
    height: 320,
    color: COLOR_PURPLE,
    text: [
      `## Plan: ${plan.title}`,
      "",
      `**Intent:** ${plan.intent || "No intent defined."}`,
      "",
      `- **Model:** \`${plan.model || "default"}\`${plan.effort ? ` (${plan.effort} effort)` : ""}`,
      `- **Phases:** ${plan.phases.length} Total`,
      `- **Progress:** ${doneTasks}/${totalTasks} Tasks (${percent}%)`,
      `- **Updated:** ${new Date(plan.updatedAt).toLocaleString()}`,
      plan.artifactPath ? `- **Artifact:** [[${plan.artifactPath}]]` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  const taskWidth = 440;
  const taskHeight = 130;
  const taskGap = 16;
  const sidecarWidth = 320;
  const sidecarGap = 30;
  const fileHeight = 180;
  const fileGap = 20;

  // Total column width includes task card + sidecar lane + padding (PD-22)
  const columnWidth = 20 + taskWidth + sidecarGap + sidecarWidth + 20; // 830
  const columnGap = 100;
  let lastGroupId: string | null = null;

  // 2. Phase Columns
  plan.phases.forEach((phase: PlanPhase, pIdx: number) => {
    const groupX = pIdx * (columnWidth + columnGap);
    const groupY = 0;
    const headerHeight = 70;

    // Calculate required height based on tasks and their stacked sidecar file nodes (PD-22)
    let maxTaskBottom = headerHeight;
    phase.tasks.forEach((task, tIdx) => {
      const taskY = groupY + headerHeight + tIdx * (taskHeight + taskGap);
      const taskBottom = taskY + taskHeight;
      const validFiles = Array.isArray(task.files)
        ? task.files.filter((f) => typeof f === "string" && resolvesInVault(app, f))
        : [];
      const sidecarBottom =
        validFiles.length > 0
          ? taskY + validFiles.length * fileHeight + (validFiles.length - 1) * fileGap
          : taskBottom;
      const effectiveBottom = Math.max(taskBottom, sidecarBottom);
      if (effectiveBottom > maxTaskBottom) {
        maxTaskBottom = effectiveBottom;
      }
    });

    const groupHeight = Math.max(280, maxTaskBottom + 40);

    const phaseColor =
      phase.status === "done"
        ? COLOR_GREEN
        : phase.status === "active"
        ? COLOR_ORANGE
        : COLOR_YELLOW;

    const groupId = `phase-group-${phase.id || pIdx}`;
    nodes.push({
      id: groupId,
      type: "group",
      x: groupX,
      y: groupY,
      width: columnWidth,
      height: groupHeight,
      label: `Phase ${pIdx + 1}: ${phase.name} [${phase.status.toUpperCase()}]`,
      color: phaseColor,
    });

    // Connect edge from previous phase or summary
    if (pIdx === 0) {
      edges.push({
        id: `edge-summary-p0`,
        fromNode: summaryNodeId,
        fromSide: "right",
        toNode: groupId,
        toSide: "left",
        toEnd: "arrow",
        color: COLOR_PURPLE,
        label: "Executes",
      });
    } else if (lastGroupId) {
      edges.push({
        id: `edge-phase-${pIdx - 1}-to-${pIdx}`,
        fromNode: lastGroupId,
        fromSide: "right",
        toNode: groupId,
        toSide: "left",
        toEnd: "arrow",
        color: phaseColor,
        label: `Next Phase`,
      });
    }
    lastGroupId = groupId;

    // Phase tasks
    phase.tasks.forEach((task: PlanTask, tIdx: number) => {
      const taskX = groupX + 20;
      const taskY = groupY + headerHeight + tIdx * (taskHeight + taskGap);
      const taskId = `task-${task.id || `${pIdx}-${tIdx}`}`;

      const taskColor = task.done
        ? COLOR_GREEN
        : phase.status === "active"
        ? COLOR_ORANGE
        : undefined;

      const fileList =
        task.files && task.files.length > 0
          ? task.files.map((f) => `\`${f}\``).join(", ")
          : "";

      nodes.push({
        id: taskId,
        type: "text",
        x: taskX,
        y: taskY,
        width: taskWidth,
        height: taskHeight,
        color: taskColor,
        text: [
          `### Task ${pIdx + 1}.${tIdx + 1}`,
          `${task.done ? "- [x]" : "- [ ]"} ${task.text}`,
          fileList ? `\n**Files:** ${fileList}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });

      // Sidecar file nodes: only emitted when file resolves in vault (PD-22)
      if (Array.isArray(task.files)) {
        const resolvableFiles = task.files
          .filter((f): f is string => typeof f === "string" && resolvesInVault(app, f))
          .slice(0, 3);

        resolvableFiles.forEach((file, fIdx) => {
          const fileNodeId = `file-${taskId}-${fIdx}`;
          const fileX = taskX + taskWidth + sidecarGap; // Sits in sidecar lane inside group
          const fileY = taskY + fIdx * (fileHeight + fileGap); // Stacked with vertical step = 200px

          nodes.push({
            id: fileNodeId,
            type: "file",
            x: fileX,
            y: fileY,
            width: sidecarWidth,
            height: fileHeight,
            file: normalizePath(file),
          });

          edges.push({
            id: `edge-${taskId}-${fileNodeId}`,
            fromNode: taskId,
            fromSide: "right",
            toNode: fileNodeId,
            toSide: "left",
            toEnd: "arrow",
            label: "touches",
          });
        });
      }
    });
  });

  // 3. Verification & Findings Column (if findings exist)
  if (plan.findings && plan.findings.length > 0) {
    const findingsX = plan.phases.length * (columnWidth + columnGap);
    const findingsGroupId = `findings-group-${plan.id}`;
    const cardHeight = 120;
    const findingsGroupHeight = Math.max(
      280,
      80 + plan.findings.length * (cardHeight + 16) + 40
    );

    nodes.push({
      id: findingsGroupId,
      type: "group",
      x: findingsX,
      y: 0,
      width: 440,
      height: findingsGroupHeight,
      label: `Verification Findings (${plan.findings.length})`,
      color: COLOR_RED,
    });

    if (lastGroupId) {
      edges.push({
        id: `edge-last-to-findings`,
        fromNode: lastGroupId,
        fromSide: "right",
        toNode: findingsGroupId,
        toSide: "left",
        toEnd: "arrow",
        color: COLOR_RED,
        label: "Verifies",
      });
    }

    plan.findings.forEach((finding: Finding, fIdx: number) => {
      const fX = findingsX + 20;
      const fY = 70 + fIdx * (cardHeight + 16);
      const fNodeId = `finding-${finding.id || fIdx}`;
      const fColor =
        finding.severity === "critical"
          ? COLOR_RED
          : finding.severity === "major"
          ? COLOR_ORANGE
          : COLOR_CYAN;

      nodes.push({
        id: fNodeId,
        type: "text",
        x: fX,
        y: fY,
        width: 400,
        height: cardHeight,
        color: fColor,
        text: [
          `### [${finding.severity.toUpperCase()}] ${finding.title}`,
          finding.detail,
          finding.where ? `\n*Location:* \`${finding.where}\`` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });
    });
  }

  return { nodes, edges };
}

import assert from "node:assert";
import test from "node:test";
import { TFile } from "./stubs/obsidian";
import { generatePlanCanvas } from "../../src/ui/plan/planCanvas";
import type { DarjeelingPlan } from "../../src/ui/plan/planTypes";

function makeCanvasTestPlan(): DarjeelingPlan {
  return {
    id: "plan-canvas-1",
    title: "Canvas Integration Plan",
    intent: "Demonstrate sidecar lane and stacked vault files",
    createdAt: "2026-09-23T12:00:00.000Z",
    updatedAt: "2026-09-23T12:00:00.000Z",
    model: "claude-3-7-sonnet",
    effort: "medium",
    phases: [
      {
        id: "p1",
        name: "Phase One",
        intent: "Setup foundation",
        status: "done",
        tasks: [
          {
            id: "t1",
            text: "Task with multiple files",
            files: ["Notes/Spec.md", "Notes/Architecture.md", "NonExistent/Phantom.md"],
            done: true,
          },
        ],
      },
      {
        id: "p2",
        name: "Phase Two",
        intent: "Execution",
        status: "active",
        tasks: [
          {
            id: "t2",
            text: "Single file task",
            files: ["src/index.ts"],
            done: false,
          },
        ],
      },
    ],
    findings: [
      {
        id: "f1",
        severity: "major",
        title: "Missing test",
        detail: "Add canvas test",
      },
    ],
  };
}

function createMockApp(existingPaths: string[]) {
  const fileSet = new Set(existingPaths);
  return {
    vault: {
      getFileByPath: (p: string) => (fileSet.has(p) ? new TFile(p) : null),
      getAbstractFileByPath: (p: string) => (fileSet.has(p) ? new TFile(p) : null),
    },
  } as any;
}

test("generatePlanCanvas: creates summary, phase columns, task cards, and findings (PD-22)", () => {
  const plan = makeCanvasTestPlan();
  const canvas = generatePlanCanvas(plan);

  assert.ok(Array.isArray(canvas.nodes));
  assert.ok(Array.isArray(canvas.edges));

  // Summary node
  const summary = canvas.nodes.find((n) => n.id === "plan-summary-plan-canvas-1");
  assert.ok(summary);
  assert.strictEqual(summary.type, "text");
  assert.strictEqual(summary.x, -520);
  assert.ok(summary.text.includes("Canvas Integration Plan"));

  // Phase group 1
  const group1 = canvas.nodes.find((n) => n.id === "phase-group-p1");
  assert.ok(group1);
  assert.strictEqual(group1.type, "group");
  assert.strictEqual(group1.width, 830); // Column width includes sidecar lane (PD-22)
  assert.strictEqual(group1.color, "4"); // Green for done

  // Phase group 2
  const group2 = canvas.nodes.find((n) => n.id === "phase-group-p2");
  assert.ok(group2);
  assert.strictEqual(group2.color, "2"); // Orange for active
  assert.strictEqual(group2.x, 830 + 100); // columnWidth + columnGap

  // Summary to Phase 1 edge
  const edgeSummary = canvas.edges.find((e) => e.fromNode === summary.id && e.toNode === group1.id);
  assert.ok(edgeSummary);

  // Phase 1 to Phase 2 edge
  const edgePhase = canvas.edges.find((e) => e.fromNode === group1.id && e.toNode === group2.id);
  assert.ok(edgePhase);

  // Findings group
  const findingsGroup = canvas.nodes.find((n) => n.id === "findings-group-plan-canvas-1");
  assert.ok(findingsGroup);
  assert.strictEqual(findingsGroup.color, "1"); // Red
});

test("generatePlanCanvas: emits file nodes ONLY when file resolves in vault (PD-22)", () => {
  const plan = makeCanvasTestPlan();
  // Only Notes/Spec.md and Notes/Architecture.md exist in the vault
  // NonExistent/Phantom.md does NOT exist!
  const app = createMockApp(["Notes/Spec.md", "Notes/Architecture.md"]);

  const canvas = generatePlanCanvas(plan, app);

  const fileNodes = canvas.nodes.filter((n) => n.type === "file");
  const filePaths = fileNodes.map((n: any) => n.file);

  assert.ok(filePaths.includes("Notes/Spec.md"));
  assert.ok(filePaths.includes("Notes/Architecture.md"));
  // Phantom path must NOT be emitted
  assert.strictEqual(filePaths.includes("NonExistent/Phantom.md"), false);
});

test("generatePlanCanvas: sidecar lane position and vertical stacking step (PD-22)", () => {
  const plan = makeCanvasTestPlan();
  const app = createMockApp(["Notes/Spec.md", "Notes/Architecture.md"]);

  const canvas = generatePlanCanvas(plan, app);

  const taskNode = canvas.nodes.find((n) => n.id === "task-t1")!;
  assert.ok(taskNode);
  assert.strictEqual(taskNode.width, 440);

  const fileNode0: any = canvas.nodes.find((n) => n.id === "file-task-t1-0");
  const fileNode1: any = canvas.nodes.find((n) => n.id === "file-task-t1-1");

  assert.ok(fileNode0);
  assert.ok(fileNode1);

  // Sits in sidecar lane inside group: taskX (20) + taskWidth (440) + sidecarGap (30) = 490
  assert.strictEqual(fileNode0.x, taskNode.x + 440 + 30);
  assert.strictEqual(fileNode0.width, 320);

  // Stacked with vertical step of fileHeight (180) + fileGap (20) = 200px (PD-22)
  assert.strictEqual(fileNode1.y - fileNode0.y, 200);

  // Edges link task card to file cards with "touches" label
  const edge0 = canvas.edges.find((e) => e.fromNode === taskNode.id && e.toNode === fileNode0.id);
  const edge1 = canvas.edges.find((e) => e.fromNode === taskNode.id && e.toNode === fileNode1.id);
  assert.ok(edge0);
  assert.ok(edge1);
  assert.strictEqual(edge0.label, "touches");
  assert.strictEqual(edge0.fromSide, "right");
  assert.strictEqual(edge0.toSide, "left");
});

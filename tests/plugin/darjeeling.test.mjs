import assert from "node:assert";
import { generatePlanCanvas } from "../../src/ui/plan/planCanvas.js";
import { planToMarkdown } from "../../src/ui/plan/planTypes.js";
import { extractApiError } from "../../src/errors.js";

// Test 1: JSON Canvas 1.0 Export Generation
console.log("Test 1: JSON Canvas generation...");
const samplePlan = {
  id: "test-plan-1",
  title: "Test Feature Rollout",
  intent: "Deploy feature across multiple phases",
  createdAt: "2026-09-19T10:00:00Z",
  updatedAt: "2026-09-19T12:00:00Z",
  model: "claude-3-7-sonnet",
  effort: "high",
  phases: [
    {
      id: "p1",
      name: "Architecture & Foundation",
      intent: "Setup core interfaces",
      status: "done",
      tasks: [
        { id: "t1", text: "Create core module", files: ["src/core.ts", "Notes/Spec.md"], done: true },
        { id: "t2", text: "Add unit tests", files: ["tests/core.test.ts"], done: true },
      ],
    },
    {
      id: "p2",
      name: "UI Implementation",
      intent: "Build user facing views",
      status: "active",
      tasks: [
        { id: "t3", text: "Build canvas view", files: ["src/canvas.ts"], done: false },
      ],
    },
  ],
  findings: [
    { id: "f1", severity: "minor", title: "Missing docstring", detail: "Add JSDoc to canvas view" },
  ],
};

const canvasData = generatePlanCanvas(samplePlan);
assert.ok(Array.isArray(canvasData.nodes), "Canvas should have nodes array");
assert.ok(Array.isArray(canvasData.edges), "Canvas should have edges array");
assert.ok(canvasData.nodes.length >= 5, "Canvas should have at least 5 nodes (summary, 2 groups, 3 tasks, sidecar)");

// Verify summary node
const summary = canvasData.nodes.find((n) => n.id === "plan-summary-test-plan-1");
assert.ok(summary, "Canvas should have summary card");
assert.strictEqual(summary.type, "text");
assert.ok(summary.text.includes("Test Feature Rollout"));

// Verify group node
const group1 = canvasData.nodes.find((n) => n.id === "phase-group-p1");
assert.ok(group1, "Canvas should have Phase 1 group node");
assert.strictEqual(group1.type, "group");
assert.strictEqual(group1.color, "4", "Completed phase should be Green (color 4)");

// Verify edge
const edge1 = canvasData.edges.find((e) => e.fromNode === summary.id && e.toNode === group1.id);
assert.ok(edge1, "Edge should link summary to Phase 1");
assert.strictEqual(edge1.toEnd, "arrow");

// Verify sidecar file node
const fileNode = canvasData.nodes.find((n) => n.type === "file");
assert.ok(fileNode, "Sidecar note file node should be created");
assert.strictEqual(fileNode.file, "Notes/Spec.md");

console.log("✓ JSON Canvas generation passed!");

// Test 2: planToMarkdown with Dataview metadata
console.log("Test 2: Markdown & Dataview generation...");
const markdown = planToMarkdown(samplePlan);
assert.ok(/type:\s*"?darjeeling-plan"?/.test(markdown), "Markdown should have type frontmatter");
assert.ok(markdown.includes("tags:"), "Markdown should have tags array");
assert.ok(markdown.includes("darjeeling/plan"), "Markdown should include darjeeling/plan tag");
assert.ok(markdown.includes("- [x] Create core module"), "Markdown should have completed checkbox");
assert.ok(markdown.includes("- [ ] Build canvas view"), "Markdown should have open checkbox");
assert.ok(markdown.includes("[phase:: 1]"), "Markdown should have Dataview inline phase");
assert.ok(markdown.includes("[status:: done]"), "Markdown should have Dataview inline status");

console.log("✓ Markdown & Dataview generation passed!");

// Test 3: API JSON Error Extraction (exercises the shipped helper, not a copy)
console.log("Test 3: API Error extraction...");

const rawAnthropicError = JSON.stringify({
  type: "error",
  error: { type: "authentication_error", message: "invalid x-api-key provided" },
});
assert.strictEqual(extractApiError(rawAnthropicError), "invalid x-api-key provided");

const rawSimpleError = JSON.stringify({ message: "Rate limit reached" });
assert.strictEqual(extractApiError(rawSimpleError), "Rate limit reached");

const nonJsonError = "<html>502 Bad Gateway</html>";
assert.strictEqual(extractApiError(nonJsonError), "<html>502 Bad Gateway</html>");

console.log("✓ API Error extraction passed!");

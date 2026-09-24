import test from "node:test";
import assert from "node:assert/strict";
import {
  saveArtifact,
  unicodeSlug,
  getUniqueArtifactPath,
} from "../../src/ui/plan/planArtifacts";
import { DarjeelingPlan } from "../../src/ui/plan/planTypes";
import { TFile, TFolder } from "./stubs/obsidian";

function createMockPlugin(files: Record<string, string> = {}) {
  const store: Record<string, string> = { ...files };
  const fileObjects: Record<string, TFile> = {};

  for (const path of Object.keys(files)) {
    fileObjects[path] = new TFile(path);
  }

  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => fileObjects[path] || null,
      getFileByPath: (path: string) => fileObjects[path] || null,
      read: async (file: TFile) => store[file.path] ?? "",
      create: async (path: string, content: string) => {
        store[path] = content;
        const f = new TFile(path);
        fileObjects[path] = f;
        return f;
      },
      createFolder: async (_path: string) => {},
      process: async (file: TFile, fn: (data: string) => string) => {
        const current = store[file.path] ?? "";
        const updated = fn(current);
        store[file.path] = updated;
        return updated;
      },
    },
  };

  const settings: any = {
    artifactFolder: "Darjeeling Plans",
    currentPlan: null,
  };

  const plugin = {
    app,
    settings,
    saveSettings: async () => {},
  };

  const fakeSessions = {
    writeArtifact: async () => {},
  };

  return { plugin: plugin as any, fakeSessions: fakeSessions as any, store, fileObjects };
}

function makePlan(id: string, title: string): DarjeelingPlan {
  return {
    id,
    title,
    intent: "Test intent",
    createdAt: "2026-09-23T12:00:00Z",
    updatedAt: "2026-09-23T12:00:00Z",
    phases: [
      {
        id: "p1",
        name: "Phase 1",
        intent: "Setup",
        status: "pending",
        tasks: [{ id: "t1", text: "Task 1", files: [], done: false }],
      },
    ],
    findings: [],
  };
}

test("artifacts: unicodeSlug preserves non-Latin characters and symbols (F-08, OBS-28)", () => {
  assert.equal(unicodeSlug("Sprint 2 Plan"), "Sprint-2-Plan");
  assert.equal(unicodeSlug("Projet d'Éxécution"), "Projet-d-Éxécution");
  assert.equal(unicodeSlug("日语 計画"), "日语-計画");
  assert.equal(unicodeSlug("Überwachung des Projekts"), "Überwachung-des-Projekts");
  assert.equal(unicodeSlug("   ---  "), "plan");
});

test("artifacts: two same-title plans produce two distinct files (PD-05, F-08)", async () => {
  const { plugin, fakeSessions, store } = createMockPlugin();

  const plan1 = makePlan("plan-aaa-111", "Launch Sprint 2");
  const plan2 = makePlan("plan-bbb-222", "Launch Sprint 2");

  const path1 = await saveArtifact(plugin, fakeSessions, plan1, false);
  const path2 = await saveArtifact(plugin, fakeSessions, plan2, false);

  assert.equal(path1, "Darjeeling Plans/Launch-Sprint-2.md");
  assert.equal(path2, "Darjeeling Plans/Launch-Sprint-2-1.md");

  // Both files must exist independently
  assert.ok(store[path1]);
  assert.ok(store[path2]);
  assert.ok(store[path1].includes('"plan-aaa-111"'));
  assert.ok(store[path2].includes('"plan-bbb-222"'));
});

test("artifacts: two non-Latin titles produce two distinct files (F-08, OBS-28)", async () => {
  const { plugin, fakeSessions, store } = createMockPlugin();

  const plan1 = makePlan("plan-jp-1", "日语 計画");
  const plan2 = makePlan("plan-jp-2", "日语 報告");

  const path1 = await saveArtifact(plugin, fakeSessions, plan1, false);
  const path2 = await saveArtifact(plugin, fakeSessions, plan2, false);

  assert.equal(path1, "Darjeeling Plans/日语-計画.md");
  assert.equal(path2, "Darjeeling Plans/日语-報告.md");

  assert.ok(store[path1]);
  assert.ok(store[path2]);
  assert.ok(store[path1].includes('"plan-jp-1"'));
  assert.ok(store[path2].includes('"plan-jp-2"'));
});

test("artifacts: an edited plan note is not overwritten without confirm (PD-05, PD-25)", async () => {
  const { plugin, fakeSessions, store } = createMockPlugin();

  const plan = makePlan("plan-xyz", "Feature Refactor");
  const path = await saveArtifact(plugin, fakeSessions, plan, false);

  // User edits the artifact note externally in Obsidian
  store[path] = store[path] + "\n\n## User Note\nExternal changes by user.";

  // Modify plan object in memory
  plan.phases[0].tasks.push({ id: "t2", text: "Task 2 added", files: [], done: false });

  // Attempt save without confirmOverride -> must reject with conflict error
  await assert.rejects(
    async () => {
      await saveArtifact(plugin, fakeSessions, plan, false, false);
    },
    (err: any) => {
      assert.equal(err.conflict, true);
      assert.equal(err.path, path);
      return true;
    }
  );

  // File on disk must retain the user's external changes
  assert.ok(store[path].includes("External changes by user."));

  // Now save with confirmOverride = true -> succeeds and updates file via vault.process
  await saveArtifact(plugin, fakeSessions, plan, false, true);
  assert.ok(store[path].includes("Task 2 added"));
});

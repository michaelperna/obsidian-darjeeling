import test from "node:test";
import assert from "node:assert/strict";
import { insertTextSafe, insertTextIntoActiveNote } from "../../src/vault/insert";
import { TFile, TFolder } from "./stubs/obsidian";

function createMockApp(files: Record<string, string> = {}, activeFile: TFile | null = null) {
  const store: Record<string, string> = { ...files };
  const fileObjects: Record<string, TFile> = {};

  for (const path of Object.keys(files)) {
    fileObjects[path] = new TFile(path);
  }

  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => fileObjects[path] || null,
      getFileByPath: (path: string) => fileObjects[path] || null,
      getMarkdownFiles: () => Object.values(fileObjects).filter((f) => f.extension === "md"),
      read: async (file: TFile) => store[file.path] ?? "",
      modify: async (file: TFile, content: string) => {
        store[file.path] = content;
      },
      process: async (file: TFile, fn: (data: string) => string) => {
        const current = store[file.path] ?? "";
        const updated = fn(current);
        store[file.path] = updated;
        return updated;
      },
      create: async (path: string, content: string) => {
        store[path] = content;
        const f = new TFile(path);
        fileObjects[path] = f;
        return f;
      },
    },
    workspace: {
      getActiveFile: () => activeFile,
      getActiveViewOfType: (_type: any) => {
        if (!activeFile) return null;
        return {
          file: activeFile,
          editor: {
            getCursor: () => ({ line: 0, ch: 0 }),
            replaceRange: () => {},
          },
        };
      },
      getLastOpenFiles: () => Object.keys(files),
    },
    fileManager: {
      getNewFileParent: (_path: string) => new TFolder(""),
    },
  };

  return { app: app as any, store, fileObjects };
}

test("insert: no open note -> creates new note, nothing else modified (CORE-02)", async () => {
  const initialFiles = {
    "Existing1.md": "# Note 1\nSome initial content.",
    "Existing2.md": "# Note 2\nImportant data.",
  };
  const { app, store } = createMockApp(initialFiles, null);

  const res = await insertTextSafe(app, "New note body content.");
  assert.ok(res);
  assert.equal(res.mode, "created");
  assert.equal(res.file.path, "Untitled.md");

  // Verify new note was created with correct text
  assert.equal(store["Untitled.md"], "New note body content.\n");

  // CRITICAL: Existing files must remain completely unmodified
  assert.equal(store["Existing1.md"], initialFiles["Existing1.md"]);
  assert.equal(store["Existing2.md"], initialFiles["Existing2.md"]);
});

test("insert: multiple creations without open note increments filename cleanly", async () => {
  const { app, store } = createMockApp({}, null);

  const res1 = await insertTextSafe(app, "First note");
  assert.equal(res1?.file.path, "Untitled.md");

  const res2 = await insertTextSafe(app, "Second note");
  assert.equal(res2?.file.path, "Untitled 1.md");

  assert.equal(store["Untitled.md"], "First note\n");
  assert.equal(store["Untitled 1.md"], "Second note\n");
});

test("insert: active MarkdownView note -> appends via vault.process", async () => {
  const active = new TFile("Daily.md");
  const initialFiles = { "Daily.md": "# Daily Note\n" };
  const { app, store } = createMockApp(initialFiles, active);

  const res = await insertTextSafe(app, "New action item");
  assert.ok(res);
  assert.equal(res.mode, "appended");
  assert.equal(res.file.path, "Daily.md");
  assert.equal(store["Daily.md"], "# Daily Note\n\nNew action item\n");
});

test("insert: plan inserts are body-only (frontmatter stripped) (CORE-02, PD-18)", async () => {
  const active = new TFile("Project.md");
  const initialFiles = { "Project.md": "# Project Roadmap\n" };
  const { app, store } = createMockApp(initialFiles, active);

  const planMarkdown = `---
type: darjeeling-plan
plan-id: plan_123
---

# Sprint Plan
- [ ] Task 1
- [ ] Task 2`;

  const res = await insertTextSafe(app, planMarkdown, { isPlan: true });
  assert.ok(res);
  assert.equal(res.mode, "appended");

  // Ensure frontmatter was stripped
  assert.ok(!store["Project.md"].includes("type: darjeeling-plan"));
  assert.ok(!store["Project.md"].includes("plan-id: plan_123"));
  assert.ok(store["Project.md"].includes("# Sprint Plan"));
  assert.ok(store["Project.md"].includes("- [ ] Task 1"));
});

test("insert: insertTextIntoActiveNote returns boolean", async () => {
  const { app } = createMockApp({}, null);
  const ok = await insertTextIntoActiveNote(app, "Testing boolean return");
  assert.equal(ok, true);

  const emptyOk = await insertTextIntoActiveNote(app, "   ");
  assert.equal(emptyOk, false);
});

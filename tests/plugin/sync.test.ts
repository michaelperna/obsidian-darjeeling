import test from "node:test";
import assert from "node:assert/strict";
import {
  pushFileWithGuard,
  listChangedSince,
  pullFileWithConflictCheck,
  computeSha256,
} from "../../src/vault/sync";
import { TFile } from "./stubs/obsidian";

function createMockApp(files: Record<string, string> = {}) {
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
      process: async (file: TFile, fn: (data: string) => string) => {
        const current = store[file.path] ?? "";
        const updated = fn(current);
        store[file.path] = updated;
        return updated;
      },
    },
  };

  return { app: app as any, store, fileObjects };
}

test("sync: push refuses when the server copy is newer (AC-10, 409 Conflict)", async () => {
  const { app } = createMockApp({ "Notes/Roadmap.md": "# Local Roadmap" });
  const file = new TFile("Notes/Roadmap.md");
  const deviceStore: Record<string, string> = {
    "Notes/Roadmap.md": "old_base_hash_123",
  };

  // Mock client simulating server 409 conflict
  const fakeClient = {
    pushFile: async (_path: string, baseSha?: string, _content?: string) => {
      assert.equal(baseSha, "old_base_hash_123");
      return {
        ok: false,
        conflict: true,
        current_sha256: "newer_server_hash_456",
        server_content: "# Server Roadmap with remote edits",
      };
    },
  };

  const res = await pushFileWithGuard(app, file, fakeClient, deviceStore);
  assert.equal(res.ok, false);
  assert.equal(res.conflict, true);
  assert.equal(res.serverSha, "newer_server_hash_456");
  // Device store hash should not be updated on conflict
  assert.equal(deviceStore["Notes/Roadmap.md"], "old_base_hash_123");
});

test("sync: push refuses binary files and null bytes (G-30, SRV-05)", async () => {
  const { app } = createMockApp({
    "attachment.png": "png binary header",
    "nullbyte.md": "hello \x00 world",
  });
  const pngFile = new TFile("attachment.png");
  const nullFile = new TFile("nullbyte.md");

  let pushCalled = false;
  const fakeClient = {
    pushFile: async () => {
      pushCalled = true;
      return { ok: true };
    },
  };

  const resPng = await pushFileWithGuard(app, pngFile, fakeClient);
  assert.equal(resPng.ok, false);
  assert.equal(resPng.error, "binary_refused");
  assert.equal(pushCalled, false);

  const resNull = await pushFileWithGuard(app, nullFile, fakeClient);
  assert.equal(resNull.ok, false);
  assert.equal(resNull.error, "binary_refused");
  assert.equal(pushCalled, false);
});

test("sync: successful push updates device store with new SHA256", async () => {
  const noteContent = "# Valid Note Content";
  const { app } = createMockApp({ "Notes/Valid.md": noteContent });
  const file = new TFile("Notes/Valid.md");
  const deviceStore: Record<string, string> = {};

  const expectedSha = await computeSha256(noteContent);

  const fakeClient = {
    pushFile: async (path: string, baseSha?: string, content?: string) => {
      assert.equal(path, "Notes/Valid.md");
      assert.equal(baseSha, undefined);
      assert.equal(content, noteContent);
      return { ok: true, current_sha256: expectedSha };
    },
  };

  const res = await pushFileWithGuard(app, file, fakeClient, deviceStore);
  assert.equal(res.ok, true);
  assert.equal(res.sha256, expectedSha);
  assert.equal(deviceStore["Notes/Valid.md"], expectedSha);
});

test("sync: listChangedSince filters files by turn time window (G-49)", async () => {
  const fakeSession = {
    changedSince: async (since: number) => {
      assert.equal(since, 1000);
      return [
        { path: "Before.md", modified: 990 },
        { path: "During.md", modified: 1010 },
        { path: "AtBoundary.md", modified: 1021 },
        { path: "MuchLater.md", modified: 1050 },
      ];
    },
  };

  // Turn from t=1000 to t=1020
  const changed = await listChangedSince(fakeSession, 1000, 1020);
  assert.equal(changed.length, 2);
  assert.equal(changed[0].path, "During.md");
  assert.equal(changed[1].path, "AtBoundary.md"); // within 2s boundary grace
});

test("sync: pullFileWithConflictCheck guards against overwriting unsaved local edits", async () => {
  const initialLocal = "# Original Local";
  const { app, store } = createMockApp({ "Doc.md": initialLocal });
  const deviceStore: Record<string, string> = {
    "Doc.md": await computeSha256(initialLocal),
  };

  // User edits local note without syncing
  store["Doc.md"] = "# Local Edits Not Synced";

  const fakeClient = {
    pullFile: async () => "# Remote Content",
  };

  // Attempt pull without confirmOverride -> should detect conflict
  const res1 = await pullFileWithConflictCheck(app, fakeClient, "Doc.md", deviceStore, false);
  assert.equal(res1.ok, false);
  assert.equal(res1.conflict, true);
  // Local file must be untouched
  assert.equal(store["Doc.md"], "# Local Edits Not Synced");

  // Attempt pull with confirmOverride -> succeeds and overwrites safely
  const res2 = await pullFileWithConflictCheck(app, fakeClient, "Doc.md", deviceStore, true);
  assert.equal(res2.ok, true);
  assert.equal(store["Doc.md"], "# Remote Content");
  assert.equal(deviceStore["Doc.md"], await computeSha256("# Remote Content"));
});

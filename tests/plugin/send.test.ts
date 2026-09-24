import test from "node:test";
import assert from "node:assert/strict";
import {
  getContextNote,
  readContextNoteWithCap,
  getLinkedNotes,
  formatLinkedNotesForRuntime,
  MAX_INLINE_NOTE_BYTES,
  TRUNCATED_MARKER,
} from "../../src/vault/context";
import { TFile } from "./stubs/obsidian";

function createMockApp(files: Record<string, string> = {}, activeFile: TFile | null = null, links: Record<string, string[]> = {}) {
  const fileObjects: Record<string, TFile> = {};
  for (const path of Object.keys(files)) {
    fileObjects[path] = new TFile(path);
  }

  const app = {
    workspace: {
      getActiveFile: () => activeFile,
      getActiveViewOfType: (_type: any) => (activeFile ? { file: activeFile } : null),
    },
    vault: {
      getAbstractFileByPath: (path: string) => fileObjects[path] || null,
      read: async (file: TFile) => files[file.path] ?? "",
    },
    metadataCache: {
      getFileCache: (file: TFile) => {
        const fileLinks = links[file.path] || [];
        return {
          links: fileLinks.map((l) => ({ link: l })),
        };
      },
      getFirstLinkpathDest: (linkpath: string, _sourcePath: string) => {
        return fileObjects[linkpath] || fileObjects[`${linkpath}.md`] || null;
      },
    },
  };

  return { app: app as any, fileObjects };
}

test("send/context: getContextNote strictly returns markdown TFiles only (CORE-25)", () => {
  const mdFile = new TFile("Notes/Active.md");
  const pngFile = new TFile("Images/Photo.png");
  const canvasFile = new TFile("Flow.canvas");

  // Markdown active file returns TFile
  const { app: app1 } = createMockApp({ "Notes/Active.md": "" }, mdFile);
  assert.equal(getContextNote(app1), mdFile);

  // Non-markdown active file returns null
  const { app: app2 } = createMockApp({ "Images/Photo.png": "" }, pngFile);
  assert.equal(getContextNote(app2), null);

  const { app: app3 } = createMockApp({ "Flow.canvas": "" }, canvasFile);
  assert.equal(getContextNote(app3), null);

  // Explicit attached file overrides active file
  assert.equal(getContextNote(app1, mdFile), mdFile);
  assert.equal(getContextNote(app1, pngFile), null);
});

test("send/context: readContextNoteWithCap enforces 32 KB cap with visible marker (G-33, CORE-25)", async () => {
  const smallText = "# Small Note\nContent fits easily.";
  const largeText = "A".repeat(40000); // > 32 KB

  const { app } = createMockApp({
    "Small.md": smallText,
    "Large.md": largeText,
  });

  const smallFile = new TFile("Small.md");
  const largeFile = new TFile("Large.md");

  const smallRes = await readContextNoteWithCap(app, smallFile);
  assert.equal(smallRes.truncated, false);
  assert.equal(smallRes.content, smallText);

  const largeRes = await readContextNoteWithCap(app, largeFile);
  assert.equal(largeRes.truncated, true);
  assert.ok(largeRes.content.includes(TRUNCATED_MARKER));
  assert.equal(largeRes.content.slice(0, MAX_INLINE_NOTE_BYTES), "A".repeat(MAX_INLINE_NOTE_BYTES));
});

test("send/context: linked notes format paths for CLI runtimes, omit for direct API by default (ADR-14, G-33)", async () => {
  const rootFile = new TFile("Index.md");
  const link1 = new TFile("Architecture.md");
  const link2 = new TFile("Decisions.md");

  const { app } = createMockApp(
    {
      "Index.md": "Links to [[Architecture]] and [[Decisions]]",
      "Architecture.md": "Architecture details",
      "Decisions.md": "ADR details",
    },
    rootFile,
    {
      "Index.md": ["Architecture", "Decisions"],
    }
  );

  const linked = getLinkedNotes(app, rootFile);
  assert.equal(linked.length, 2);
  assert.equal(linked[0].path, "Architecture.md");
  assert.equal(linked[1].path, "Decisions.md");

  // CLI runtimes receive paths only
  const cliText = await formatLinkedNotesForRuntime(app, linked, false, false);
  assert.ok(cliText.includes("- Architecture.md"));
  assert.ok(cliText.includes("- Decisions.md"));
  assert.ok(!cliText.includes("Architecture details")); // No content leak!

  // Direct API with includeLinkedNotes: false (default) sends nothing
  const directDefault = await formatLinkedNotesForRuntime(app, linked, true, false);
  assert.equal(directDefault, "");

  // Direct API with includeLinkedNotes: true sends content
  const directOptIn = await formatLinkedNotesForRuntime(app, linked, true, true);
  assert.ok(directOptIn.includes("### Linked Note: Architecture.md"));
  assert.ok(directOptIn.includes("Architecture details"));
});

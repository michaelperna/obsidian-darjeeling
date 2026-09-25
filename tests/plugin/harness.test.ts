import test from "node:test";
import assert from "node:assert/strict";
import { VaultHarness } from "../../src/vault/harness";
import { DEFAULT_SETTINGS } from "../../src/settings/schema";
import { TFile } from "./stubs/obsidian";

function createMockApp(files: Record<string, string> = {}) {
  const fileObjects: Record<string, TFile> = {};
  for (const path of Object.keys(files)) {
    fileObjects[path] = new TFile(path);
  }

  return {
    vault: {
      getName: () => "TestVault",
      getMarkdownFiles: () => [
        new TFile("Notes/ProjectA.md"),
        new TFile("Notes/ProjectB.md"),
      ],
      getAbstractFileByPath: (path: string) => fileObjects[path] || null,
      read: async (file: TFile) => files[file.path] || "",
    },
  } as any;
}

test("ADR-14: Direct API harness contains no note paths, no CLAUDE.md text, and neutral prompt", async () => {
  const mockFiles = {
    "CLAUDE.md": "SECRET_CLAUDE_INSTRUCTIONS_DO_NOT_LEAK",
    "DARJEELING.md": "Darjeeling specific guidelines",
  };
  const app = createMockApp(mockFiles);
  const settings = {
    ...DEFAULT_SETTINGS,
    runtimeMode: "direct-api" as const,
    vaultContext: "none" as const,
    sendNoteListing: false,
  };

  const harness = new VaultHarness(app, settings);
  const result = await harness.loadHarness("Notes/Active.md", true);

  // 1. One neutral line default prompt
  assert.ok(
    result.systemPrompt.includes(
      'You are working inside the Obsidian vault "TestVault". Refer to notes with [[wikilinks]].'
    )
  );

  // 2. No consultant / persona copy
  const forbiddenPersona = ["management", "consultant"].join(" ");
  assert.ok(!result.systemPrompt.toLowerCase().includes(forbiddenPersona));
  assert.ok(!result.systemPrompt.toLowerCase().includes("executive thinking partner"));

  // 3. No CLAUDE.md text
  assert.ok(!result.systemPrompt.includes("SECRET_CLAUDE_INSTRUCTIONS_DO_NOT_LEAK"));

  // 4. No note listing
  assert.ok(!result.systemPrompt.includes("Notes/ProjectA.md"));
  assert.ok(!result.systemPrompt.includes("Notes/ProjectB.md"));
});

test("ADR-14: Opting into instructions includes DARJEELING.md", async () => {
  const mockFiles = {
    "DARJEELING.md": "Custom vault documentation instructions",
  };
  const app = createMockApp(mockFiles);
  const settings = {
    ...DEFAULT_SETTINGS,
    runtimeMode: "direct-api" as const,
    vaultContext: "instructions" as const,
  };

  const harness = new VaultHarness(app, settings);
  const result = await harness.loadHarness(undefined, true);

  assert.equal(result.source, "DARJEELING.md");
  assert.ok(result.systemPrompt.includes("Custom vault documentation instructions"));
});

test("ADR-14: DARJEELING.md is NOT sent to direct providers by default (opt-in only)", async () => {
  const app = createMockApp({ "DARJEELING.md": "PRIVATE_VAULT_INSTRUCTIONS" });
  const settings = { ...DEFAULT_SETTINGS, runtimeMode: "direct-api" as const };
  assert.equal(settings.vaultContext, "none");

  const result = await new VaultHarness(app, settings).loadHarness(undefined, true);
  assert.equal(result.source, "none");
  assert.ok(!result.systemPrompt.includes("PRIVATE_VAULT_INSTRUCTIONS"));
});

test("ADR-14: CLI runtimes still receive DARJEELING.md with default settings", async () => {
  const app = createMockApp({ "DARJEELING.md": "CLI vault instructions" });
  const settings = { ...DEFAULT_SETTINGS, runtimeMode: "remote" as const };

  const result = await new VaultHarness(app, settings).loadHarness(undefined, false);
  assert.equal(result.source, "DARJEELING.md");
  assert.ok(result.systemPrompt.includes("CLI vault instructions"));
});

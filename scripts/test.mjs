#!/usr/bin/env node
// Plugin unit tests (ADR-18).
//
// Each tests/plugin/*.test.{ts,mts,mjs} file is bundled by esbuild together
// with the real src/ modules it imports, then run under `node --test`. Tests
// import the shipped code; they never re-implement it (CHAT-35).
//
//   npm test                                   every test file
//   npm test -- tests/plugin/foo.test.ts ...   only the named files
//
// Resolution inside the bundles:
//   obsidian             -> tests/plugin/stubs/obsidian.ts
//   @xterm/* packages    -> tests/plugin/stubs/xterm.ts
//   require("<builtin>") -> Node's own module, unless a test swapped it for a
//                           fake with overrideRequire() (stubs/nodeRequire.ts)
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "tests", "plugin");
const stubs = path.join(testDir, "stubs");
const TEST_FILE = /\.test\.(ts|mts|mjs)$/;

// src/ reaches Node builtins through lazy `require()` calls so that nothing
// Node-only runs at module scope on mobile. An ESM bundle has no `require`, so
// provide one that consults the per-test overrides before Node's loader.
const REQUIRE_SHIM = [
  'import { createRequire as __djCreateRequire } from "node:module";',
  "const require = ((load) => (id) => {",
  '  const key = String(id).replace(/^node:/, "");',
  "  const fake = globalThis.__djRequireOverrides?.[key];",
  "  return fake !== undefined ? fake : load(id);",
  "})(__djCreateRequire(import.meta.url));",
].join("\n");

const requested = process.argv.slice(2);
const files = requested.length
  ? requested.map((f) => path.resolve(f))
  : readdirSync(testDir)
      .filter((f) => TEST_FILE.test(f))
      .sort()
      .map((f) => path.join(testDir, f));

for (const file of files) {
  if (!TEST_FILE.test(file) || !existsSync(file)) {
    console.error(`test: not a test file: ${path.relative(root, file)}`);
    process.exit(2);
  }
}
if (!files.length) {
  console.error("test: no test files found in tests/plugin");
  process.exit(2);
}

const outdir = mkdtempSync(path.join(tmpdir(), "dj-test-"));
try {
  await build({
    entryPoints: files,
    outdir,
    outbase: root,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: "inline",
    logLevel: "warning",
    banner: { js: REQUIRE_SHIM },
    alias: {
      obsidian: path.join(stubs, "obsidian.ts"),
      "@xterm/xterm": path.join(stubs, "xterm.ts"),
      "@xterm/addon-fit": path.join(stubs, "xterm.ts"),
      "@xterm/addon-web-links": path.join(stubs, "xterm.ts"),
    },
  });
  const bundles = files.map((f) =>
    path.join(outdir, path.relative(root, f).replace(/\.(ts|mts|mjs)$/, ".mjs"))
  );
  const run = spawnSync(process.execPath, ["--test", "--enable-source-maps", ...bundles], {
    stdio: "inherit",
  });
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(outdir, { recursive: true, force: true });
}

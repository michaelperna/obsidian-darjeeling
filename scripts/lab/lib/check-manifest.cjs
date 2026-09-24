#!/usr/bin/env node
// Release / community-directory consistency checks. Usage: node check-manifest.cjs <repo-root>
// Prints FAIL/WARN/OK lines; exits 1 if any FAIL.
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.resolve(process.argv[2] || ".");
const lines = [];
const fail = (m) => lines.push("FAIL " + m);
const warn = (m) => lines.push("WARN " + m);
const ok = (m) => lines.push("OK   " + m);
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

// The community directory reads these at the repo root (ADR-01).
for (const f of ["manifest.json", "versions.json", "package.json", "LICENSE"]) {
  if (!fs.existsSync(path.join(root, f))) fail(`no ${f} at the repo root; the community directory reads the root`);
}
if (lines.length) {
  console.log(lines.join("\n"));
  process.exit(1);
}

const m = readJson(path.join(root, "manifest.json"));
const pkg = readJson(path.join(root, "package.json"));
const versions = readJson(path.join(root, "versions.json"));
const serverCfgPath = fs.existsSync(path.join(root, "server", "darjeeling_server", "config.py"))
  ? path.join(root, "server", "darjeeling_server", "config.py")
  : path.join(root, "server", "server.py");
const serverPy = fs.readFileSync(serverCfgPath, "utf8");
const serverVersion = (serverPy.match(/^VERSION = "([^"]+)"/m) || [])[1];

if (m.version === pkg.version) ok(`manifest ${m.version} == package.json`);
else fail(`manifest.json ${m.version} != package.json ${pkg.version}`);
if (serverVersion === m.version) ok(`server VERSION ${serverVersion} == manifest`);
else fail(`server/server.py VERSION ${serverVersion} != manifest ${m.version}`);
if (!(m.version in versions)) fail(`versions.json has no entry for ${m.version}`);
else if (versions[m.version] !== m.minAppVersion)
  fail(`versions.json[${m.version}]=${versions[m.version]} but minAppVersion=${m.minAppVersion}`);
else ok("versions.json covers current version");

// Community directory rules (docs.obsidian.md "Submit your plugin" + releases validator).
if (/obsidian/i.test(m.id)) fail(`id "${m.id}" contains "obsidian"`);
if (!/^[a-z0-9-]+$/.test(m.id)) fail(`id "${m.id}" must be lowercase letters, digits, dashes`);
if (/obsidian/i.test(m.name)) fail(`name "${m.name}" contains "Obsidian"`);
if (!m.description) fail("description missing");
else {
  if (m.description.length > 250) fail(`description is ${m.description.length} chars (> 250)`);
  if (!/[.?!]$/.test(m.description)) warn("description should end with a period");
  if (/obsidian/i.test(m.description))
    warn('description mentions "Obsidian" (redundant in the directory; the review bot may flag it, rule unverified)');
}
if (typeof m.isDesktopOnly !== "boolean") fail("isDesktopOnly must be a boolean");
if (!m.minAppVersion) fail("minAppVersion missing");

if (m.authorUrl && !/github\.com\/michaelperna\b/.test(m.authorUrl))
  warn(`authorUrl ${m.authorUrl} does not match the planned repo owner github.com/michaelperna`);
if (!m.fundingUrl) ok("no fundingUrl (optional)");

// Build reproducibility.
const floating = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
  .filter(([, v]) => v === "latest" || v === "*")
  .map(([k, v]) => `${k}@${v}`);
if (floating.length) warn(`floating dependency versions: ${floating.join(", ")}`);
if (!fs.existsSync(path.join(root, "package-lock.json")))
  warn("no package-lock.json; `npm ci` is impossible, so builds are not reproducible");
if (/npx -y /.test(pkg.scripts?.test || ""))
  warn(`test script downloads its runner at run time: "${pkg.scripts.test}" (tsx is not a devDependency)`);

// Release workflow sanity.
const wf = path.join(root, ".github", "workflows", "release.yml");
if (fs.existsSync(wf)) {
  const y = fs.readFileSync(wf, "utf8");
  if (/node-version:\s*"?20/.test(y)) warn("release.yml builds on Node 20 (EOL 2026-04-30)");
  if (!/npm (test|run test)/.test(y)) warn("release.yml never runs the tests before publishing");
  if (/run:\s*npm install\b/.test(y)) warn("release.yml uses `npm install`, not `npm ci`");
} else warn("no .github/workflows/release.yml");

console.log(lines.join("\n"));
process.exit(lines.some((l) => l.startsWith("FAIL")) ? 1 : 0);

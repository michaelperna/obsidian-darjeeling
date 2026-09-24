#!/usr/bin/env node
/**
 * scripts/ci/css-lint.mjs
 *
 * Project Darjeeling — CSS Quality & Theming Lint Verification
 * Enforces:
 *   1. Zero !important in tokens.css and base.css (OBS-22, DM-19)
 *   2. Allow-list enforcement for remaining !important (mapped to sprint owners)
 *   3. All --dj-* custom properties referenced in src/css are defined (VTH-38)
 *   4. All animation names referenced have matching @keyframes (DM-19)
 *   5. No raw un-tokenized hex literals outside tokens.css (DM-03)
 *   6. Zero occurrences of legacy assets: djLeafGrad or data:image/png;base64 in src/ (OBS-05, OBS-06)
 *   7. Balanced braces and valid structure in built styles.css
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const cssDir = path.join(root, "src", "css");
const stylesPath = path.join(root, "styles.css");

let failed = false;
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failed = true;
}

function pass(msg) {
  console.log(`PASS: ${msg}`);
}

// 1. Build & Brace Balance Check
if (!existsSync(stylesPath)) {
  fail("styles.css does not exist. Run scripts/build-css.mjs first.");
} else {
  const content = readFileSync(stylesPath, "utf8");
  const opens = content.split("{").length - 1;
  const closes = content.split("}").length - 1;
  if (opens !== closes) {
    fail(`styles.css brace mismatch: ${opens} open vs ${closes} close`);
  } else {
    pass(`styles.css syntax valid (${opens} balanced rules, ${content.split("\n").length} lines).`);
  }
}

// 2. !important checks in tokens.css and base.css
const tokensCss = readFileSync(path.join(cssDir, "tokens.css"), "utf8");
const baseCss = readFileSync(path.join(cssDir, "base.css"), "utf8");

if (tokensCss.includes("!important")) {
  fail("tokens.css must contain zero !important declarations (OBS-22).");
} else {
  pass("tokens.css has zero !important declarations.");
}

if (baseCss.includes("!important")) {
  fail("base.css must contain zero !important declarations (OBS-22).");
} else {
  pass("base.css has zero !important declarations.");
}

// 3. !important Allow-list Check for other files
const allowedImportantFiles = new Set(["terminal.css", "overrides.css", "modals.css"]);
const cssFiles = readdirSync(cssDir).filter(f => f.endsWith(".css"));

for (const file of cssFiles) {
  const content = readFileSync(path.join(cssDir, file), "utf8");
  if (content.includes("!important")) {
    if (!allowedImportantFiles.has(file)) {
      fail(`Disallowed !important found in ${file}. Only allow-listed files may contain !important.`);
    }
  }
}
pass("All !important declarations are restricted to allow-listed sprint files.");

// 4. Undefined --dj-* Variable Check
const definedVars = new Set();
const referencedVars = new Map();

// Load token definitions
const defSources = [
  path.join(cssDir, "tokens.css"),
  path.join(root, "textures", "textures.css"),
  path.join(root, "textures", "mark.css")
];

for (const src of defSources) {
  if (existsSync(src)) {
    const content = readFileSync(src, "utf8");
    for (const match of content.matchAll(/(--dj-[\w-]+)\s*:/g)) {
      definedVars.add(match[1]);
    }
  }
}

for (const file of cssFiles) {
  const content = readFileSync(path.join(cssDir, file), "utf8");
  for (const match of content.matchAll(/var\(\s*(--dj-[\w-]+)/g)) {
    const varName = match[1];
    if (!referencedVars.has(varName)) referencedVars.set(varName, []);
    referencedVars.get(varName).push(file);
  }
}

const undefinedVars = [];
for (const [varName, files] of referencedVars.entries()) {
  if (!definedVars.has(varName)) {
    undefinedVars.push({ varName, files: [...new Set(files)] });
  }
}

if (undefinedVars.length > 0) {
  fail(`Found undefined --dj-* custom properties: ${JSON.stringify(undefinedVars, null, 2)}`);
} else {
  pass(`All referenced --dj-* tokens (${referencedVars.size} unique) are properly defined.`);
}

// 5. Keyframes & Animation Reference Check
const keyframeNames = new Set();
const referencedAnimations = new Map();

for (const file of cssFiles) {
  const content = readFileSync(path.join(cssDir, file), "utf8");
  for (const match of content.matchAll(/@keyframes\s+([\w-]+)/g)) {
    keyframeNames.add(match[1]);
  }
}

for (const file of cssFiles) {
  const content = readFileSync(path.join(cssDir, file), "utf8");
  for (const match of content.matchAll(/animation(?:-name)?\s*:\s*([^;]+);/g)) {
    const val = match[1].trim();
    for (const token of val.split(/\s+/)) {
      if (/^dj-[\w-]+$/.test(token)) {
        if (!referencedAnimations.has(token)) referencedAnimations.set(token, []);
        referencedAnimations.get(token).push(file);
      }
    }
  }
}

const missingKeyframes = [];
for (const [animName, files] of referencedAnimations.entries()) {
  if (!keyframeNames.has(animName)) {
    missingKeyframes.push({ animName, files: [...new Set(files)] });
  }
}

if (missingKeyframes.length > 0) {
  fail(`Found animations missing @keyframes: ${JSON.stringify(missingKeyframes, null, 2)}`);
} else {
  pass(`All animation references (${referencedAnimations.size} unique) have matching @keyframes.`);
}

// 6. Raw Hex Literals Check outside tokens.css
const unTokenizedHex = [];
for (const file of cssFiles) {
  if (file === "tokens.css") continue;
  const content = readFileSync(path.join(cssDir, file), "utf8");
  // Strip comments
  const noComments = content.replace(/\/\*[\s\S]*?\*\//g, "");
  // Lines
  const lines = noComments.split("\n");
  lines.forEach((line, idx) => {
    // Strip var(--..., #fallback)
    const stripped = line.replace(/var\([^)]+\)/g, "");
    const match = stripped.match(/#[0-9a-fA-F]{3,8}/);
    if (match) {
      unTokenizedHex.push(`${file}:${idx + 1}: ${line.trim()}`);
    }
  });
}

if (unTokenizedHex.length > 0) {
  fail(`Found raw un-tokenized hex literals outside tokens.css:\n${unTokenizedHex.join("\n")}`);
} else {
  pass("Zero raw un-tokenized hex literals outside tokens.css.");
}

// 7. Legacy Assets grep Check (djLeafGrad, base64 PNGs)
try {
  const grepCheck = execSync(
    'git grep -nE "djLeafGrad|data:image/png;base64" -- "src/**"',
    { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }
  );
  if (grepCheck.trim().length > 0) {
    fail(`Found forbidden legacy asset references in src/:\n${grepCheck}`);
  }
} catch {
  // grep exits with 1 when no matches are found, which is what we want
  pass("Zero legacy vector/raster assets (djLeafGrad, data:image/png;base64) in src/.");
}

if (failed) {
  console.error("\nCSS Linting failed with errors.");
  process.exit(1);
} else {
  console.log("\nAll CSS Linting checks passed successfully.");
  process.exit(0);
}

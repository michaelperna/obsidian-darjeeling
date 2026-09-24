#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(".");
const baselinePath = path.join(root, ".github", "lint-baseline.json");

if (!existsSync(baselinePath)) {
  console.log("No lint baseline found at .github/lint-baseline.json; skipping ratchet check.");
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const maxAllowedErrors = baseline.errorCount ?? 530;

let eslintOutput = "";
try {
  eslintOutput = execSync("npx eslint -f json src/", {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
} catch (err) {
  // eslint exits with non-zero when lint errors/warnings are present; stdout contains JSON
  eslintOutput = err.stdout?.toString() || "";
}

try {
  const results = JSON.parse(eslintOutput);
  const totalErrors = results.reduce((acc, file) => acc + (file.errorCount || 0), 0);
  const totalWarnings = results.reduce((acc, file) => acc + (file.warningCount || 0), 0);

  console.log(`ESLint ratchet check: ${totalErrors} errors, ${totalWarnings} warnings (baseline ceiling: ${maxAllowedErrors})`);

  if (totalErrors > maxAllowedErrors) {
    console.error(`FAIL: ESLint error count (${totalErrors}) exceeds baseline (${maxAllowedErrors})`);
    process.exit(1);
  }
  console.log("PASS: ESLint error count is within baseline ratchet.");
  process.exit(0);
} catch (parseErr) {
  console.error("Failed to parse ESLint JSON output:", parseErr);
  process.exit(1);
}

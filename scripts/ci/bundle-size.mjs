#!/usr/bin/env node
/**
 * scripts/ci/bundle-size.mjs
 * Tracks main.js bundle size and fails if it grows more than 5% over the recorded baseline (G-59).
 * Usage: node scripts/ci/bundle-size.mjs [--record]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const mainJsPath = path.join(repoRoot, "main.js");
const baselinePath = path.join(__dirname, "bundle-size.json");

if (!fs.existsSync(mainJsPath)) {
  console.error(`FAIL: main.js not found at ${mainJsPath}. Run 'npm run build' first.`);
  process.exit(1);
}

const currentSize = fs.statSync(mainJsPath).size;
const isRecord = process.argv.includes("--record");

if (!fs.existsSync(baselinePath) || isRecord) {
  const newBaseline = {
    baselineBytes: currentSize,
    maxAllowedBytes: Math.floor(currentSize * 1.05),
    recordedAt: new Date().toISOString(),
    comment: "Recorded baseline for Sprint 1 (G-59). Fails if size grows > 5% without explicit bump."
  };
  fs.writeFileSync(baselinePath, JSON.stringify(newBaseline, null, 2) + "\n");
  console.log(`RECORDED: baseline set to ${currentSize} bytes (max allowed +5%: ${newBaseline.maxAllowedBytes} bytes)`);
  process.exit(0);
}

const baselineData = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const baseline = baselineData.baselineBytes;
const maxAllowed = baselineData.maxAllowedBytes || Math.floor(baseline * 1.05);

const diffBytes = currentSize - baseline;
const diffPct = ((diffBytes / baseline) * 100).toFixed(2);

if (currentSize > maxAllowed) {
  console.error(`FAIL: main.js size ${currentSize} bytes exceeds max allowed ${maxAllowed} bytes (+${diffPct}% over baseline ${baseline}). Bump baseline with --record if intentional.`);
  process.exit(1);
}

console.log(`OK: main.js size ${currentSize} bytes is within limit (baseline: ${baseline} bytes, ${diffPct >= 0 ? "+" : ""}${diffPct}%, max: ${maxAllowed} bytes)`);
process.exit(0);

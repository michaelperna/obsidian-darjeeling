// timing-harness.mjs -- Measures AC-16 startup timing (median of 5 enablePlugin timings in 2-CPU container).
// Usage: node timing-harness.mjs <out-dir>
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire("/opt/e2e/package.json");
const { chromium } = require("playwright-core");

const out = process.argv[2] || ".";

async function obsidianPage(browser) {
  for (let i = 0; i < 60; i++) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        const ready = await p
          .evaluate(() => !!(window.app && window.app.workspace && window.app.workspace.layoutReady))
          .catch(() => false);
        if (ready) return p;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("No Obsidian window found");
}

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
try {
  const page = await obsidianPage(browser);
  const timings = [];

  for (let run = 1; run <= 5; run++) {
    // Disable plugin if currently enabled
    await page.evaluate(async () => {
      const pl = window.app.plugins;
      if (pl.plugins["darjeeling"]) {
        await pl.disablePlugin("darjeeling");
      }
    });
    await new Promise((r) => setTimeout(r, 400));

    // Measure enablePlugin timing
    const elapsedMs = await page.evaluate(async () => {
      const pl = window.app.plugins;
      const t0 = performance.now();
      await pl.enablePluginAndSave("darjeeling");
      const t1 = performance.now();
      return t1 - t0;
    });

    timings.push(elapsedMs);
    console.log(`Run ${run}: ${elapsedMs.toFixed(1)} ms`);
    await new Promise((r) => setTimeout(r, 400));
  }

  const sorted = [...timings].sort((a, b) => a - b);
  const median = sorted[2];
  const report = {
    timings,
    median,
    pass: median <= 300,
    target: "<= 300 ms"
  };

  console.log(`Median startup timing: ${median.toFixed(1)} ms (target <= 300 ms) -> ${report.pass ? "PASS" : "FAIL"}`);
  fs.writeFileSync(`${out}/ac16-timing.json`, JSON.stringify(report, null, 2));

  if (!report.pass) {
    process.exit(1);
  }
} catch (e) {
  console.error("Timing harness failure:", e);
  process.exit(1);
} finally {
  await browser.close().catch(() => {});
}

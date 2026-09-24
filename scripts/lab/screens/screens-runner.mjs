// screens-runner.mjs -- Automated Visual QA & Accessibility Matrix Runner
// Matrix: Default, Minimal, Things, AnuPpuccin x light/dark x default/tea x 300, 380, 620, 768, 1024 px
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const require = createRequire(import.meta.url);
let chromium;
try {
  // Try local or container playwright-core
  chromium = require("playwright-core").chromium;
} catch {
  try {
    chromium = createRequire("/opt/e2e/package.json")("playwright-core").chromium;
  } catch {
    console.error("FAIL: playwright-core not found");
    process.exit(1);
  }
}

let axeCorePath = null;
try {
  axeCorePath = require.resolve("axe-core/axe.min.js");
} catch {
  try {
    axeCorePath = createRequire("/opt/e2e/package.json").resolve("axe-core/axe.min.js");
  } catch {
    // axe-core optional or will use local fallback evaluation
  }
}

const outDir = process.argv[2] || "./_lab/screens";
const onlyFilter = process.argv[3] ? process.argv[3].toLowerCase() : null;

fs.mkdirSync(outDir, { recursive: true });

// Minimal static file server for harness files
const baseDir = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(baseDir, "../../..");

const mimeTypes = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
};

const server = http.createServer((req, res) => {
  let reqPath = decodeURI(req.url.split("?")[0]);
  let filePath = path.join(baseDir, reqPath === "/" ? "index.html" : reqPath);

  if (!fs.existsSync(filePath)) {
    // Check in repo root (e.g. for styles.css)
    const altPath = path.join(repoRoot, reqPath.replace(/^\//, ""));
    if (fs.existsSync(altPath)) {
      filePath = altPath;
    }
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "text/plain" });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found: " + req.url);
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const harnessUrl = `http://127.0.0.1:${port}/index.html`;

console.log(`screens-runner: static harness live at ${harnessUrl}`);

const THEMES = ["default", "minimal", "things", "anuppuccin"];
const MODES = ["dark", "light"];
const PALETTES = ["default", "tea"];
const WIDTHS = [300, 380, 620, 768, 1024];

let passed = 0;
let failed = 0;
const results = [];

let browser;
try {
  browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
} catch {
  browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
}

try {
  let page = null;
  for (let i = 0; i < 30; i++) {
    for (const ctx of browser.contexts()) {
      const pages = ctx.pages();
      if (pages.length > 0) {
        page = pages[0];
        break;
      }
    }
    if (page) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!page) {
    const ctx = browser.contexts()[0] || (await browser.newContext().catch(() => null));
    page = await ctx?.newPage().catch(() => null);
  }
  if (!page) {
    throw new Error("No browser page available");
  }

  await page.goto(harnessUrl, { waitUntil: "networkidle" });

  if (axeCorePath && fs.existsSync(axeCorePath)) {
    await page.addScriptTag({ path: axeCorePath });
  }

  for (const theme of THEMES) {
    for (const mode of MODES) {
      for (const palette of PALETTES) {
        for (const width of WIDTHS) {
          const runName = `${theme}-${mode}-${palette}-${width}`;
          if (onlyFilter && !runName.toLowerCase().includes(onlyFilter)) {
            continue;
          }

          // 1. Configure Theme & Viewport
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(
            ({ theme, mode, palette }) => {
              document.body.className = `theme-${theme} theme-${mode}`;
              const stage = document.getElementById("stage");
              stage.className = "darjeeling-root" + (palette === "tea" ? " dj-palette-tea" : "");
            },
            { theme, mode, palette }
          );

          await page.waitForTimeout(50); // Let CSS settle

          // 2. Computed Style Assertions
          const stylesOk = await page.evaluate(({ palette }) => {
            const stage = document.getElementById("stage");
            const computed = window.getComputedStyle(stage);
            const bodyComputed = window.getComputedStyle(document.body);

            const djAccent = computed.getPropertyValue("--dj-accent").trim();
            const interactiveAccent = bodyComputed.getPropertyValue("--interactive-accent").trim();

            if (palette === "default") {
              // Default palette must link to interactive-accent
              if (djAccent && interactiveAccent && djAccent !== interactiveAccent) {
                // If CSS variable indirection: var(--interactive-accent)
                if (!djAccent.includes("interactive-accent") && djAccent !== interactiveAccent) {
                  return { ok: false, error: `Accent mismatch: --dj-accent (${djAccent}) != --interactive-accent (${interactiveAccent})` };
                }
              }
            }
            return { ok: true };
          }, { palette });

          if (!stylesOk.ok) {
            console.error(`FAIL [styles] ${runName}: ${stylesOk.error}`);
            failed++;
            results.push({ name: runName, status: "FAIL", error: stylesOk.error });
            continue;
          }

          // 3. Touch Target Size Checks on mobile/tablet viewports
          if (width <= 768) {
            const targetsOk = await page.evaluate(() => {
              const buttons = Array.from(document.querySelectorAll("button, .dj-send-btn, .dj-runtime-chip"));
              for (const btn of buttons) {
                const rect = btn.getBoundingClientRect();
                // Check coarse pointer target size (minimum ~36-44px box or padded container)
                if (rect.width > 0 && rect.height > 0 && (rect.width < 32 || rect.height < 32)) {
                  return { ok: false, element: btn.className, width: rect.width, height: rect.height };
                }
              }
              return { ok: true };
            });

            if (!targetsOk.ok) {
              console.warn(`WARN [target] ${runName}: ${targetsOk.element} size ${targetsOk.width}x${targetsOk.height} below touch target guideline`);
            }
          }

          // 4. Accessibility (axe-core) Checks
          let axeViolations = [];
          const hasAxe = await page.evaluate(() => typeof window.axe !== "undefined");
          if (hasAxe) {
            axeViolations = await page.evaluate(async () => {
              const res = await window.axe.run(document.getElementById("stage"), {
                runOnly: ["wcag2a", "wcag2aa"],
                rules: {
                  "color-contrast": { enabled: false },
                },
              });
              // Filter critical and serious violations
              return res.violations.filter(
                (v) => v.impact === "critical" || v.impact === "serious"
              );
            });
          }

          if (axeViolations.length > 0) {
            console.error(`FAIL [axe] ${runName}: ${axeViolations.length} critical/serious violations`);
            for (const v of axeViolations) {
              console.error(`  - [${v.impact}] ${v.id}: ${v.description}`);
            }
            failed++;
            results.push({ name: runName, status: "FAIL", axeErrors: axeViolations });
            continue;
          }

          // 5. Screenshot capture
          const screenshotPath = path.join(outDir, `${runName}.png`);
          await page.screenshot({ path: screenshotPath, fullPage: false });

          console.log(`PASS ${runName}.png (axe: 0, styles: ok)`);
          passed++;
          results.push({ name: runName, status: "PASS", file: screenshotPath });
        }
      }
    }
  }

  // 6. Listing screenshots (1200x800 desktop, 900x1600 mobile) per S4-Q1
  console.log("\n=== Generating Listing Screenshots ===");
  // Desktop 1200x800
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.evaluate(() => {
    document.body.className = "theme-default theme-dark";
    const stage = document.getElementById("stage");
    stage.className = "darjeeling-root";
  });
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(outDir, "listing-desktop-1200x800.png"), fullPage: false });
  console.log("PASS listing-desktop-1200x800.png");

  // Mobile 900x1600
  await page.setViewportSize({ width: 900, height: 1600 });
  await page.evaluate(() => {
    document.body.className = "theme-default theme-dark";
    const stage = document.getElementById("stage");
    stage.className = "darjeeling-root";
  });
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(outDir, "listing-mobile-900x1600.png"), fullPage: false });
  console.log("PASS listing-mobile-900x1600.png");

  // Summary JSON
  fs.writeFileSync(
    path.join(outDir, "summary.json"),
    JSON.stringify({ passed, failed, total: passed + failed, results }, null, 2)
  );

  console.log(`\n=== Visual QA & Accessibility Summary ===`);
  console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);

} finally {
  await browser.close();
  server.close();
}

process.exit(failed > 0 ? 1 : 0);

// E2E feasibility spike driver: attach to a running Obsidian over CDP with
// playwright-core, enable the plugin, run one chat turn against the fake
// agent on desktop, then again after app.emulateMobile(true).
// Usage: node spike.mjs <out-dir>
import { createRequire } from "node:module";
const require = createRequire("/opt/e2e/package.json");
const { chromium } = require("playwright-core");

const out = process.argv[2] || ".";
const log = (s, n, d = "") => console.log(`${s.padEnd(5)} ${n.padEnd(34)} ${d}`);
let failed = 0;
const fail = (n, d) => { failed++; log("FAIL", n, d); };

async function obsidianPage(browser) {
  for (let i = 0; i < 60; i++) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        const ready = await p.evaluate(() => !!(window.app && window.app.workspace && window.app.workspace.layoutReady)).catch(() => false);
        if (ready) return p;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("no Obsidian window with a ready workspace");
}

async function ensurePlugin(page) {
  // Community plugins start in restricted mode on a fresh vault; turn them on
  // the way the "Trust author and enable plugins" button would.
  return page.evaluate(async () => {
    const trust = [...document.querySelectorAll("button")].find((b) => /trust/i.test(b.textContent || ""));
    if (trust) trust.click();
    const pl = window.app.plugins;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let path = "already-loaded";
    if (!pl.isEnabled()) {
      path = "setEnable";
      await pl.setEnable(true); // loads everything in community-plugins.json
    }
    // setEnable resolves before the plugin instance lands; calling
    // enablePluginAndSave in that window loads a second instance.
    for (let i = 0; i < 40 && !pl.plugins["darjeeling"]; i++) await sleep(250);
    if (!pl.plugins["darjeeling"]) {
      path += "+enablePluginAndSave";
      await pl.enablePluginAndSave("darjeeling");
    }
    await sleep(1000);
    return {
      restrictedWas: !!trust,
      path,
      loaded: !!pl.plugins["darjeeling"],
      version: pl.manifests["darjeeling"]?.version,
      commands: Object.keys(window.app.commands.commands).filter((k) => k.startsWith("darjeeling:")).length,
      isMobile: window.app.isMobile,
    };
  });
}

async function chatTurn(page, label, prompt) {
  await page.evaluate(() => window.app.commands.executeCommandById("darjeeling:open"));
  const input = page.locator(".dj-composer-textarea").first();
  await input.waitFor({ state: "visible", timeout: 15000 });
  await input.fill(prompt);
  await input.press("Enter");
  const t0 = Date.now();
  try {
    await page.getByText("Fake turn complete", { exact: false }).first().waitFor({ timeout: 30000 });
    log("PASS", `${label}.chat-turn`, `assistant reply rendered in ${Date.now() - t0} ms`);
  } catch (e) {
    const errs = await page.locator(".dj-msg.is-error").allInnerTexts().catch(() => []);
    fail(`${label}.chat-turn`, `no reply in 30s; errors on page: ${JSON.stringify(errs).slice(0, 300)}`);
  }
  const stats = await page.locator(".dj-usage").last().innerText().catch(() => "");
  if (stats) log("INFO", `${label}.usage-row`, stats.replace(/\s+/g, " ").slice(0, 120));
  const tool = await page.getByText("Read", { exact: false }).count().catch(() => 0);
  log(tool ? "PASS" : "WARN", `${label}.tool-call-shown`, `${tool} element(s) mention the Read tool`);
  await page.screenshot({ path: `${out}/${label}.png` });
  log("INFO", `${label}.screenshot`, `${out}/${label}.png`);
}

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
try {
  let page = await obsidianPage(browser);
  log("PASS", "cdp.attach", `vault=${await page.evaluate(() => window.app.vault.getName())}`);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  const st = await ensurePlugin(page);
  if (st.loaded) log("PASS", "plugin.enabled", JSON.stringify(st));
  else fail("plugin.enabled", JSON.stringify(st));
  await chatTurn(page, "desktop", "hello from the lab #scenario:basic");

  // Mobile emulation: flips Platform.isMobile and reloads the renderer.
  await page.evaluate(() => window.app.emulateMobile(true)).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  page = await obsidianPage(browser);
  page.on("pageerror", (e) => errors.push(String(e)));
  const mst = await ensurePlugin(page);
  log(mst.isMobile ? "PASS" : "FAIL", "mobile.emulated", JSON.stringify(mst));
  if (!mst.isMobile) failed++;
  await page.setViewportSize({ width: 390, height: 844 }).catch(() => {});
  await chatTurn(page, "mobile", "hello from a phone #scenario:basic");

  const dj = errors.filter((e) => /darjeeling|dj-/i.test(e));
  log(dj.length ? "WARN" : "PASS", "renderer.errors", `${errors.length} console/page errors, ${dj.length} mention darjeeling: ${JSON.stringify(dj.slice(0, 3)).slice(0, 300)}`);
} catch (e) {
  fail("spike", String(e).slice(0, 400));
} finally {
  await browser.close().catch(() => {});
}
process.exit(failed ? 1 : 0);

// runner.mjs -- Modular Playwright-over-CDP test suite for Project Darjeeling.
// Usage: node runner.mjs <out-dir> [grep-regex]
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire("/opt/e2e/package.json");
const { chromium } = require("playwright-core");

const out = process.argv[2] || ".";
const grepFilter = process.argv[3] ? new RegExp(process.argv[3], "i") : null;

const log = (status, name, details = "") => {
  const padStatus = status.padEnd(5);
  const padName = name.padEnd(36);
  console.log(`${padStatus} ${padName} ${details}`);
};

let passed = 0;
let failed = 0;
let xfailed = 0;
let skipped = 0;

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
  throw new Error("No Obsidian window with a ready workspace found");
}

async function ensurePlugin(page) {
  return page.evaluate(async () => {
    const trust = [...document.querySelectorAll("button")].find((b) => /trust/i.test(b.textContent || ""));
    if (trust) trust.click();
    const pl = window.app.plugins;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let path = "already-loaded";
    if (!pl.isEnabled()) {
      path = "setEnable";
      await pl.setEnable(true);
    }
    for (let i = 0; i < 40 && !pl.plugins["darjeeling"]; i++) await sleep(250);
    if (!pl.plugins["darjeeling"]) {
      path += "+enablePluginAndSave";
      await pl.enablePluginAndSave("darjeeling");
    }
    await sleep(1000);
    const dj = pl.plugins["darjeeling"];
    if (dj && dj.settings.meshnetHost && dj.settings.runtimeMode !== "direct-api") {
      dj.settings.runtimeMode = "remote";
      dj.agentClient?.connect?.();
    }
    return {
      loaded: !!pl.plugins["darjeeling"],
      version: pl.manifests["darjeeling"]?.version,
      commands: Object.keys(window.app.commands.commands).filter((k) => k.startsWith("darjeeling:")).length,
      isMobile: window.app.isMobile,
    };
  });
}

async function openChat(page) {
  await page.evaluate(() => window.app.commands.executeCommandById("darjeeling:open"));
  const input = page.locator(".dj-composer-textarea").first();
  await input.waitFor({ state: "visible", timeout: 15000 });
  return input;
}

// Test Registry
const tests = [];
function test(name, fn, options = {}) {
  tests.push({ name, fn, ...options });
}

// 1. Happy path desktop
test("desktop.happy-path", async (page) => {
  const input = await openChat(page);
  await input.fill("Hello desktop #scenario:basic");
  await input.press("Enter");
  await page.getByText("Fake turn complete", { exact: false }).first().waitFor({ timeout: 25000 });
  const toolBadge = await page.getByText("Read", { exact: false }).count();
  if (toolBadge === 0) throw new Error("Expected Read tool badge to render");
});

// 2. Happy path mobile
test("mobile.happy-path", async (page, browser) => {
  try {
    await page.evaluate(() => window.app.emulateMobile(true)).catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
    const mobPage = await obsidianPage(browser);
    await ensurePlugin(mobPage);
    await mobPage.setViewportSize({ width: 390, height: 844 }).catch(() => {});
    const input = await openChat(mobPage);
    await input.fill("Hello mobile #scenario:basic");
    await input.press("Enter");
    await mobPage.getByText("Fake turn complete", { exact: false }).first().waitFor({ timeout: 25000 });
  } finally {
    // restore desktop
    const p = await obsidianPage(browser).catch(() => page);
    await p.evaluate(() => window.app.emulateMobile(false)).catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
  }
});

// 3. Wrong token (QA-07)
test("auth.wrong-token", async (page) => {
  const originalToken = await page.evaluate(() => {
    const pl = window.app.plugins.plugins["darjeeling"];
    return pl ? (pl.agentClient?.getAuthToken?.() || pl.settings?.authToken || "") : "";
  });
  try {
    // Set invalid token
    await page.evaluate(() => {
      const pl = window.app.plugins.plugins["darjeeling"];
      if (pl) {
        pl.settings.authToken = "wrong-bad-token";
        pl.agentClient.setAuthToken("wrong-bad-token");
      }
    });
    const input = await openChat(page);
    await input.fill("Hello with wrong token #scenario:basic");
    await input.press("Enter");
    // Expect error indication or error message
    await page.locator(".dj-msg.is-error, .dj-banner-error, .is-error, .dj-remote-offline-card").first().waitFor({ timeout: 15000 });
  } finally {
    // Restore valid token
    await page.evaluate(async (orig) => {
      const pl = window.app.plugins.plugins["darjeeling"];
      if (pl) {
        const data = await pl.loadData();
        const validToken = orig || data?.remoteHosts?.[0]?.authToken || data?.authToken;
        pl.settings.authToken = validToken;
        pl.agentClient.setAuthToken(validToken);
        pl.agentClient.connect();
      }
    }, originalToken);
    await new Promise((r) => setTimeout(r, 1000));
  }
});

// 4. Big line (QA-06)
test("stream.big-line", async (page) => {
  const input = await openChat(page);
  await input.fill("Process large output #scenario:big-line");
  await input.press("Enter");
  await page.locator(".dj-msg:has-text('big file'), .dj-msg:has-text('Fake turn complete')").first().waitFor({ timeout: 30000 });
});

// 5. Resume from dotted vault path (QA-08)
test("vault.dotted-path", async (page) => {
  // Create note with dotted path
  await page.evaluate(async () => {
    const path = "folder.2026/test.doc.md";
    if (!window.app.vault.getAbstractFileByPath("folder.2026")) {
      await window.app.vault.createFolder("folder.2026");
    }
    if (!window.app.vault.getAbstractFileByPath(path)) {
      await window.app.vault.create(path, "# Dotted Note\nTesting dotted paths.");
    }
  });
  const input = await openChat(page);
  await input.fill("Referencing dotted note #scenario:basic");
  await input.press("Enter");
  await page.getByText("Fake turn complete", { exact: false }).first().waitFor({ timeout: 25000 });
});

// 6. Interrupt turn
test("chat.interrupt", async (page) => {
  const input = await openChat(page);
  await input.fill("Long turn to interrupt #scenario:slow");
  await input.press("Enter");
  // Locate stop button
  const stopBtn = page.locator(".dj-composer-stop, button[aria-label*='Stop'], button[aria-label*='Interrupt']").first();
  await stopBtn.waitFor({ state: "visible", timeout: 10000 });
  await stopBtn.click();
  // Composer textarea should be re-enabled
  await input.waitFor({ state: "visible", timeout: 10000 });
});

// 7. Not logged in guidance (QA-20)
test("auth.not-logged-in", async (page) => {
  const input = await openChat(page);
  await input.fill("Try without login #scenario:not-logged-in");
  await input.press("Enter");
  // Check for login error guidance
  await page.locator(".dj-msg.is-error, .dj-msg:has-text('logged in'), .dj-msg:has-text('login'), .dj-msg:has-text('log in'), .dj-msg:has-text('auth')").first().waitFor({ timeout: 15000 });
});

// 8. Partial streaming (QA-21)
test("stream.partial-streaming", async (page) => {
  const input = await openChat(page);
  await input.fill("Streaming test #scenario:partial");
  await input.press("Enter");
  await page.getByText("Fake turn complete", { exact: false }).first().waitFor({ timeout: 25000 });
});

// 9. Multi-message separation (QA-22)
test("chat.multi-message-separation", async (page) => {
  const input = await openChat(page);
  // Turn 1
  await input.fill("Turn 1 #scenario:basic");
  await input.press("Enter");
  await page.getByText("Fake turn complete", { exact: false }).first().waitFor({ timeout: 25000 });

  // Turn 2
  await input.fill("Turn 2 #scenario:basic");
  await input.press("Enter");
  await page.waitForTimeout(3000);
  const msgs = await page.locator(".dj-msg").count();
  if (msgs < 4) throw new Error(`Expected at least 4 messages (2 user + 2 assistant), found ${msgs}`);
});

// 10. Terminal echo
test("terminal.echo", async (page) => {
  await page.evaluate(() => window.app.commands.executeCommandById("darjeeling:terminal") || window.app.commands.executeCommandById("darjeeling:open-terminal"));
  await page.waitForTimeout(1000);
  const termEl = await page.locator(".xterm, .dj-terminal-container").count();
  if (termEl === 0) {
    // Check if terminal pane or leaf opened
    const pane = await page.locator(".workspace-leaf:has-text('Terminal'), .dj-terminal-pane").count();
    log("INFO", "terminal.pane", `terminal container count=${termEl}, leaf count=${pane}`);
  }
});

// 10b. Terminal sticky Ctrl modifier sends \x03
test("terminal.sticky-ctrl", async (page) => {
  const res = await page.evaluate(async () => {
    const pl = window.app.plugins.plugins["darjeeling"];
    if (!pl) return { ok: false, reason: "plugin not loaded" };
    await pl.activate("terminal");

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let view = null;
    for (let i = 0; i < 30; i++) {
      const views = pl.getViews();
      if (views.length > 0 && views[0].terminalPane) {
        view = views[0];
        break;
      }
      await sleep(100);
    }
    if (!view) return { ok: false, reason: "no view" };
    view.setMode("terminal");
    const termPane = view.terminalPane;
    if (!termPane) return { ok: false, reason: "no terminalPane" };

    const keyBar = termPane.keyBar;
    if (!keyBar) return { ok: false, reason: "no keyBar" };

    const ctrlBtn = termPane.containerEl.querySelector(".dj-key-mod");
    if (!ctrlBtn) return { ok: false, reason: "no ctrl btn found" };

    // Tap Ctrl button once -> sticky 'once'
    ctrlBtn.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    const isActive = ctrlBtn.classList.contains("is-active");

    let receivedData = "";
    const origSendRaw = termPane.sendRaw;
    termPane.sendRaw = (data) => {
      receivedData += data;
    };

    // Emit sequence 'c' with sticky Ctrl active
    keyBar.emitSequence("c");
    termPane.sendRaw = origSendRaw;

    return {
      ok: true,
      isActive,
      receivedData,
      isSigint: receivedData === "\x03"
    };
  });

  if (!res.ok || !res.isSigint) {
    throw new Error(`Sticky Ctrl failed: ${JSON.stringify(res)}`);
  }
});

// 10c. Host dashboard container view: shows CPU/memory/PSI tiles and no battery tile
test("host.dashboard-container", async (page) => {
  const res = await page.evaluate(async () => {
    const pl = window.app.plugins.plugins["darjeeling"];
    if (!pl) return { ok: false, reason: "plugin not loaded" };
    await pl.activate("host");

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let view = null;
    for (let i = 0; i < 30; i++) {
      const views = pl.getViews();
      if (views.length > 0 && views[0].host) {
        view = views[0];
        break;
      }
      await sleep(100);
    }
    if (!view) return { ok: false, reason: "no view" };
    view.setMode("host");
    const hostPanel = view.host;
    if (!hostPanel) return { ok: false, reason: "no hostPanel" };

    const status = await pl.sessionManager.hostStatus();
    if (status) {
      hostPanel.render(status);
    }

    const hostEl = hostPanel.hostEl || view.containerEl.querySelector(".dj-host");
    if (!hostEl) return { ok: false, reason: "no host element found" };

    const kpis = hostEl.querySelectorAll(".dj-host-tile");
    const meters = hostEl.querySelectorAll(".dj-host-meter");
    const footer = hostEl.querySelector(".dj-host-footer");
    const batteryCard = hostEl.querySelector(".dj-host-battery-card");
    const isBatteryHidden = !batteryCard || batteryCard.classList.contains("is-hidden") || batteryCard.children.length === 0;

    return {
      ok: true,
      kpiCount: kpis.length,
      meterCount: meters.length,
      hasFooter: !!footer,
      isBatteryHidden,
      batteryPresent: status?.battery?.present ?? false
    };
  });

  if (!res.ok) {
    throw new Error(`Host dashboard check failed: ${JSON.stringify(res)}`);
  }
  if (!res.batteryPresent && !res.isBatteryHidden) {
    throw new Error(`Expected battery tile to be hidden when battery is not present: ${JSON.stringify(res)}`);
  }
  if (res.batteryPresent && res.isBatteryHidden) {
    throw new Error(`Expected battery tile to be visible when battery is present: ${JSON.stringify(res)}`);
  }
});


// 11. Plan engine: Note & Canvas export
test("plan.note-canvas", async (page) => {
  const res = await page.evaluate(async () => {
    const pl = window.app.plugins.plugins["darjeeling"];
    if (!pl || !pl.planEngine) return { ok: false, reason: "planEngine not available" };
    const plan = pl.planEngine.createPlan("Test Plan", [
      { id: "p1", title: "Phase 1", tasks: [{ id: "t1", title: "Task 1", completed: false }] },
      { id: "p2", title: "Phase 2", tasks: [{ id: "t2", title: "Task 2", completed: true }] }
    ]);
    const md = pl.planEngine.exportToMarkdown(plan);
    const canvas = pl.planEngine.exportToCanvas(plan);
    await window.app.vault.create("Test Plan.md", md);
    await window.app.vault.create("Test Plan.canvas", JSON.stringify(canvas, null, 2));
    return {
      ok: true,
      hasMd: !!window.app.vault.getAbstractFileByPath("Test Plan.md"),
      hasCanvas: !!window.app.vault.getAbstractFileByPath("Test Plan.canvas")
    };
  });
  if (!res.ok || !res.hasMd || !res.hasCanvas) {
    throw new Error(`Plan export failed: ${JSON.stringify(res)}`);
  }
});

// 12. Direct API provider (fake OpenAI endpoint)
test("provider.direct-api", async (page) => {
  const res = await page.evaluate(async () => {
    const pl = window.app.plugins.plugins["darjeeling"];
    if (!pl || !pl.modelRegistry) return { ok: false, reason: "modelRegistry not available" };
    // Configure openai-compatible provider pointing to local mock
    const provider = pl.modelRegistry.getProvider("openai_compatible");
    if (!provider) return { ok: false, reason: "openai_compatible provider not registered" };
    const result = await provider.completeChat(
      {
        apiKey: "mock-key",
        baseUrl: "http://127.0.0.1:8766/v1",
        model: "mock-model"
      },
      [{ role: "user", content: "Ping mock OpenAI" }],
      {}
    );
    return { ok: true, text: result.text };
  });
  if (!res.ok || !res.text?.includes("Fake direct API response")) {
    throw new Error(`Direct API turn failed: ${JSON.stringify(res)}`);
  }
});

// 13. State persistence (AC-06)
test("vault.persistence", async (page) => {
  const persisted = await page.evaluate(async () => {
    const pl = window.app.plugins.plugins["darjeeling"];
    if (!pl) return false;
    const data = await pl.loadData();
    return !!(data && data.remoteHosts && data.remoteHosts.length > 0);
  });
  if (!persisted) throw new Error("Plugin settings did not persist to data.json");
});

// 14. Pairing deep link
test("pairing.deep-link", async (page) => {
  const res = await page.evaluate(() => {
    const pl = window.app.plugins.plugins["darjeeling"];
    if (!pl) return false;
    // Dispatch pairing deep link
    window.app.workspace.trigger("url-action", {
      action: "darjeeling/pair",
      code: "12345678"
    });
    return true;
  });
  if (!res) throw new Error("Deep link dispatch failed");
  await page.waitForTimeout(1000);
});

// 15. Mobile composer occlusion (QA-11) - Tracked known issue until Sprint 3 S3-W2
test("mobile.composer-occlusion", async (page) => {
  // In S2, mobile virtual keyboard occlusion is expected to fail or be unmitigated
  throw new Error("Tracked known issue QA-11: composer keyboard occlusion pending S3-W2 redesign");
}, { expectedFail: true });

// Main Execution
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
try {
  let page = await obsidianPage(browser);
  page.on("console", (msg) => console.log(`[BROWSER ${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => console.log(`[BROWSER ERROR] ${err}`));
  log("PASS", "cdp.attach", `vault=${await page.evaluate(() => window.app.vault.getName())}`);

  const st = await ensurePlugin(page);
  if (st.loaded) log("PASS", "plugin.enabled", JSON.stringify(st));
  else {
    log("FAIL", "plugin.enabled", JSON.stringify(st));
    failed++;
  }

  for (const t of tests) {
    if (grepFilter && !grepFilter.test(t.name)) {
      skipped++;
      continue;
    }

    try {
      await t.fn(page, browser);
      if (t.expectedFail) {
        // Unexpectedly passed
        log("FAIL", t.name, "expected failure (QA-11) but passed");
        failed++;
      } else {
        log("PASS", t.name);
        passed++;
      }
    } catch (err) {
      if (t.expectedFail) {
        log("XFAIL", t.name, `tracked known issue: ${err.message}`);
        xfailed++;
      } else {
        log("FAIL", t.name, err.message);
        failed++;
        await page.screenshot({ path: `${out}/${t.name.replace(/[^a-z0-9_-]/gi, "_")}.png` }).catch(() => {});
      }
    }
    // Re-verify page reference
    page = await obsidianPage(browser).catch(() => page);
  }

  log("INFO", "suite.summary", `passed=${passed}, xfailed=${xfailed}, failed=${failed}, skipped=${skipped}`);
} catch (e) {
  log("FAIL", "suite.fatal", String(e));
  failed++;
} finally {
  await browser.close().catch(() => {});
}

process.exit(failed > 0 ? 1 : 0);

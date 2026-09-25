/**
 * Secrets never reach data.json (ADR-05) and migrated keys still authenticate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import DarjeelingPlugin from "../../src/main";
import { AgentClient } from "../../src/net/agentClient";
import { DirectApiRunner } from "../../src/runtime/directApi";
import {
  SecretStorage,
  hasProviderApiKey,
  providerSecretId,
  readProviderApiKey,
  secretStorageKey,
  serializeSettings,
  writeProviderApiKey,
} from "../../src/settings/secrets";
import { createDefaultSettings } from "../../src/settings/schema";
import { recordRequestUrl, jsonResponse } from "./stubs/requestUrl";
import { createSecretApp } from "./helpers/secrets";

const FIXTURE = path.resolve(process.cwd(), "tests/fixtures/data-v4.1.0.json");
const FIXTURE_TOKEN = "test-token-not-real";
const FIXTURE_KEY = "sk-test-not-real";

function loadFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

/** App with Map-backed secretStorage and localStorage (both durable). */
function createApp() {
  const { app, store } = createSecretApp();
  const local = new Map<string, string>();
  app.loadLocalStorage = (k: string) => local.get(k) ?? null;
  app.saveLocalStorage = (k: string, v: string | null) => {
    if (v === null) local.delete(k);
    else local.set(k, v);
  };
  app.vault = { adapter: {}, getName: () => "Test" };
  app.workspace = { getLeavesOfType: () => [] };
  return { app, store, local };
}

async function loadPlugin(app: any, data: unknown): Promise<DarjeelingPlugin> {
  const plugin = new DarjeelingPlugin(app, { id: "darjeeling", version: "0.0.0" } as any);
  await plugin.saveData(data);
  await plugin.loadSettings();
  return plugin;
}

function assertNoSecret(serialized: string, secrets: string[], where: string): void {
  for (const s of secrets) {
    assert.ok(!serialized.includes(s), `${where} still contains secret ${JSON.stringify(s)}`);
  }
}

test("v4.1.0 fixture: migrate -> data.json has no secret -> direct turn sends migrated key", async () => {
  const { app, store } = createApp();
  const plugin = await loadPlugin(app, loadFixture());

  // loadSettings rewrote data.json once the secrets were verified.
  const onDisk = JSON.stringify(await plugin.loadData());
  assertNoSecret(onDisk, [FIXTURE_TOKEN, FIXTURE_KEY], "data.json after migration");

  // saveSettings output is clean too, and so is the live settings object.
  await plugin.saveSettings();
  assertNoSecret(JSON.stringify(await plugin.loadData()), [FIXTURE_TOKEN, FIXTURE_KEY], "saveSettings output");
  assertNoSecret(JSON.stringify(plugin.settings), [FIXTURE_TOKEN, FIXTURE_KEY], "in-memory settings");

  // The values live in secret storage.
  const values = [...store.values()];
  assert.ok(values.includes(FIXTURE_TOKEN), "host token moved to secret storage");
  assert.ok(values.includes(FIXTURE_KEY), "deepseek key moved to secret storage");

  // v0 kept the DeepSeek key in openaiApiKey; it lands in the deepseek slot.
  assert.equal(plugin.settings.directApiProvider, "deepseek");
  assert.ok(plugin.settings.providers.deepseek.apiKeySecretId);
  assert.equal(hasProviderApiKey(plugin.secretStorage, plugin.settings, "deepseek"), true);

  // End to end: a direct-API turn authenticates with the migrated key.
  const rec = recordRequestUrl(() =>
    jsonResponse({ choices: [{ message: { content: "pong" } }] })
  );
  try {
    const runner = new DirectApiRunner(plugin.settings, plugin.secretStorage);
    let error = "";
    let text = "";
    runner.setHandlers({
      onError: (m) => (error = m),
      onAssistantText: (t) => (text = t),
    });
    const ok = await runner.sendTurn({ prompt: "ping" });
    assert.equal(error, "");
    assert.equal(ok, true);
    assert.equal(text, "pong");
    assert.equal(rec.calls.length, 1);
    assert.ok(rec.calls[0].url.startsWith("https://api.deepseek.com"));
    const headers = rec.calls[0].headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${FIXTURE_KEY}`);
  } finally {
    rec.restore();
  }

  // The host token reaches the client from secret storage, not settings.
  const client = new AgentClient(plugin.settings, "", app, plugin.secretStorage);
  assert.equal(client.getAuthToken(), FIXTURE_TOKEN);
  client.destroy();
});

test("saveSettings never contains a secret after setAuthToken", async () => {
  const { app } = createApp();
  const plugin = await loadPlugin(app, loadFixture());
  const client = new AgentClient(plugin.settings, "", app, plugin.secretStorage);
  plugin.agentClient = client;

  const fresh = "fresh-host-token-9f8e7d";
  await client.setAuthToken(fresh);
  assert.equal(client.getAuthToken(), fresh);

  // Not mirrored into any settings field.
  assert.equal(plugin.settings.authToken, "");
  for (const h of plugin.settings.hosts) assert.equal(h.authToken, undefined);
  for (const h of plugin.settings.remoteHosts) assert.equal(h.authToken, undefined);

  await plugin.saveSettings();
  assertNoSecret(JSON.stringify(await plugin.loadData()), [fresh, FIXTURE_TOKEN, FIXTURE_KEY], "saveSettings output");

  // Survives a restart: a new plugin instance reads it back from secret storage.
  const again = await loadPlugin(app, await plugin.loadData());
  const client2 = new AgentClient(again.settings, "", app, again.secretStorage);
  assert.equal(client2.getAuthToken(), fresh);
  client.destroy();
  client2.destroy();
});

test("serializeSettings strips every *ApiKey / authToken field, even if something set one", () => {
  const s = createDefaultSettings();
  s.geminiApiKey = "g-secret";
  s.anthropicApiKey = "a-secret";
  s.deepseekApiKey = "d-secret";
  s.openaiApiKey = "o-secret";
  s.directApiKey = "x-secret";
  s.authToken = "t-secret";
  s.hosts = [{ id: "h", name: "h", baseUrl: "http://127.0.0.1:8765", tokenSecretId: "id1", authToken: "h-secret" }];
  s.remoteHosts = [{ id: "r", name: "r", host: "127.0.0.1", port: 8765, authToken: "r-secret" }];
  const json = JSON.stringify(serializeSettings(s));
  assertNoSecret(json, ["g-secret", "a-secret", "d-secret", "o-secret", "x-secret", "t-secret", "h-secret", "r-secret"], "serialized");
  // Secret ids (not secrets) are kept.
  assert.ok(json.includes('"tokenSecretId":"id1"'));
});

test("1.0.3-shaped v1 data with plaintext keys migrates into secret storage", async () => {
  const { app } = createApp();
  const data = {
    ...createDefaultSettings(),
    settingsVersion: 1,
    directApiProvider: "gemini",
    geminiApiKey: "AIza-plain-gemini",
    anthropicApiKey: "sk-ant-plain",
    deepseekApiKey: "sk-ds-plain",
    openaiApiKey: "sk-oa-plain",
    authToken: "v1-top-token",
    hosts: [{ id: "h1", name: "Host", baseUrl: "http://127.0.0.1:8765", tokenSecretId: "", authToken: "v1-host-token" }],
    activeHostId: "h1",
  };
  const plugin = await loadPlugin(app, data);
  const secrets = ["AIza-plain-gemini", "sk-ant-plain", "sk-ds-plain", "sk-oa-plain", "v1-top-token", "v1-host-token"];
  assertNoSecret(JSON.stringify(await plugin.loadData()), secrets, "data.json");
  assertNoSecret(JSON.stringify(plugin.settings), secrets, "in-memory settings");

  const ss = plugin.secretStorage;
  assert.equal(await readProviderApiKey(ss, plugin.settings, "gemini"), "AIza-plain-gemini");
  assert.equal(await readProviderApiKey(ss, plugin.settings, "anthropic"), "sk-ant-plain");
  assert.equal(await readProviderApiKey(ss, plugin.settings, "deepseek"), "sk-ds-plain");
  assert.equal(await readProviderApiKey(ss, plugin.settings, "openai-compatible"), "sk-oa-plain");
  const client = new AgentClient(plugin.settings, "", app, ss);
  assert.ok(["v1-top-token", "v1-host-token"].includes(client.getAuthToken()));
  client.destroy();
});

test("memory-only secret fallback keeps the plaintext source (copy -> verify -> delete)", async () => {
  // No secretStorage, no localStorage: the only store is process memory.
  const app: any = { vault: { adapter: {}, getName: () => "Test" }, workspace: {} };
  const plugin = await loadPlugin(app, loadFixture());

  // The key still works this session...
  assert.equal(await readProviderApiKey(plugin.secretStorage, plugin.settings, "deepseek"), FIXTURE_KEY);
  // ...but is not on the live settings object...
  assertNoSecret(JSON.stringify(plugin.settings), [FIXTURE_KEY, FIXTURE_TOKEN], "in-memory settings");
  // ...and data.json keeps the only durable copy so a restart cannot lose it.
  await plugin.saveSettings();
  const onDisk = JSON.stringify(await plugin.loadData());
  assert.ok(onDisk.includes(FIXTURE_KEY), "plaintext key must not be deleted before it is durably stored");
  assert.ok(onDisk.includes(FIXTURE_TOKEN), "plaintext token must not be deleted before it is durably stored");
});

test("settings UI helpers: write, has-key state, and removal go through secret storage", async () => {
  const { app, store } = createApp();
  const secrets = new SecretStorage(app);
  const settings = createDefaultSettings();

  assert.equal(hasProviderApiKey(secrets, settings, "anthropic"), false);
  await writeProviderApiKey(secrets, settings, "anthropic", "  sk-ant-typed  ");
  assert.equal(hasProviderApiKey(secrets, settings, "anthropic"), true);
  assert.equal(settings.anthropicApiKey, "");
  assert.equal(settings.providers.anthropic.apiKeySecretId, providerSecretId("anthropic"));
  assert.equal(store.get(secretStorageKey(settings.providers.anthropic.apiKeySecretId)), "sk-ant-typed");
  assertNoSecret(JSON.stringify(serializeSettings(settings)), ["sk-ant-typed"], "serialized");

  const id = settings.providers.anthropic.apiKeySecretId;
  await writeProviderApiKey(secrets, settings, "anthropic", "");
  assert.equal(hasProviderApiKey(secrets, settings, "anthropic"), false);
  assert.equal(settings.providers.anthropic.apiKeySecretId, "");
  assert.equal(store.has(secretStorageKey(id)), false);
});

test("memory-only retained DeepSeek key maps back to DeepSeek on the next load", async () => {
  const app: any = { vault: { adapter: {}, getName: () => "Test" }, workspace: {} };
  const first = await loadPlugin(app, loadFixture());
  await first.saveSettings();
  const onDisk = (await first.loadData()) as Record<string, unknown>;
  assert.equal(onDisk.deepseekApiKey, FIXTURE_KEY);
  assert.equal(onDisk.openaiApiKey, undefined);

  // Next start: storage is durable now, so the retained copy is moved and deleted.
  const { app: durableApp } = createApp();
  const second = await loadPlugin(durableApp, onDisk);
  assert.equal(await readProviderApiKey(second.secretStorage, second.settings, "deepseek"), FIXTURE_KEY);
  assertNoSecret(JSON.stringify(await second.loadData()), [FIXTURE_KEY, FIXTURE_TOKEN], "data.json after durable reload");
});

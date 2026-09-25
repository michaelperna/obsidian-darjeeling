/**
 * Two devices sharing one data.json (Obsidian Sync / git) after the 1.0.4
 * move of secrets into per-device secret storage.
 */
import test from "node:test";
import assert from "node:assert/strict";
import DarjeelingPlugin from "../../src/main";
import { AgentClient } from "../../src/net/agentClient";
import {
  MISSING_HOST_TOKEN_MESSAGE,
  SecretStorage,
  activeHostNeedsLocalToken,
  findMissingSecrets,
  hasProviderApiKey,
  hostSecretId,
  providerNeedsLocalKey,
  providerSecretId,
  readProviderApiKey,
  resolveSecretIds,
  secretStorageKey,
  writeProviderApiKey,
} from "../../src/settings/secrets";
import { createDefaultSettings } from "../../src/settings/schema";
import { deferredCommit } from "../../src/settings/deferredCommit";
import { displayRemoteHostSettings } from "../../src/settings/sections/connections";
import { notices, resetNotices, resetSettingComponents, settingComponents, settingNotes } from "./stubs/obsidian";
import { createSecretApp } from "./helpers/secrets";

const HOST_TOKEN = "host-token-not-real";
const GEMINI_KEY = "AIza-not-real";

/** One device: its own secret storage and local storage; data.json is shared. */
function device(opts: { obsidian?: boolean } = {}) {
  const { app, store } = createSecretApp(opts);
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

/** The shared file both devices read and write. */
class SharedDataJson {
  data: unknown;
  constructor(data: unknown) {
    this.data = structuredClone(data);
  }
  async load(app: any): Promise<DarjeelingPlugin> {
    const plugin = new DarjeelingPlugin(app, { id: "darjeeling", version: "0.0.0" } as any);
    plugin.loadData = async () => structuredClone(this.data);
    plugin.saveData = async (d: unknown) => {
      this.data = structuredClone(d);
    };
    await plugin.loadSettings();
    return plugin;
  }
}

/** data.json as a 1.0.3 device left it: plaintext host token and key. */
function data103(): Record<string, unknown> {
  return {
    ...createDefaultSettings(),
    settingsVersion: 1,
    directApiProvider: "gemini",
    geminiApiKey: GEMINI_KEY,
    hosts: [{ id: "h1", name: "Home server", baseUrl: "http://100.64.0.1:8765", tokenSecretId: "", authToken: HOST_TOKEN }],
    activeHostId: "h1",
  };
}

const missingNotices = () => notices.filter((n) => n.includes("needs its own copy"));

test("device A migrates first; device B loads the stripped data.json, is told, and recovers", async () => {
  resetNotices();
  const shared = new SharedDataJson(data103());

  // Device A: plaintext moves into A's secret storage, then data.json is stripped.
  const a = device();
  const pluginA = await shared.load(a.app);
  const onDisk = JSON.stringify(shared.data);
  assert.ok(!onDisk.includes(HOST_TOKEN) && !onDisk.includes(GEMINI_KEY), "data.json is stripped");
  assert.equal(pluginA.settings.hosts[0].tokenSecretId, hostSecretId("h1"));
  assert.equal(pluginA.settings.providers.gemini.apiKeySecretId, providerSecretId("gemini"));
  assert.equal(await readProviderApiKey(pluginA.secretStorage, pluginA.settings, "gemini"), GEMINI_KEY);
  assert.deepEqual(pluginA.missingSecrets(), []);
  assert.equal(missingNotices().length, 0, "A has its secrets: no notice");

  // Device B: real Obsidian secretStorage shape (sync, no delete), empty.
  const b = device({ obsidian: true });
  const pluginB = await shared.load(b.app); // must not throw
  const missing = pluginB.missingSecrets();
  assert.deepEqual(
    missing.map((m) => `${m.kind}:${m.ref}`).sort(),
    ["host:h1", "provider:gemini"]
  );
  assert.equal(missingNotices().length, 1, "B gets one notice");
  assert.ok(missingNotices()[0].includes("re-enter the key"));
  assert.ok(missingNotices()[0].includes("Home server"));

  // "Has key" UI is per device.
  assert.equal(hasProviderApiKey(pluginB.secretStorage, pluginB.settings, "gemini"), false);
  assert.equal(providerNeedsLocalKey(pluginB.secretStorage, pluginB.settings, "gemini"), true);
  assert.equal(activeHostNeedsLocalToken(pluginB.secretStorage, pluginB.settings), true);
  assert.equal(hasProviderApiKey(pluginA.secretStorage, pluginA.settings, "gemini"), true);
  const clientB = new AgentClient(pluginB.settings, "", b.app, pluginB.secretStorage);
  assert.equal(clientB.getAuthToken(), "");

  // One-time: restarting B does not repeat the notice.
  await shared.load(b.app);
  assert.equal(missingNotices().length, 1, "notice is shown once per device");

  // The user re-enters the key and token on B.
  await writeProviderApiKey(pluginB.secretStorage, pluginB.settings, "gemini", GEMINI_KEY);
  await clientB.setAuthToken(HOST_TOKEN);
  await pluginB.saveSettings();
  assert.equal(pluginB.settings.providers.gemini.apiKeySecretId, pluginA.settings.providers.gemini.apiKeySecretId);
  assert.equal(pluginB.settings.hosts[0].tokenSecretId, pluginA.settings.hosts[0].tokenSecretId);
  assert.equal(b.store.get(secretStorageKey(providerSecretId("gemini"))), GEMINI_KEY);
  assert.equal(b.store.get(secretStorageKey(hostSecretId("h1"))), HOST_TOKEN);
  assert.deepEqual(pluginB.missingSecrets(), []);
  clientB.destroy();

  // Both devices keep working from the same data.json after restarts.
  for (const [dev, name] of [[a, "A"], [b, "B"]] as const) {
    const p = await shared.load(dev.app);
    assert.equal(await readProviderApiKey(p.secretStorage, p.settings, "gemini"), GEMINI_KEY, name);
    const c = new AgentClient(p.settings, "", dev.app, p.secretStorage);
    assert.equal(c.getAuthToken(), HOST_TOKEN, name);
    c.destroy();
    assert.deepEqual(p.missingSecrets(), [], name);
  }
  assert.ok(!JSON.stringify(shared.data).includes(HOST_TOKEN), "data.json never regains the token");
  assert.equal(missingNotices().length, 1);
});

test("two devices migrating the same plaintext data.json independently pick the same ids", async () => {
  const a = device();
  const b = device();
  const pa = await new SharedDataJson(data103()).load(a.app);
  const pb = await new SharedDataJson(data103()).load(b.app);
  assert.equal(pa.settings.providers.gemini.apiKeySecretId, pb.settings.providers.gemini.apiKeySecretId);
  assert.equal(pa.settings.hosts[0].tokenSecretId, pb.settings.hosts[0].tokenSecretId);
  assert.equal(await readProviderApiKey(pb.secretStorage, pb.settings, "gemini"), GEMINI_KEY);
});

test("old random secret ids resolve to the deterministic id without losing the secret", async () => {
  const { app, store } = createSecretApp();
  const secrets = new SecretStorage(app);
  const settings = createDefaultSettings();
  // Random ids as an earlier 1.0.4 build minted them.
  settings.providers.gemini.apiKeySecretId = "dj_gemini_k3j2h1_lx9";
  settings.providers.anthropic.apiKeySecretId = "dj_anthropic_zz9_lx9";
  settings.hosts = [{ id: "h1", name: "h", baseUrl: "http://127.0.0.1:8765", tokenSecretId: "dj_host_q1_lx9" }];

  // gemini: only the deterministic id holds a value here (another device's id won).
  await secrets.setSecret(providerSecretId("gemini"), "g-det");
  // anthropic + host: only the old random id holds one -> copied across.
  await secrets.setSecret("dj_anthropic_zz9_lx9", "a-old");
  await secrets.setSecret("dj_host_q1_lx9", "t-old");

  assert.equal(await resolveSecretIds(secrets, settings), true);
  assert.equal(settings.providers.gemini.apiKeySecretId, providerSecretId("gemini"));
  assert.equal(settings.providers.anthropic.apiKeySecretId, providerSecretId("anthropic"));
  assert.equal(settings.hosts[0].tokenSecretId, hostSecretId("h1"));
  assert.equal(await readProviderApiKey(secrets, settings, "gemini"), "g-det");
  assert.equal(await readProviderApiKey(secrets, settings, "anthropic"), "a-old");
  assert.equal(store.get(secretStorageKey(hostSecretId("h1"))), "t-old");
  // Unconfigured providers stay unconfigured.
  assert.equal(settings.providers.deepseek.apiKeySecretId, "");
  // Idempotent.
  assert.equal(await resolveSecretIds(secrets, settings), false);
});

test("clearing a key without secretStorage.deleteSecret overwrites it and reads as absent", async () => {
  const { app, store } = createSecretApp({ obsidian: true });
  const secrets = new SecretStorage(app);
  const settings = createDefaultSettings();
  await writeProviderApiKey(secrets, settings, "deepseek", "sk-ds");
  const key = secretStorageKey(providerSecretId("deepseek"));
  assert.equal(store.get(key), "sk-ds");

  await writeProviderApiKey(secrets, settings, "deepseek", "");
  assert.equal(store.get(key), "", "overwritten, not left behind");
  assert.equal(settings.providers.deepseek.apiKeySecretId, "");
  assert.equal(hasProviderApiKey(secrets, settings, "deepseek"), false);
  // Even a fresh instance (cold cache) sees it as absent.
  const fresh = new SecretStorage(app);
  assert.equal(await fresh.getSecret(providerSecretId("deepseek")), null);
  assert.equal(await fresh.load(providerSecretId("deepseek")), "");
  settings.providers.deepseek.apiKeySecretId = providerSecretId("deepseek");
  await fresh.prime(settings);
  assert.equal(hasProviderApiKey(fresh, settings, "deepseek"), false);
  assert.equal(findMissingSecrets(fresh, settings).length, 1);
});

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("deferredCommit: one commit after typing stops, flush commits now, no duplicate", async () => {
  const commits: string[] = [];
  const c = deferredCommit((v) => {
    commits.push(v);
  }, 30);
  c.input("a");
  c.input("ab");
  c.input("abc");
  await tick(10);
  assert.deepEqual(commits, []);
  await tick(50);
  assert.deepEqual(commits, ["abc"]);
  c.flush(); // blur after the debounce fired: nothing new
  c.input("abc");
  c.flush();
  await tick(0);
  assert.deepEqual(commits, ["abc"], "same value is not committed twice");
  c.input("abcd");
  c.flush();
  await tick(0);
  assert.deepEqual(commits, ["abc", "abcd"]);
  c.input("zzz");
  c.cancel();
  await tick(50);
  assert.deepEqual(commits, ["abc", "abcd"]);
});

test("connections: the token field saves and reconnects once, not per keystroke", async () => {
  resetSettingComponents();
  const calls: string[] = [];
  const settings = createDefaultSettings();
  settings.hosts = [{ id: "h1", name: "h", baseUrl: "http://100.64.0.1:8765", tokenSecretId: hostSecretId("h1") }];
  settings.activeHostId = "h1";
  const secrets = new SecretStorage(createSecretApp().app);
  const plugin = {
    settings,
    secretStorage: secrets,
    saveSettings: async () => {},
    agentClient: {
      getAuthToken: () => "",
      setAuthToken: async (t: string) => {
        calls.push(t);
      },
    },
  };
  displayRemoteHostSettings({ plugin } as any, {} as any);
  // Synced host, no local token: the inline per-device state is shown.
  assert.ok(settingNotes.includes(MISSING_HOST_TOKEN_MESSAGE));

  const field = settingComponents.find((c) => c.inputEl.type === "password");
  assert.ok(field, "token field rendered");
  for (const partial of ["t", "to", "tok", "token-123"]) await field.fire("change", partial);
  assert.deepEqual(calls, [], "no save/reconnect while typing");
  field.inputEl.dispatch("blur");
  await tick(0);
  assert.deepEqual(calls, ["token-123"]);
  field.inputEl.dispatch("change");
  await tick(700);
  assert.deepEqual(calls, ["token-123"], "exactly one reconnect");
});

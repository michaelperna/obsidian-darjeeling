import test from "node:test";
import assert from "node:assert/strict";
import {
  migrateSettings,
  isHostPaired,
  shouldPromptRuntimeChoice,
  CURRENT_SETTINGS_VERSION,
} from "../../src/settings/migrate";
import { SecretStorage } from "../../src/settings/secrets";
import { notices } from "./stubs/obsidian";
import type { HostConfig } from "../../src/settings/schema";

class MockSecretStorage extends SecretStorage {
  private store = new Map<string, string>();

  constructor() {
    super({} as any);
  }

  async getSecret(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async setSecret(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async deleteSecret(key: string): Promise<void> {
    this.store.delete(key);
  }
}

test("migrateSettings migrates v0 settings, moves secrets, and preserves user values", async () => {
  const secrets = new MockSecretStorage();
  const v0Data: Record<string, unknown> = {
    authToken: "super-secret-token-123",
    geminiApiKey: "gemini-key-abc",
    anthropicApiKey: "anthropic-key-xyz",
    openaiApiKey: "deepseek-key-456",
    directApiProvider: "deepseek",
    openaiBaseUrl: "https://api.deepseek.com",
    openaiModel: "deepseek-chat",
    model: "claude-opus-5",
    permissionMode: "bypassPermissions",
    defaultPermissionMode: "acceptAll",
    meshnetHost: "192.168.1.50",
    port: 9000,
    remoteCwd: "/workspace/vault",
    artifactFolder: "Custom/Artifacts",
    savePlansToVault: false,
    terminalProfiles: [
      { id: "custom-p", name: "Custom Tool", type: "local", executable: "custom-bin" },
    ],
  };

  const migrated = await migrateSettings(v0Data, secrets);

  // Settings version updated
  assert.equal(migrated.settingsVersion, CURRENT_SETTINGS_VERSION);

  // Plaintext secrets deleted from settings object
  assert.equal(migrated.authToken, "");
  assert.equal(migrated.geminiApiKey, "");
  assert.equal(migrated.anthropicApiKey, "");
  assert.equal(migrated.openaiApiKey, "");

  // Secrets stored in SecretStorage
  const host = migrated.hosts.find((h) => h.id === "primary");
  assert.ok(host);
  assert.ok(host.tokenSecretId);
  const storedToken = await secrets.getSecret(host.tokenSecretId);
  assert.equal(storedToken, "super-secret-token-123");

  const geminiSecretId = migrated.providers.gemini.apiKeySecretId;
  assert.ok(geminiSecretId);
  assert.equal(await secrets.getSecret(geminiSecretId), "gemini-key-abc");

  const anthropicSecretId = migrated.providers.anthropic.apiKeySecretId;
  assert.ok(anthropicSecretId);
  assert.equal(await secrets.getSecret(anthropicSecretId), "anthropic-key-xyz");

  const deepseekSecretId = migrated.providers.deepseek.apiKeySecretId;
  assert.ok(deepseekSecretId);
  assert.equal(await secrets.getSecret(deepseekSecretId), "deepseek-key-456");

  // User configurations preserved
  assert.equal(migrated.artifactFolder, "Custom/Artifacts");
  assert.equal(migrated.savePlansToVault, false);
  assert.equal(migrated.meshnetHost, "192.168.1.50");
  assert.equal(migrated.port, 9000);
  assert.equal(migrated.remoteCwd, "/workspace/vault");
  assert.equal(migrated.terminalProfiles.length, 1);
  assert.equal(migrated.terminalProfiles[0].id, "custom-p");

  // Safety checks: permissions clamped to plan
  assert.equal(migrated.permissionMode, "plan");
  assert.equal(migrated.defaultPermissionMode, "plan");

  // Model IDs preserved without silent remap (ADR-08)
  assert.equal(migrated.model, "claude-opus-5");
  assert.equal(migrated.providers.deepseek.model, "deepseek-chat");
});

test("Sync Rule 1: Newer settings version sets _readOnly: true and emits Notice", async () => {
  notices.length = 0;
  const futureData = {
    settingsVersion: 99,
    artifactFolder: "Future",
  };

  const result = await migrateSettings(futureData);
  assert.equal(result._readOnly, true);
  assert.ok(notices.some((n) => n.includes("newer version (v99)")));
});

test("Sync Rule 4: isHostPaired returns false when secret is missing, true when present", async () => {
  const secrets = new MockSecretStorage();
  const host: HostConfig = {
    id: "h1",
    name: "Host 1",
    baseUrl: "http://localhost:8765",
    tokenSecretId: "secret_1",
  };

  assert.equal(await isHostPaired(host, secrets), false);

  await secrets.setSecret("secret_1", "valid-token");
  assert.equal(await isHostPaired(host, secrets), true);
});

test("Sync Rule 5: shouldPromptRuntimeChoice checks device settings", () => {
  const mockAppUnset = {
    loadLocalStorage: () => null,
  } as any;

  const mockAppSet = {
    loadLocalStorage: () => JSON.stringify({ runtimeMode: "local" }),
  } as any;

  const dummySettings = { onboardingDone: true } as any;

  assert.equal(shouldPromptRuntimeChoice(dummySettings, mockAppUnset), true);
  assert.equal(shouldPromptRuntimeChoice(dummySettings, mockAppSet), false);
});

test("migrateSettings moves a v0 deepseekApiKey and blanks it (migrate.ts deepseek gap)", async () => {
  const secrets = new MockSecretStorage();
  const migrated = await migrateSettings(
    { deepseekApiKey: "sk-ds-own-field", directApiProvider: "deepseek" },
    secrets
  );
  assert.equal(migrated.deepseekApiKey, "");
  assert.equal(migrated.directApiProvider, "deepseek");
  const id = migrated.providers.deepseek.apiKeySecretId;
  assert.ok(id);
  assert.equal(await secrets.getSecret(id), "sk-ds-own-field");
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  createDefaultSettings,
  validateSettings,
} from "../../src/settings/schema";

test("DEFAULT_SETTINGS has zero owner-specific literals and safe privacy defaults", () => {
  const json = JSON.stringify(DEFAULT_SETTINGS);

  // No owner IP or Tailscale/Meshnet literals
  const forbiddenIp = ["100", "73", "241", "179"].join(".");
  assert.ok(!json.includes(forbiddenIp));
  assert.ok(!json.includes("100."));

  // No absolute home paths
  assert.ok(!json.includes("/home/"));
  assert.ok(!json.includes("/Users/"));

  // No persona copy
  const forbiddenPersona = ["management", "consultant"].join(" ");
  assert.ok(!json.toLowerCase().includes(forbiddenPersona));
  assert.ok(!json.toLowerCase().includes("executive thinking partner"));
  assert.ok(!json.toLowerCase().includes("coaching advisor"));

  // Canonical defaults
  assert.equal(DEFAULT_SETTINGS.settingsVersion, 1);
  assert.equal(DEFAULT_SETTINGS.artifactFolder, "Darjeeling");
  assert.equal(DEFAULT_SETTINGS.permissionMode, "plan");
  assert.equal(DEFAULT_SETTINGS.defaultPermissionMode, "plan");
  assert.equal(DEFAULT_SETTINGS.vaultContext, "instructions");
  assert.equal(DEFAULT_SETTINGS.sendNoteListing, false);
  assert.equal(DEFAULT_SETTINGS.meshnetHost, "");
  assert.deepEqual(DEFAULT_SETTINGS.hosts, []);
  assert.deepEqual(DEFAULT_SETTINGS.remoteHosts, []);

  // Default terminal profiles: only "Local shell" and "Remote tmux"
  assert.equal(DEFAULT_SETTINGS.terminalProfiles.length, 2);
  assert.equal(DEFAULT_SETTINGS.terminalProfiles[0].name, "Local shell");
  assert.equal(DEFAULT_SETTINGS.terminalProfiles[1].name, "Remote tmux");
});

test("createDefaultSettings returns a fresh clone", () => {
  const s1 = createDefaultSettings();
  const s2 = createDefaultSettings();
  s1.hosts.push({ id: "test", name: "test", baseUrl: "http://localhost:8765" });
  assert.equal(s2.hosts.length, 0);
});

test("validateSettings enforces schema constraints and resets unsafe permissions", () => {
  // Bad permission mode gets clamped to "plan"
  const badPerm = validateSettings({
    permissionMode: "bypassPermissions",
    defaultPermissionMode: "acceptAll",
  });
  assert.equal(badPerm.permissionMode, "plan");
  assert.equal(badPerm.defaultPermissionMode, "plan");

  // Empty artifactFolder falls back to "Darjeeling"
  const emptyFolder = validateSettings({
    artifactFolder: "   ",
  });
  assert.equal(emptyFolder.artifactFolder, "Darjeeling");

  // Unknown provider falls back to "gemini"
  const badProv = validateSettings({
    activeProvider: "unknown-llm",
  });
  assert.equal(badProv.activeProvider, "gemini");

  // Invalid vaultContext falls back to default ("instructions")
  const badContext = validateSettings({
    vaultContext: "invalid-context",
  });
  assert.equal(badContext.vaultContext, "instructions");
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  getCliPermissionArgs,
  clampToSupported,
  normalizeLegacyPermissionMode,
  CANONICAL_PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
} from "../../src/models/permissions";

test("Canonical permission modes define plan, acceptEdits, and bypassPermissions", () => {
  assert.equal(DEFAULT_PERMISSION_MODE, "plan");
  assert.deepEqual(Object.keys(CANONICAL_PERMISSION_MODES).sort(), [
    "acceptEdits",
    "bypassPermissions",
    "plan",
  ]);
  assert.equal(CANONICAL_PERMISSION_MODES.plan.id, "plan");
  assert.equal(CANONICAL_PERMISSION_MODES.acceptEdits.id, "acceptEdits");
  assert.equal(CANONICAL_PERMISSION_MODES.bypassPermissions.id, "bypassPermissions");
});

test("getCliPermissionArgs maps Claude permission modes correctly", () => {
  assert.deepEqual(getCliPermissionArgs("claude", "plan"), ["--permission-mode", "plan"]);
  assert.deepEqual(getCliPermissionArgs("claude", "acceptEdits"), ["--permission-mode", "acceptEdits"]);
  assert.deepEqual(getCliPermissionArgs("claude", "bypassPermissions"), ["--permission-mode", "bypassPermissions"]);
  assert.deepEqual(getCliPermissionArgs("claude-code", "plan"), ["--permission-mode", "plan"]);
});

test("getCliPermissionArgs maps agy permission modes correctly", () => {
  assert.deepEqual(getCliPermissionArgs("agy", "plan"), ["--mode", "plan"]);
  assert.deepEqual(getCliPermissionArgs("agy", "acceptEdits"), ["--mode", "accept-edits"]);
  assert.deepEqual(getCliPermissionArgs("agy", "bypassPermissions"), ["--dangerously-skip-permissions"]);
});

test("clampToSupported falls back to plan when requested mode is unsupported", () => {
  const agyModes = [{ id: "plan" }, { id: "acceptEdits" }];
  assert.equal(clampToSupported("bypassPermissions", agyModes), "plan");
  assert.equal(clampToSupported("acceptEdits", agyModes), "acceptEdits");
  assert.equal(clampToSupported("plan", agyModes), "plan");
  assert.equal(clampToSupported("invalidMode", agyModes), "plan");
  assert.equal(clampToSupported(undefined, agyModes), "plan");
});

test("normalizeLegacyPermissionMode maps values to canonical modes", () => {
  assert.equal(normalizeLegacyPermissionMode("bypassPermissions"), "bypassPermissions");
  assert.equal(normalizeLegacyPermissionMode("acceptEdits"), "acceptEdits");
  assert.equal(normalizeLegacyPermissionMode("acceptAll" as any), "plan");
  assert.equal(normalizeLegacyPermissionMode("ask" as any), "plan");
  assert.equal(normalizeLegacyPermissionMode("default" as any), "plan");
  assert.equal(normalizeLegacyPermissionMode(null), "plan");
  assert.equal(normalizeLegacyPermissionMode(undefined), "plan");
});

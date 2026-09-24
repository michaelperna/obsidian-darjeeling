import { test, describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveDeviceRuntime,
  setDeviceRuntime,
  getCachedLocalBinary,
  clearBinaryDetectionCache,
} from "../../src/runtime/router";
import { refreshAgents } from "../../src/runtime/agents";
import {
  getContinuityKey,
  getContinuityPointer,
  setContinuityPointer,
  dropContinuityPointer,
} from "../../src/settings/device";
import { createMockSettings } from "./helpers/transport";
import { setRequestUrlHandler } from "./stubs/obsidian";

describe("Runtime router & continuity mechanics", () => {
  beforeEach(() => {
    clearBinaryDetectionCache();
    setRequestUrlHandler(null);
  });

  it("resolves explicit per-device runtime and rejects auto fallback", () => {
    const settings = createMockSettings({ runtimeMode: "remote" });
    const fakeApp: any = {
      loadLocalStorage: () => null,
      saveLocalStorage: () => {},
    };

    assert.equal(resolveDeviceRuntime(settings, fakeApp), "remote");

    setDeviceRuntime(fakeApp, settings, "direct-api");
    assert.equal(resolveDeviceRuntime(settings, fakeApp), "direct-api");

    setDeviceRuntime(fakeApp, settings, "local");
    assert.equal(resolveDeviceRuntime(settings, fakeApp), "local");
  });

  it("caches binary detection without throwing notices", () => {
    clearBinaryDetectionCache();
    // Test on binary that doesn't exist
    const bin1 = getCachedLocalBinary("non-existent-binary-xyz");
    assert.equal(bin1, null);

    // Call again to verify cache lookup
    const bin2 = getCachedLocalBinary("non-existent-binary-xyz");
    assert.equal(bin2, null);
  });

  it("manages continuity pointers in device store", () => {
    const store: Record<string, string> = {};
    const fakeApp: any = {
      loadLocalStorage: (key: string) => store[key] ?? null,
      saveLocalStorage: (key: string, val: string) => {
        store[key] = val;
      },
    };

    const key = getContinuityKey("remote", "host-1", "claude", "/vault/path");
    assert.ok(key.includes("claude"));
    assert.ok(key.includes("host-1"));

    // Initially null
    assert.equal(
      getContinuityPointer(fakeApp, "remote", "host-1", "claude", "/vault/path"),
      null
    );

    // Set pointer
    setContinuityPointer(fakeApp, "remote", "host-1", "claude", "/vault/path", "session-xyz-123");
    assert.equal(
      getContinuityPointer(fakeApp, "remote", "host-1", "claude", "/vault/path"),
      "session-xyz-123"
    );

    // Drop pointer on resume error
    dropContinuityPointer(fakeApp, "remote", "host-1", "claude", "/vault/path");
    assert.equal(
      getContinuityPointer(fakeApp, "remote", "host-1", "claude", "/vault/path"),
      null
    );
  });

  it("in remote mode, refreshAgents returns host truth and empty when unreachable", async () => {
    const settings = createMockSettings({ runtimeMode: "remote" });
    const plugin: any = {
      settings,
      availableAgents: [],
      sessionManager: {
        listAgents: async () => [], // Host unreachable or empty
        getAgents: async () => [],
      },
      agentClient: {
        getEffectiveRuntimeMode: () => "remote",
        getBaseUrl: () => "http://100.101.102.103:8765",
        getAuthToken: () => "token",
      },
    };

    // When host is unreachable in remote mode, do NOT fabricate local fallback agents
    const agents = await refreshAgents(plugin);
    assert.deepEqual(agents, []);
  });

  it("in remote mode, refreshAgents returns installed agents from host API", async () => {
    const settings = createMockSettings({ runtimeMode: "remote" });
    const plugin: any = {
      settings,
      availableAgents: [],
      sessionManager: {
        listAgents: async () => [
          {
            key: "claude",
            label: "Claude Code",
            binary: "claude",
            available: true,
            version: "0.2.29",
            models: [{ id: "claude-3-7-sonnet", label: "Claude 3.7 Sonnet" }],
            efforts: ["low", "high"],
            permissionModes: [{ id: "default", label: "Default" }],
          },
        ],
      },
      agentClient: {
        getEffectiveRuntimeMode: () => "remote",
        getBaseUrl: () => "http://100.101.102.103:8765",
        getAuthToken: () => "token",
      },
    };

    const agents = await refreshAgents(plugin);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].key, "claude");
    assert.equal(agents[0].available, true);
    assert.equal(agents[0].version, "0.2.29");
  });
});

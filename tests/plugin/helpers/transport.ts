import { FakeWebSocket, installFakeWebSocket } from "../stubs/fakeWebSocket";
import type { DarjeelingSettings, HostConfig } from "../../../src/settings/schema";
import { DEFAULT_SETTINGS } from "../../../src/settings/schema";

export function createMockSettings(overrides: Partial<DarjeelingSettings> = {}): DarjeelingSettings {
  const host: HostConfig = {
    id: "host-1",
    name: "ThinkPad Lab",
    baseUrl: "http://100.64.0.12:8765",
    tokenSecretId: "sec-host-1",
  };

  return {
    ...DEFAULT_SETTINGS,
    runtimeMode: "remote",
    hosts: [host],
    activeHostId: "host-1",
    meshnetHost: "100.64.0.12",
    port: 8765,
    agent: "claude",
    ...overrides,
  };
}

export { installFakeWebSocket, FakeWebSocket };

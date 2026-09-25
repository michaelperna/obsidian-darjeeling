import type { App } from "obsidian";
import type { RuntimeMode } from "./schema";

export interface DeviceSettings {
  runtimeMode?: RuntimeMode;
  localExecutablePaths?: Record<string, string>;
  mobileViewPlacement?: "main" | "sidebar";
  continuityPointers?: Record<string, string>;
  lastSyncedHashes?: Record<string, string>;
  modelListCache?: Record<string, unknown>;
  activeHostId?: string;
  /** `kind:ref` of missing secrets this device was already told about. */
  missingSecretsNotified?: string[];
}

interface AppWithLocalStorage {
  loadLocalStorage?(key: string): string | null;
  saveLocalStorage?(key: string, value: string | null): void;
}

const STORAGE_KEY = "darjeeling_device_settings";

export function loadDeviceSettings(app: App): DeviceSettings {
  try {
    const typed = app as unknown as AppWithLocalStorage;
    const raw = typed.loadLocalStorage?.(STORAGE_KEY);
    if (typeof raw === "string" && raw.trim()) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    }
  } catch {
    /* ignore parse errors */
  }
  return {};
}

export function saveDeviceSettings(app: App, settings: DeviceSettings): void {
  try {
    const typed = app as unknown as AppWithLocalStorage;
    typed.saveLocalStorage?.(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore write errors */
  }
}

/**
 * Builds the continuity pointer key keyed by (runtime, hostId, agent, cwd) (CORE-09, CHAT-05).
 */
export function getContinuityKey(
  runtime: string,
  hostId?: string,
  agent?: string,
  cwd?: string
): string {
  const r = (runtime || "default").trim().toLowerCase();
  const h = (hostId || "default").trim().toLowerCase();
  const a = (agent || "default").trim().toLowerCase();
  const c = (cwd || "default").trim();
  return `${r}::${h}::${a}::${c}`;
}

export function getContinuityPointer(
  app: App,
  runtime: string,
  hostId?: string,
  agent?: string,
  cwd?: string
): string | null {
  const dev = loadDeviceSettings(app);
  if (!dev.continuityPointers) return null;
  const key = getContinuityKey(runtime, hostId, agent, cwd);
  return dev.continuityPointers[key] || null;
}

export function setContinuityPointer(
  app: App,
  runtime: string,
  hostId: string | undefined,
  agent: string | undefined,
  cwd: string | undefined,
  sessionId: string | null
): void {
  const dev = loadDeviceSettings(app);
  const pointers = { ...(dev.continuityPointers || {}) };
  const key = getContinuityKey(runtime, hostId, agent, cwd);
  if (sessionId) {
    pointers[key] = sessionId;
  } else {
    delete pointers[key];
  }
  saveDeviceSettings(app, { ...dev, continuityPointers: pointers });
}

export function dropContinuityPointer(
  app: App,
  runtime: string,
  hostId?: string,
  agent?: string,
  cwd?: string
): void {
  setContinuityPointer(app, runtime, hostId, agent, cwd, null);
}

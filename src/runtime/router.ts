import { Platform } from "obsidian";
import type { App } from "obsidian";
import type { DarjeelingSettings, RuntimeMode } from "../settings/schema";
import { loadDeviceSettings, saveDeviceSettings } from "../settings/device";
import { detectLocalBinary } from "./localAgentRunner";

export interface RuntimeResolution {
  mode: RuntimeMode;
  reason?: string;
}

/**
 * Caches binary detection results to avoid repeated filesystem traversal (CORE-31, CHAT-49).
 */
const binaryCache = new Map<string, { path: string | null; timestamp: number }>();
const CACHE_TTL_MS = 30000;

export function getCachedLocalBinary(agent: string): string | null {
  const key = (agent || "").toLowerCase().trim();
  const now = Date.now();
  const cached = binaryCache.get(key);
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.path;
  }
  const detected = detectLocalBinary(key);
  binaryCache.set(key, { path: detected, timestamp: now });
  return detected;
}

export function clearBinaryDetectionCache(): void {
  binaryCache.clear();
}

/**
 * Resolves the explicit runtime mode for this device (CORE-22, F-28, DOC-38).
 * "auto" is removed — every device has an explicit mode (local, direct-api, or remote).
 * Pure function: never issues UI Notices or triggers side-effects (CORE-31).
 */
export function resolveDeviceRuntime(
  settings: DarjeelingSettings,
  app?: App
): RuntimeMode {
  // Check per-device settings first if available
  if (app) {
    const dev = loadDeviceSettings(app);
    if (dev.runtimeMode) {
      if (dev.runtimeMode === "local" && !Platform.isDesktop) {
        // Local is impossible on mobile; return direct-api or remote without saving/noticing
        return settings.meshnetHost || settings.activeHostId ? "remote" : "direct-api";
      }
      return dev.runtimeMode;
    }
  }

  let mode = settings.runtimeMode as string;

  // If old settings had "auto" or empty, normalize to an explicit mode
  if (!mode || mode === "auto") {
    if (Platform.isDesktop && (getCachedLocalBinary("claude") || getCachedLocalBinary("agy"))) {
      mode = "local";
    } else if (settings.meshnetHost || settings.activeHostId) {
      mode = "remote";
    } else {
      mode = "direct-api";
    }
  }

  // Mobile enforcement: cannot run local CLI
  if (!Platform.isDesktop && mode === "local") {
    return settings.meshnetHost || settings.activeHostId ? "remote" : "direct-api";
  }

  if (mode === "remote" || mode === "direct-api" || mode === "local") {
    return mode;
  }

  return "direct-api";
}

/**
 * Sets the explicit runtime mode for this device (saved per-device).
 */
export function setDeviceRuntime(
  app: App,
  settings: DarjeelingSettings,
  mode: RuntimeMode
): void {
  const dev = loadDeviceSettings(app);
  saveDeviceSettings(app, { ...dev, runtimeMode: mode });
  settings.runtimeMode = mode;
}

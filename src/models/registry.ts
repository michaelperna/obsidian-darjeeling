import type { App } from "obsidian";
import type { DarjeelingSettings } from "../settings/schema";
import { loadDeviceSettings, saveDeviceSettings } from "../settings/device";
import { getFallbackModels, getFallbackDefaultModel, FallbackModelDescriptor } from "./fallback";

export const DEFAULT_HARNESS_MODELS: Record<string, string> = {
  agy: "gemini-3.8-flash-high",
  claude: "claude-opus-5",
  deepseek: "deepseek-chat",
  gemini: "gemini-3.8-flash",
  anthropic: "claude-opus-5",
  ollama: "llama3.2",
  "openai-compatible": "gpt-4o",
  openaiCompatible: "gpt-4o",
};

export function getHarnessKey(settings: DarjeelingSettings): string {
  if (settings.runtimeMode === "direct-api") {
    return settings.directApiProvider || "gemini";
  }
  return settings.agent || "agy";
}

/**
 * Normalizes model names without silent substitution or remapping (ADR-08).
 * An empty string means host / CLI default (omits --model).
 * Custom model IDs are preserved.
 */
export function sanitizeModelForHarness(_harness: string, model?: string): string {
  if (!model) return "";
  return model.trim();
}

export function getModelForHarness(settings: DarjeelingSettings, harness?: string): string {
  const h = harness || getHarnessKey(settings);
  const stored = settings.harnessModels?.[h];
  if (stored !== undefined && stored !== null && stored !== "") {
    return sanitizeModelForHarness(h, stored);
  }
  if (h === "deepseek" && settings.deepseekModel) {
    return sanitizeModelForHarness(h, settings.deepseekModel);
  }
  if ((h === "openai-compatible" || h === "openaiCompatible") && settings.openaiModel) {
    return sanitizeModelForHarness(h, settings.openaiModel);
  }
  return DEFAULT_HARNESS_MODELS[h] || getFallbackDefaultModel(h) || "";
}

export function setModelForHarness(settings: DarjeelingSettings, harness: string, model: string): void {
  if (!settings.harnessModels) {
    settings.harnessModels = { ...DEFAULT_HARNESS_MODELS };
  }
  const sanitized = sanitizeModelForHarness(harness, model);
  settings.harnessModels[harness] = sanitized;
  if (harness === "deepseek") {
    settings.deepseekModel = sanitized;
  } else if (harness === "openai-compatible" || harness === "openaiCompatible") {
    settings.openaiModel = sanitized;
  }
}

export function getCachedProviderModels(app: App, provider: string): FallbackModelDescriptor[] | null {
  try {
    const dev = loadDeviceSettings(app);
    const cache = dev.modelListCache?.[provider];
    if (Array.isArray(cache) && cache.length > 0) {
      return cache as FallbackModelDescriptor[];
    }
  } catch {
    // ignore
  }
  return null;
}

export function cacheProviderModels(app: App, provider: string, models: FallbackModelDescriptor[]): void {
  try {
    const dev = loadDeviceSettings(app);
    if (!dev.modelListCache) {
      dev.modelListCache = {};
    }
    dev.modelListCache[provider] = models;
    saveDeviceSettings(app, dev);
  } catch {
    // ignore
  }
}

export function getModelsForProviderOrHarness(app: App, providerOrHarness: string): FallbackModelDescriptor[] {
  const cached = getCachedProviderModels(app, providerOrHarness);
  if (cached && cached.length > 0) {
    return cached;
  }
  return getFallbackModels(providerOrHarness);
}

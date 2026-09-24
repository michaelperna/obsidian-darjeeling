import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeModelForHarness,
  getModelForHarness,
  setModelForHarness,
  getModelsForProviderOrHarness,
  cacheProviderModels,
  getCachedProviderModels,
  DEFAULT_HARNESS_MODELS,
} from "../../src/models/registry";
import { getFallbackModels, getFallbackDefaultModel } from "../../src/models/fallback";
import { DEFAULT_SETTINGS } from "../../src/settings/schema";

test("ADR-08: sanitizeModelForHarness does not rewrite custom model IDs and handles empty model", () => {
  // Empty model returns empty string (omits --model on CLI runs)
  assert.equal(sanitizeModelForHarness("claude", ""), "");
  assert.equal(sanitizeModelForHarness("claude", "   "), "");

  // Custom and standard model IDs are preserved unchanged
  assert.equal(sanitizeModelForHarness("claude", "claude-custom-finetune"), "claude-custom-finetune");
  assert.equal(sanitizeModelForHarness("deepseek", "deepseek-coder-v2"), "deepseek-coder-v2");
  assert.equal(sanitizeModelForHarness("openai-compatible", "mistral-large"), "mistral-large");
  assert.equal(sanitizeModelForHarness("ollama", "qwen2.5:32b"), "qwen2.5:32b");

  // agy normalizes whitespace
  assert.equal(sanitizeModelForHarness("agy", "  gemini-3.8-flash-high  "), "gemini-3.8-flash-high");
});

test("ADR-08: fallback models contains only verified IDs", () => {
  const geminiModels = getFallbackModels("gemini");
  assert.ok(geminiModels.some((m) => m.id === "gemini-3.8-flash"));
  assert.equal(getFallbackDefaultModel("gemini"), "gemini-3.8-flash");

  const claudeModels = getFallbackModels("claude");
  assert.ok(claudeModels.some((m) => m.id === "claude-opus-5"));
  assert.ok(claudeModels.some((m) => m.id === "claude-sonnet-5"));

  const deepseekModels = getFallbackModels("deepseek");
  assert.ok(deepseekModels.some((m) => m.id === "deepseek-chat"));
  assert.ok(deepseekModels.some((m) => m.id === "deepseek-reasoner"));
  assert.equal(getFallbackDefaultModel("deepseek"), "deepseek-chat");

  const openaiModels = getFallbackModels("openai-compatible");
  assert.ok(openaiModels.some((m) => m.id === "gpt-4o"));

  const ollamaModels = getFallbackModels("ollama");
  assert.ok(ollamaModels.some((m) => m.id === "llama3.2"));
});

test("ADR-08: getModelForHarness and setModelForHarness operate per-harness without alias pollution", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    harnessModels: { ...DEFAULT_HARNESS_MODELS },
  };

  // Default models
  assert.equal(getModelForHarness(settings, "gemini"), "gemini-3.8-flash");
  assert.equal(getModelForHarness(settings, "deepseek"), "deepseek-chat");

  // Update deepseek model
  setModelForHarness(settings, "deepseek", "deepseek-reasoner");
  assert.equal(getModelForHarness(settings, "deepseek"), "deepseek-reasoner");
  assert.equal(settings.deepseekModel, "deepseek-reasoner");

  // OpenAI-compatible remains independent
  setModelForHarness(settings, "openai-compatible", "gpt-4o-mini");
  assert.equal(getModelForHarness(settings, "openai-compatible"), "gpt-4o-mini");
  assert.equal(settings.openaiModel, "gpt-4o-mini");
  assert.equal(getModelForHarness(settings, "deepseek"), "deepseek-reasoner");
});

test("ADR-08: getModelsForProviderOrHarness uses fallback when cache is empty and cache when populated", () => {
  const mockStorage: Record<string, any> = {};
  const mockApp = {
    loadLocalStorage: (key: string) => mockStorage[key] ?? null,
    saveLocalStorage: (key: string, val: string) => {
      mockStorage[key] = val;
    },
  } as any;

  // Initially empty cache -> returns fallback
  const modelsInitial = getModelsForProviderOrHarness(mockApp, "deepseek");
  assert.ok(modelsInitial.some((m) => m.id === "deepseek-chat"));

  // Cache fetched models
  cacheProviderModels(mockApp, "deepseek", [
    { id: "deepseek-chat", name: "DeepSeek V3" },
    { id: "deepseek-reasoner", name: "DeepSeek R1" },
    { id: "deepseek-coder", name: "DeepSeek Coder" },
  ]);

  const cached = getCachedProviderModels(mockApp, "deepseek");
  assert.equal(cached?.length, 3);

  const modelsFromCache = getModelsForProviderOrHarness(mockApp, "deepseek");
  assert.equal(modelsFromCache.length, 3);
  assert.equal(modelsFromCache[2].id, "deepseek-coder");
});

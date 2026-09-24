/**
 * Small offline fallback model list per ADR-08.
 * Holds only model IDs verified at implementation time.
 */

export interface FallbackModelDescriptor {
  id: string;
  name: string;
  default?: boolean;
}

const CLAUDE_MODELS: FallbackModelDescriptor[] = [
  { id: "claude-opus-5", name: "Claude Opus 5", default: true },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
];

const OPENAI_MODELS: FallbackModelDescriptor[] = [
  { id: "gpt-4o", name: "GPT-4o", default: true },
];

export const FALLBACK_MODELS: Record<string, FallbackModelDescriptor[]> = {
  gemini: [
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", default: true },
  ],
  anthropic: CLAUDE_MODELS,
  claude: CLAUDE_MODELS,
  deepseek: [
    { id: "deepseek-chat", name: "DeepSeek Chat (V3)", default: true },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner (R1)" },
  ],
  "openai-compatible": OPENAI_MODELS,
  openaicompatible: OPENAI_MODELS,
  openai: OPENAI_MODELS,
  ollama: [
    { id: "llama3.2", name: "Llama 3.2", default: true },
  ],
};

export function getFallbackModels(providerOrHarness: string): FallbackModelDescriptor[] {
  const norm = providerOrHarness.toLowerCase().replace(/[-_]/g, "").trim();
  for (const [key, val] of Object.entries(FALLBACK_MODELS)) {
    if (key.toLowerCase().replace(/[-_]/g, "") === norm) {
      return val;
    }
  }
  return [];
}

export function getFallbackDefaultModel(providerOrHarness: string): string {
  const models = getFallbackModels(providerOrHarness);
  const def = models.find((m) => m.default);
  return def?.id || models[0]?.id || "";
}

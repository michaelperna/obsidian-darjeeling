export * from "./types";
export * from "./gemini";
export * from "./anthropic";
export * from "./deepseek";
export * from "./openaiCompatible";
export * from "./ollama";

import type { DirectProviderClient } from "./types";
import { GeminiProviderClient } from "./gemini";
import { AnthropicProviderClient } from "./anthropic";
import { DeepSeekProviderClient } from "./deepseek";
import { OpenAiCompatibleProviderClient } from "./openaiCompatible";
import { OllamaProviderClient } from "./ollama";

const clients: Record<string, DirectProviderClient> = {
  gemini: new GeminiProviderClient(),
  anthropic: new AnthropicProviderClient(),
  claude: new AnthropicProviderClient(),
  "openai-compatible": new OpenAiCompatibleProviderClient(),
  openaicompatible: new OpenAiCompatibleProviderClient(),
  openai: new OpenAiCompatibleProviderClient(),
  deepseek: new DeepSeekProviderClient(),
  ollama: new OllamaProviderClient(),
};

export function getProviderClient(provider: string): DirectProviderClient {
  const norm = provider.toLowerCase().replace(/[-_]/g, "").trim();
  for (const [key, client] of Object.entries(clients)) {
    if (key.toLowerCase().replace(/[-_]/g, "") === norm) {
      return client;
    }
  }
  throw new Error(`Unknown direct API provider: ${provider}`);
}

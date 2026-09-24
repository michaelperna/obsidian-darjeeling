import type { DirectApiProvider } from "../../settings/schema";

export interface DirectChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  effort?: string;
}

export interface ProviderTurnOptions {
  prompt: string;
  messages?: DirectChatMessage[];
  append_system_prompt?: string;
  json_schema?: Record<string, unknown>;
  model?: string;
  effort?: string;
  signal?: AbortSignal;
}

export interface ProviderTurnResult {
  text: string;
  structured_output?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  stop_reason?: string;
  finish_reason?: string;
  truncated?: boolean;
  reasoning_content?: string;
}

export interface ProviderModel {
  id: string;
  name: string;
  description?: string;
}

export interface ProviderCapabilities {
  tools: boolean;
  synced: boolean;
  supportsEffort: boolean;
}

export interface DirectProviderClient {
  readonly id: DirectApiProvider;
  readonly capabilities: ProviderCapabilities;
  call(options: ProviderTurnOptions, config: ProviderConfig): Promise<ProviderTurnResult>;
  completeChat?(
    config: ProviderConfig,
    messages: DirectChatMessage[],
    options?: Partial<ProviderTurnOptions>
  ): Promise<ProviderTurnResult>;
  testConnection(config: ProviderConfig): Promise<{ ok: boolean; message: string; models?: ProviderModel[] }>;
  listModels?(config: ProviderConfig): Promise<ProviderModel[]>;
}

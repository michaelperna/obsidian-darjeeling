import { requestUrl } from "obsidian";
import { extractApiError } from "../../errors";
import type {
  DirectProviderClient,
  ProviderConfig,
  ProviderTurnOptions,
  ProviderTurnResult,
  ProviderModel,
  ProviderCapabilities,
} from "./types";

interface OllamaResponse {
  message?: {
    content?: string;
  };
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaModelItem {
  name: string;
}

interface OllamaListModelsResponse {
  models?: OllamaModelItem[];
}

export class OllamaProviderClient implements DirectProviderClient {
  readonly id = "ollama" as const;
  readonly capabilities: ProviderCapabilities = {
    tools: false,
    synced: false,
    supportsEffort: false,
  };

  private getBaseUrl(config: ProviderConfig): string {
    return (config.baseUrl || "http://localhost:11434").replace(/\/+$/, "");
  }

  private getModel(config: ProviderConfig, options?: ProviderTurnOptions): string {
    return options?.model || config.model || "llama3.2";
  }

  async call(options: ProviderTurnOptions, config: ProviderConfig): Promise<ProviderTurnResult> {
    const model = this.getModel(config, options);
    const baseUrl = this.getBaseUrl(config);
    const url = `${baseUrl}/api/chat`;

    const messages: Array<{ role: string; content: string }> = [];

    if (options.append_system_prompt) {
      messages.push({ role: "system", content: options.append_system_prompt });
    }

    for (const m of options.messages || []) {
      if (m.role !== "system") {
        messages.push({ role: m.role, content: m.content });
      }
    }

    if (
      options.prompt &&
      (messages.length === 0 || messages[messages.length - 1].content !== options.prompt)
    ) {
      messages.push({ role: "user", content: options.prompt });
    }

    const payload: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    };

    if (options.json_schema) {
      payload.format = options.json_schema;
    }

    // egress: provider-ollama
    const res = await requestUrl({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      throw: false,
    });

    if (res.status < 200 || res.status >= 300) {
      const err = extractApiError(res.text);
      throw new Error(`HTTP ${res.status}: ${err}`);
    }

    const data = res.json as unknown as OllamaResponse;
    const text = data.message?.content ?? "";

    let structuredOutput: unknown = undefined;
    if (options.json_schema && text) {
      try {
        structuredOutput = JSON.parse(text);
      } catch {
        // preserve raw text if parse fails
      }
    }

    return {
      text,
      structured_output: structuredOutput,
      usage: {
        input_tokens: data.prompt_eval_count,
        output_tokens: data.eval_count,
      },
    };
  }

  async listModels(config: ProviderConfig): Promise<ProviderModel[]> {
    const baseUrl = this.getBaseUrl(config);
    const url = `${baseUrl}/api/tags`;

    // egress: provider-ollama
    const res = await requestUrl({
      url,
      method: "GET",
      throw: false,
    });

    if (res.status < 200 || res.status >= 300) {
      const err = extractApiError(res.text);
      throw new Error(`HTTP ${res.status}: ${err}`);
    }

    const data = res.json as unknown as OllamaListModelsResponse;
    const rawModels = Array.isArray(data.models) ? data.models : [];
    return rawModels.map((m) => ({
      id: m.name,
      name: m.name,
    }));
  }

  async testConnection(
    config: ProviderConfig
  ): Promise<{ ok: boolean; message: string; models?: ProviderModel[] }> {
    try {
      const models = await this.listModels(config);
      const modelNames = models.map((m) => m.name).join(", ");
      return {
        ok: true,
        message: `Ollama reachable. Models: ${modelNames || "none"}`,
        models,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message };
    }
  }
}

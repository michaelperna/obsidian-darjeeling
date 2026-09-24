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

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface AnthropicModelItem {
  id: string;
  display_name?: string;
}

interface AnthropicListModelsResponse {
  data?: AnthropicModelItem[];
}

export class AnthropicProviderClient implements DirectProviderClient {
  readonly id = "anthropic" as const;
  readonly capabilities: ProviderCapabilities = {
    tools: false,
    synced: false,
    supportsEffort: true,
  };

  private getBaseUrl(config: ProviderConfig): string {
    return (config.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  }

  private getModel(config: ProviderConfig, options?: ProviderTurnOptions): string {
    return options?.model || config.model || "claude-opus-5";
  }

  async call(options: ProviderTurnOptions, config: ProviderConfig): Promise<ProviderTurnResult> {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) {
      throw new Error("Anthropic API key missing. Please configure it in settings.");
    }

    const model = this.getModel(config, options);
    const baseUrl = this.getBaseUrl(config);
    const url = `${baseUrl}/v1/messages`;

    const messages = (options.messages || [])
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      }));

    if (
      options.prompt &&
      (messages.length === 0 || messages[messages.length - 1].content !== options.prompt)
    ) {
      messages.push({
        role: "user",
        content: options.prompt,
      });
    }

    const payload: Record<string, unknown> = {
      model,
      max_tokens: 16000,
      messages,
    };

    if (options.append_system_prompt) {
      payload.system = options.append_system_prompt;
    }

    const outputConfig: Record<string, unknown> = {};

    if (options.json_schema) {
      outputConfig.format = {
        type: "json_schema",
        schema: options.json_schema,
      };
    }

    const effort = options.effort || config.effort;
    if (effort) {
      outputConfig.effort = effort === "max" ? "high" : effort;
    }

    if (Object.keys(outputConfig).length > 0) {
      payload.output_config = outputConfig;
    }

    // egress: provider-anthropic
    const res = await requestUrl({
      url,
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      throw: false,
    });

    if (res.status < 200 || res.status >= 300) {
      const err = extractApiError(res.text);
      throw new Error(`HTTP ${res.status}: ${err}`);
    }

    const data = res.json as unknown as AnthropicResponse;
    const stopReason = data.stop_reason;

    if (stopReason === "refusal") {
      throw new Error("Response refused by model");
    }

    let text = "";
    if (Array.isArray(data.content)) {
      text = data.content
        .filter((b) => b.type === "text")
        .map((b) => (typeof b.text === "string" ? b.text : ""))
        .join("");
    }

    let truncated = false;
    if (stopReason === "max_tokens") {
      text += "\n\n[Response truncated: max_tokens reached]";
      truncated = true;
    }

    let structuredOutput: unknown = undefined;
    if (options.json_schema && text) {
      try {
        const cleaned = truncated ? text.replace(/\n\n\[Response truncated: max_tokens reached\]$/, "") : text;
        structuredOutput = JSON.parse(cleaned);
      } catch {
        // preserve raw text if parse fails
      }
    }

    return {
      text,
      structured_output: structuredOutput,
      stop_reason: stopReason,
      truncated,
      usage: {
        input_tokens: data.usage?.input_tokens,
        output_tokens: data.usage?.output_tokens,
      },
    };
  }

  async listModels(config: ProviderConfig): Promise<ProviderModel[]> {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) {
      throw new Error("Anthropic API key missing.");
    }
    const baseUrl = this.getBaseUrl(config);
    const url = `${baseUrl}/v1/models`;

    // egress: provider-anthropic
    const res = await requestUrl({
      url,
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      throw: false,
    });

    if (res.status < 200 || res.status >= 300) {
      const err = extractApiError(res.text);
      throw new Error(`HTTP ${res.status}: ${err}`);
    }

    const data = res.json as unknown as AnthropicListModelsResponse;
    const rawModels = Array.isArray(data.data) ? data.data : [];
    return rawModels.map((m) => ({
      id: m.id,
      name: m.display_name || m.id,
    }));
  }

  async testConnection(
    config: ProviderConfig
  ): Promise<{ ok: boolean; message: string; models?: ProviderModel[] }> {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) {
      return { ok: false, message: "Anthropic API key missing. Please set it in settings." };
    }

    try {
      const models = await this.listModels(config);
      return {
        ok: true,
        message: "Anthropic API reachable and key valid.",
        models,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message };
    }
  }
}

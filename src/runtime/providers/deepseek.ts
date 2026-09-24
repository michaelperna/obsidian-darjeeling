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

interface DeepSeekChoice {
  message?: {
    content?: string;
    reasoning_content?: string;
  };
  finish_reason?: string;
}

interface DeepSeekResponse {
  choices?: DeepSeekChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

interface DeepSeekModelItem {
  id: string;
}

interface DeepSeekListModelsResponse {
  data?: DeepSeekModelItem[];
}

export class DeepSeekProviderClient implements DirectProviderClient {
  readonly id = "deepseek" as const;
  readonly capabilities: ProviderCapabilities = {
    tools: false,
    synced: false,
    supportsEffort: false,
  };

  private getBaseUrl(config: ProviderConfig): string {
    return (config.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
  }

  private getModel(config: ProviderConfig, options?: ProviderTurnOptions): string {
    return options?.model || config.model || "deepseek-chat";
  }

  async call(options: ProviderTurnOptions, config: ProviderConfig): Promise<ProviderTurnResult> {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) {
      throw new Error("DeepSeek API key missing. Please configure it in settings.");
    }

    const model = this.getModel(config, options);
    const baseUrl = this.getBaseUrl(config);
    const url = `${baseUrl}/chat/completions`;

    const messages: Array<{ role: string; content: string }> = [];

    let systemText = options.append_system_prompt || "";
    if (options.json_schema) {
      const schemaPrompt = `CRITICAL: Respond ONLY with a valid JSON object matching this schema:\n${JSON.stringify(
        options.json_schema,
        null,
        2
      )}`;
      systemText = systemText ? `${systemText}\n\n${schemaPrompt}` : schemaPrompt;
    }

    if (systemText) {
      messages.push({ role: "system", content: systemText });
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
    };

    if (options.json_schema) {
      payload.response_format = { type: "json_object" };
    }

    // egress: provider-deepseek
    const res = await requestUrl({
      url,
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      throw: false,
    });

    if (res.status < 200 || res.status >= 300) {
      const err = extractApiError(res.text);
      throw new Error(`HTTP ${res.status}: ${err}`);
    }

    const data = res.json as unknown as DeepSeekResponse;
    const choice = data.choices?.[0];
    const reasoning = choice?.message?.reasoning_content;
    let text = choice?.message?.content ?? "";
    if (!text && reasoning) {
      text = reasoning;
    }

    const finishReason = choice?.finish_reason;

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
      reasoning_content: reasoning,
      finish_reason: finishReason,
      usage: {
        input_tokens: data.usage?.prompt_tokens,
        output_tokens: data.usage?.completion_tokens,
      },
    };
  }

  async listModels(config: ProviderConfig): Promise<ProviderModel[]> {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) {
      throw new Error("DeepSeek API key missing.");
    }
    const baseUrl = this.getBaseUrl(config);
    const url = `${baseUrl}/models`;

    // egress: provider-deepseek
    const res = await requestUrl({
      url,
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      throw: false,
    });

    if (res.status < 200 || res.status >= 300) {
      const err = extractApiError(res.text);
      throw new Error(`HTTP ${res.status}: ${err}`);
    }

    const data = res.json as unknown as DeepSeekListModelsResponse;
    const rawModels = Array.isArray(data.data) ? data.data : [];
    return rawModels.map((m) => ({
      id: m.id,
      name: m.id,
    }));
  }

  async testConnection(
    config: ProviderConfig
  ): Promise<{ ok: boolean; message: string; models?: ProviderModel[] }> {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) {
      return { ok: false, message: "DeepSeek API key missing. Please set it in settings." };
    }

    try {
      const models = await this.listModels(config);
      const modelNames = models.map((m) => m.id).join(", ");
      return {
        ok: true,
        message: `DeepSeek API online. Models: ${modelNames || "deepseek-chat, deepseek-reasoner"}`,
        models,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message };
    }
  }
}

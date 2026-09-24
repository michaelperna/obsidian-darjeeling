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

interface OpenAiChoice {
  message?: {
    content?: string;
    reasoning_content?: string;
  };
  finish_reason?: string;
}

interface OpenAiResponse {
  choices?: OpenAiChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

interface OpenAiModelItem {
  id: string;
}

interface OpenAiListModelsResponse {
  data?: OpenAiModelItem[];
}

export class OpenAiCompatibleProviderClient implements DirectProviderClient {
  readonly id = "openai-compatible" as const;
  readonly capabilities: ProviderCapabilities = {
    tools: false,
    synced: false,
    supportsEffort: true,
  };

  private getBaseUrl(config: ProviderConfig): string {
    return (config.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  }

  private getModel(config: ProviderConfig, options?: ProviderTurnOptions): string {
    return options?.model || config.model || "gpt-4o";
  }

  async call(options: ProviderTurnOptions, config: ProviderConfig): Promise<ProviderTurnResult> {
    const apiKey = config.apiKey?.trim();
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

    const effort = options.effort || config.effort;
    if (effort) {
      payload.reasoning_effort = effort === "max" ? "high" : effort;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    // egress: provider-openai
    const res = await requestUrl({
      url,
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      throw: false,
    });

    if (res.status < 200 || res.status >= 300) {
      const err = extractApiError(res.text);
      throw new Error(`HTTP ${res.status}: ${err}`);
    }

    const data = res.json as unknown as OpenAiResponse;
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
    const baseUrl = this.getBaseUrl(config);
    const url = `${baseUrl}/models`;

    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    // egress: provider-openai
    const res = await requestUrl({
      url,
      method: "GET",
      headers,
      throw: false,
    });

    if (res.status < 200 || res.status >= 300) {
      const err = extractApiError(res.text);
      throw new Error(`HTTP ${res.status}: ${err}`);
    }

    const data = res.json as unknown as OpenAiListModelsResponse;
    const rawModels = Array.isArray(data.data) ? data.data : [];
    return rawModels.map((m) => ({
      id: m.id,
      name: m.id,
    }));
  }

  async completeChat(
    config: ProviderConfig,
    messages: import("./types").DirectChatMessage[],
    options?: Partial<ProviderTurnOptions>
  ): Promise<ProviderTurnResult> {
    const prompt = messages[messages.length - 1]?.content || "";
    return await this.call({ prompt, messages, ...options }, config);
  }

  async testConnection(
    config: ProviderConfig
  ): Promise<{ ok: boolean; message: string; models?: ProviderModel[] }> {
    try {
      const models = await this.listModels(config);
      const modelNames = models.map((m) => m.id).join(", ");
      return {
        ok: true,
        message: `OpenAI-compatible endpoint reachable. Models: ${modelNames || "online"}`,
        models,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message };
    }
  }
}

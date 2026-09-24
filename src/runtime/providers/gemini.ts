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

interface GeminiPart {
  text?: string;
}

interface GeminiCandidate {
  content?: {
    parts?: GeminiPart[];
  };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: {
    blockReason?: string;
  };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

interface GeminiModelItem {
  name?: string;
  displayName?: string;
  description?: string;
}

interface GeminiListModelsResponse {
  models?: GeminiModelItem[];
}

export class GeminiProviderClient implements DirectProviderClient {
  readonly id = "gemini" as const;
  readonly capabilities: ProviderCapabilities = {
    tools: false,
    synced: false,
    supportsEffort: true,
  };

  private getBaseUrl(config: ProviderConfig): string {
    return (config.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
  }

  private getModel(config: ProviderConfig, options?: ProviderTurnOptions): string {
    return options?.model || config.model || "gemini-3.8-flash";
  }

  async call(options: ProviderTurnOptions, config: ProviderConfig): Promise<ProviderTurnResult> {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) {
      throw new Error("Gemini API key missing. Please configure it in settings.");
    }

    const model = this.getModel(config, options);
    const baseUrl = this.getBaseUrl(config);
    const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    const messages = options.messages || [];
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    if (
      options.prompt &&
      (contents.length === 0 || contents[contents.length - 1].parts[0]?.text !== options.prompt)
    ) {
      contents.push({
        role: "user",
        parts: [{ text: options.prompt }],
      });
    }

    const payload: Record<string, unknown> = { contents };

    if (options.append_system_prompt) {
      payload.systemInstruction = {
        parts: [{ text: options.append_system_prompt }],
      };
    }

    const generationConfig: Record<string, unknown> = {};

    if (options.json_schema) {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseSchema = options.json_schema;
    }

    const effort = options.effort || config.effort;
    if (effort) {
      let budget = 0;
      if (effort === "high" || effort === "max") {
        budget = 8192;
      } else if (effort === "medium") {
        budget = 2048;
      } else if (effort === "low") {
        budget = 0;
      }
      generationConfig.thinkingConfig = {
        thinkingBudget: budget,
      };
    }

    if (Object.keys(generationConfig).length > 0) {
      payload.generationConfig = generationConfig;
    }

    // egress: provider-gemini
    const res = await requestUrl({
      url,
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      throw: false,
    });

    if (res.status < 200 || res.status >= 300) {
      const err = extractApiError(res.text);
      throw new Error(`HTTP ${res.status}: ${err}`);
    }

    const data = res.json as unknown as GeminiResponse;

    if (data.promptFeedback?.blockReason) {
      throw new Error(`Prompt blocked by Gemini safety filters: ${data.promptFeedback.blockReason}`);
    }

    const candidate = data.candidates?.[0];
    const finishReason = candidate?.finishReason;

    let text = "";
    if (Array.isArray(candidate?.content?.parts)) {
      text = candidate.content.parts
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .join("");
    }

    if (!text && finishReason && finishReason !== "STOP") {
      throw new Error(`Gemini response stopped with reason: ${finishReason}`);
    }

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
      finish_reason: finishReason,
      usage: {
        input_tokens: data.usageMetadata?.promptTokenCount,
        output_tokens: data.usageMetadata?.candidatesTokenCount,
      },
    };
  }

  async listModels(config: ProviderConfig): Promise<ProviderModel[]> {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) {
      throw new Error("Gemini API key missing.");
    }
    const baseUrl = this.getBaseUrl(config);
    const url = `${baseUrl}/v1beta/models`;

    // egress: provider-gemini
    const res = await requestUrl({
      url,
      method: "GET",
      headers: {
        "x-goog-api-key": apiKey,
      },
      throw: false,
    });

    if (res.status < 200 || res.status >= 300) {
      const err = extractApiError(res.text);
      throw new Error(`HTTP ${res.status}: ${err}`);
    }

    const data = res.json as unknown as GeminiListModelsResponse;
    const rawModels = Array.isArray(data.models) ? data.models : [];
    return rawModels.map((m) => {
      const id = (m.name || "").replace(/^models\//, "");
      return {
        id,
        name: m.displayName || m.name || id,
        description: m.description,
      };
    });
  }

  async testConnection(
    config: ProviderConfig
  ): Promise<{ ok: boolean; message: string; models?: ProviderModel[] }> {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) {
      return { ok: false, message: "Gemini API key missing. Please set it in settings." };
    }

    try {
      const models = await this.listModels(config);
      return {
        ok: true,
        message: "Gemini API reachable and key valid.",
        models,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message };
    }
  }
}

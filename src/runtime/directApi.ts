import {
  type DarjeelingSettings,
  type DirectApiProvider,
} from "../settings/schema";
import {
  sanitizeModelForHarness,
  getModelForHarness,
} from "../models/registry";
import type {
  AgentEvent,
  AgentHandlers,
  StreamResult,
  DjError,
  TurnOptions,
} from "../net/agentClient";
import {
  getProviderClient,
  type DirectChatMessage,
  type ProviderConfig,
  type ProviderModel,
  type ProviderCapabilities,
} from "./providers";

export type { DirectChatMessage };

export class DirectApiRunner {
  private settings: DarjeelingSettings;
  private handlers: AgentHandlers = {};
  private history: DirectChatMessage[] = [];
  private activeAbortController: AbortController | null = null;
  private isRunning = false;
  private sessionId: string;
  private generationId = 0;

  constructor(settings: DarjeelingSettings) {
    this.settings = settings;
    this.sessionId = this.newSessionId();
  }

  get capabilities(): ProviderCapabilities {
    return {
      tools: false,
      synced: false,
      supportsEffort: true,
    };
  }

  updateSettings(settings: DarjeelingSettings): void {
    this.settings = settings;
  }

  setHandlers(handlers: AgentHandlers): void {
    this.handlers = handlers;
  }

  get isTurnActive(): boolean {
    return this.isRunning;
  }

  get resumeId(): string {
    return this.sessionId;
  }

  resetConversation(): void {
    this.history = [];
    this.sessionId = this.newSessionId();
  }

  adoptSession(id: string | null): void {
    if (id) {
      this.sessionId = id;
    }
  }

  interrupt(): void {
    this.generationId++;
    if (this.activeAbortController) {
      try {
        this.activeAbortController.abort();
      } catch {
        /* ignore */
      }
      this.activeAbortController = null;
    }
    this.isRunning = false;
    this.handlers.onStatus?.({
      type: "dj.status",
      state: "interrupted",
      agent: "direct-api",
    });
  }

  private newSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  resolveProvider(): DirectApiProvider {
    return this.settings.directApiProvider || "gemini";
  }

  resolveConfig(provider: DirectApiProvider): ProviderConfig {
    switch (provider) {
      case "gemini":
        return {
          apiKey: this.settings.geminiApiKey?.trim() || "",
          baseUrl:
            this.settings.providers?.gemini?.baseUrl ||
            "https://generativelanguage.googleapis.com",
          model:
            this.settings.providers?.gemini?.model ||
            this.settings.harnessModels?.gemini ||
            "gemini-3.8-flash",
          effort: this.settings.effort,
        };
      case "anthropic":
        return {
          apiKey: this.settings.anthropicApiKey?.trim() || "",
          baseUrl:
            this.settings.providers?.anthropic?.baseUrl ||
            "https://api.anthropic.com",
          model:
            this.settings.providers?.anthropic?.model ||
            this.settings.harnessModels?.anthropic ||
            "claude-opus-5",
          effort: this.settings.effort,
        };
      case "deepseek":
        return {
          apiKey: this.settings.deepseekApiKey?.trim() || "",
          baseUrl:
            this.settings.deepseekBaseUrl?.trim() ||
            this.settings.providers?.deepseek?.baseUrl ||
            "https://api.deepseek.com",
          model:
            this.settings.deepseekModel?.trim() ||
            this.settings.providers?.deepseek?.model ||
            this.settings.harnessModels?.deepseek ||
            "deepseek-chat",
          effort: this.settings.effort,
        };
      case "openai-compatible":
        return {
          apiKey: this.settings.openaiApiKey?.trim() || "",
          baseUrl:
            this.settings.openaiBaseUrl?.trim() ||
            this.settings.providers?.openaiCompatible?.baseUrl ||
            "https://api.openai.com/v1",
          model:
            this.settings.openaiModel?.trim() ||
            this.settings.providers?.openaiCompatible?.model ||
            this.settings.harnessModels?.["openai-compatible"] ||
            "gpt-4o",
          effort: this.settings.effort,
        };
      case "ollama":
        return {
          apiKey: "",
          baseUrl:
            this.settings.ollamaBaseUrl?.trim() ||
            this.settings.providers?.ollama?.baseUrl ||
            "http://localhost:11434",
          model:
            this.settings.ollamaModel?.trim() ||
            this.settings.providers?.ollama?.model ||
            this.settings.harnessModels?.ollama ||
            "llama3.2",
          effort: this.settings.effort,
        };
      default:
        return {
          apiKey: "",
          baseUrl: "",
          model: "",
        };
    }
  }

  private trimHistory(): void {
    const MAX_HISTORY_CHARS = 32000;
    let totalLength = this.history.reduce((acc, m) => acc + m.content.length, 0);
    while (totalLength > MAX_HISTORY_CHARS && this.history.length > 2) {
      const dropped = this.history.splice(0, 2);
      totalLength -= dropped.reduce((acc, m) => acc + m.content.length, 0);
    }
  }

  async sendTurn(options: TurnOptions): Promise<boolean> {
    if (this.isRunning) {
      this.handlers.onError?.("A turn is already running. Stop it first.");
      return false;
    }

    const provider = this.resolveProvider();
    const config = this.resolveConfig(provider);
    const client = getProviderClient(provider);

    // OpenAI-compatible and Ollama allow keyless access (PD-40)
    if (provider !== "ollama" && provider !== "openai-compatible" && provider !== "openaiCompatible" && !config.apiKey) {
      this.handlers.onError?.(
        `API key not found for provider "${provider}". Please add it in Darjeeling Settings under "AI Engine & Runtime".`
      );
      return false;
    }

    this.isRunning = true;
    this.generationId++;
    const currentGen = this.generationId;
    this.activeAbortController = new AbortController();

    const candidateModel = options.model || getModelForHarness(this.settings, provider) || config.model;
    const modelName = sanitizeModelForHarness(provider, candidateModel);

    this.handlers.onStatus?.({
      type: "dj.status",
      state: "starting",
      agent: `direct-api:${provider}`,
      model: modelName,
      sessionId: this.sessionId,
    });

    try {
      this.handlers.onStatus?.({
        type: "dj.status",
        state: "running",
        agent: `direct-api:${provider}`,
        model: modelName,
        sessionId: this.sessionId,
      });

      const systemPrompt = [
        options.append_system_prompt || "",
        this.settings.appendSystemPrompt || "",
      ]
        .filter(Boolean)
        .join("\n\n");

      const result = await client.call(
        {
          prompt: options.prompt,
          messages: [...this.history],
          append_system_prompt: systemPrompt || undefined,
          json_schema: options.json_schema,
          model: modelName || config.model,
          effort: options.effort || config.effort,
          signal: this.activeAbortController.signal,
        },
        config
      );

      // Check if turn was cancelled or interrupted during request (PD-12)
      if (this.generationId !== currentGen) {
        return false;
      }

      if (result.reasoning_content && this.handlers.onThinking) {
        this.handlers.onThinking(result.reasoning_content);
      }

      if (result.text) {
        this.handlers.onAssistantText?.(result.text);
      }

      // History is committed ONLY after a successful non-empty reply (Task 3)
      if (result.text && result.text.trim()) {
        this.history.push({ role: "user", content: options.prompt });
        this.history.push({ role: "assistant", content: result.text });
        this.trimHistory();
      }

      if (result.truncated) {
        this.handlers.onStatus?.({
          type: "dj.status",
          state: "exited",
          agent: `direct-api:${provider}`,
          model: modelName,
          sessionId: this.sessionId,
        });
      }

      const streamResult: StreamResult = {
        type: "result",
        subtype: "turn_complete",
        result: result.text,
        session_id: this.sessionId,
        usage: result.usage,
      };

      this.handlers.onResult?.(streamResult);
      return true;
    } catch (err: unknown) {
      if (this.generationId !== currentGen) {
        return false;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.handlers.onError?.(message);
      return false;
    } finally {
      if (this.generationId === currentGen) {
        this.isRunning = false;
        this.activeAbortController = null;
      }
    }
  }

  /**
   * Runs a one-off buffered turn with separate message array (CORE-06, PD-01).
   * Does NOT touch this.history and returns { type: 'result', result }
   */
  async runBuffered(options: TurnOptions): Promise<AgentEvent[]> {
    const provider = this.resolveProvider();
    const config = this.resolveConfig(provider);
    const client = getProviderClient(provider);

    const start = Date.now();
    try {
      const systemPrompt = [
        options.append_system_prompt || "",
        this.settings.appendSystemPrompt || "",
      ]
        .filter(Boolean)
        .join("\n\n");

      const candidateModel = options.model || getModelForHarness(this.settings, provider) || config.model;
      const modelName = sanitizeModelForHarness(provider, candidateModel);

      const result = await client.call(
        {
          prompt: options.prompt,
          messages: [], // Independent from chat history
          append_system_prompt: systemPrompt || undefined,
          json_schema: options.json_schema,
          model: modelName || config.model,
          effort: options.effort || config.effort,
        },
        config
      );

      const streamResult: StreamResult = {
        type: "result",
        subtype: "turn_complete",
        result: result.text,
        structured_output: result.structured_output,
        session_id: `buffered_${Date.now()}`,
        usage: result.usage,
        duration_ms: Date.now() - start,
      };

      return [streamResult];
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const errorEvent: DjError = {
        type: "dj.error",
        message,
      };
      return [errorEvent];
    }
  }

  async testConnection(
    providerOverride?: DirectApiProvider
  ): Promise<{ ok: boolean; message: string; models?: ProviderModel[] }> {
    const provider = providerOverride || this.resolveProvider();
    const config = this.resolveConfig(provider);
    const client = getProviderClient(provider);
    return client.testConnection(config);
  }

  async listModels(providerOverride?: DirectApiProvider): Promise<ProviderModel[]> {
    const provider = providerOverride || this.resolveProvider();
    const config = this.resolveConfig(provider);
    const client = getProviderClient(provider);
    return client.listModels ? client.listModels(config) : [];
  }
}

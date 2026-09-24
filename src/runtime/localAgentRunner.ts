import { Platform } from "obsidian";
import { getEnhancedEnv, isExecutable } from "../platform/localProcess";
import { clampToSupported, getCliPermissionArgs } from "../models/permissions";
import type { DarjeelingSettings } from "../settings/schema";
import type {
  AgentEvent,
  AgentHandlers,
  StreamAssistant,
  StreamInit,
  StreamResult,
  StreamUser,
  DjStatus,
  TurnOptions,
} from "../net/agentClient";
import {
  ChildProcessLike,
  getNodeChildProcess,
  getNodeFs,
  getNodePath,
  getNodeProcess,
} from "../platform/node";

type LocalChildProcess = ChildProcessLike;

export function detectLocalBinary(requestedAgent: string): string | null {
  if (!Platform.isDesktop) return null;
  const path = getNodePath();
  if (!path) return null;
  try {
    const env = getEnhancedEnv();
    const dirs = (env.PATH || "").split(path.delimiter);

    const req = (requestedAgent || "").toLowerCase().trim();
    const isClaude = req.includes("claude");
    const isAgy = req.includes("agy");

    // Strictly probe only the requested agent's binary; do not fallback across agents
    const candidates = isClaude
      ? ["claude", "claude-code"]
      : isAgy
      ? ["agy"]
      : [requestedAgent];

    for (const bin of candidates) {
      if (!bin) continue;
      if (path.isAbsolute(bin) && isExecutable(bin)) {
        return bin;
      }
      for (const dir of dirs) {
        const fullPath = path.join(dir, bin);
        if (isExecutable(fullPath)) {
          return fullPath;
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export class LocalAgentRunner {
  private static trackedProcesses = new Set<LocalChildProcess>();

  public static killAll(): void {
    for (const proc of LocalAgentRunner.trackedProcesses) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    LocalAgentRunner.trackedProcesses.clear();
  }

  private settings: DarjeelingSettings;
  private handlers: AgentHandlers = {};
  private activeProc: LocalChildProcess | null = null;
  private isRunning = false;
  private sessionId: string | null = null;
  private vaultPath: string;

  constructor(settings: DarjeelingSettings, vaultPath: string) {
    this.settings = settings;
    this.vaultPath = vaultPath;
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

  get resumeId(): string | null {
    return this.sessionId;
  }

  resetConversation(): void {
    this.sessionId = null;
  }

  adoptSession(id: string | null): void {
    this.sessionId = id;
  }

  interrupt(): void {
    const proc = this.activeProc;
    if (proc) {
      try {
        proc.kill("SIGINT");
      } catch {
        /* ignore */
      }
      const killTimer = window.setTimeout(() => {
        try {
          if (!proc.killed) {
            proc.kill("SIGKILL");
          }
        } catch {
          /* ignore */
        }
      }, 5000);
      proc.once("close", () => window.clearTimeout(killTimer));
      this.activeProc = null;
    }
    this.isRunning = false;
    this.handlers.onStatus?.({
      type: "dj.status",
      state: "interrupted",
      agent: "local",
    });
  }

  async sendTurn(options: TurnOptions): Promise<boolean> {
    if (!Platform.isDesktop) {
      this.handlers.onError?.("Local CLI agent execution is only supported on Desktop.");
      return false;
    }

    if (this.isRunning) {
      let waits = 0;
      while (this.isRunning && waits < 30) {
        await new Promise((r) => window.setTimeout(r, 50));
        waits++;
      }
      if (this.isRunning) {
        this.handlers.onError?.("A turn is already running. Stop it first.");
        return false;
      }
    }

    const requested = options.agent || this.settings.agent;
    const agentBinary = this.detectLocalAgentBinary(requested);
    if (!agentBinary) {
      this.handlers.onError?.(
        `Local agent binary not found for "${requested}". Ensure "${requested}" is installed in your PATH.`
      );
      return false;
    }

    const isAgy = agentBinary.toLowerCase().includes("agy");
    const isClaude = agentBinary.toLowerCase().includes("claude");

    if (isAgy && options.prompt && options.prompt.length > 100 * 1024) {
      this.handlers.onError?.("Prompt exceeds 100 KiB limit for local agy CLI.");
      return false;
    }

    const fs = getNodeFs();
    const cp = getNodeChildProcess();
    const proc = getNodeProcess();
    if (!fs || !cp) {
      this.handlers.onError?.("Local Node desktop environment is unavailable.");
      return false;
    }

    const args = this.buildCliArgs(agentBinary, options);
    const env = getEnhancedEnv();

    let cwd = options.cwd && fs.existsSync(options.cwd) ? options.cwd : undefined;
    if (!cwd && this.vaultPath && fs.existsSync(this.vaultPath)) {
      cwd = this.vaultPath;
    }
    if (!cwd) {
      const pCwd = proc?.cwd ? proc.cwd() : undefined;
      cwd = (pCwd && fs.existsSync(pCwd)) ? pCwd : "/";
    }

    this.isRunning = true;

    this.handlers.onStatus?.({
      type: "dj.status",
      state: "starting",
      agent: agentBinary,
      model: options.model,
      cwd,
    });

    try {
      this.activeProc = cp.spawn(agentBinary, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      LocalAgentRunner.trackedProcesses.add(this.activeProc);
    } catch (err: unknown) {
      this.isRunning = false;
      this.activeProc = null;
      const errMsg = err instanceof Error ? err.message : String(err);
      this.handlers.onError?.(`Failed to spawn ${agentBinary}: ${errMsg}`);
      return false;
    }

    this.activeProc.stdout?.setEncoding("utf8");
    this.activeProc.stderr?.setEncoding("utf8");

    if (isClaude || !isAgy) {
      try {
        this.activeProc.stdin?.write(options.prompt || "");
        this.activeProc.stdin?.end();
      } catch (err) {
        console.warn("[Darjeeling] Error writing prompt to stdin:", err);
      }
    } else {
      try {
        this.activeProc.stdin?.end();
      } catch {
        /* ignore */
      }
    }

    this.handlers.onStatus?.({
      type: "dj.status",
      state: "running",
      agent: agentBinary,
      model: options.model,
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";

    this.activeProc.stdout?.on("data", (chunk: unknown) => {
      stdoutBuffer += typeof chunk === "string" ? chunk : String(chunk);
      const lines = stdoutBuffer.split("\n");
      // Keep last incomplete line in buffer
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as AgentEvent;
          this.dispatch(parsed);
        } catch {
          // If not valid JSON, it might be raw progress or warning
          this.handlers.onAssistantText?.(trimmed + "\n");
        }
      }
    });

    this.activeProc.stderr?.on("data", (chunk: unknown) => {
      stderrBuffer += typeof chunk === "string" ? chunk : String(chunk);
    });

    this.activeProc.on("close", (code: unknown) => {
      if (this.activeProc) {
        LocalAgentRunner.trackedProcesses.delete(this.activeProc);
      }
      this.isRunning = false;
      this.activeProc = null;

      // Flush remaining stdout if any
      if (stdoutBuffer.trim()) {
        try {
          const parsed = JSON.parse(stdoutBuffer.trim()) as AgentEvent;
          this.dispatch(parsed);
        } catch {
          this.handlers.onAssistantText?.(stdoutBuffer.trim());
        }
      }

      const numCode = typeof code === "number" ? code : 0;
      this.handlers.onStatus?.({
        type: "dj.status",
        state: "exited",
        code: numCode,
        stderr: stderrBuffer,
      });

      if (numCode !== 0) {
        if (stderrBuffer) {
          this.handlers.onError?.(`Process exited with code ${numCode}: ${stderrBuffer.slice(0, 500)}`);
        }
      }
    });

    this.activeProc.on("error", (err: unknown) => {
      if (this.activeProc) {
        LocalAgentRunner.trackedProcesses.delete(this.activeProc);
      }
      this.isRunning = false;
      this.activeProc = null;
      const errMsg = err instanceof Error ? err.message : String(err);
      this.handlers.onError?.(`Process error: ${errMsg}`);
      this.handlers.onStatus?.({
        type: "dj.status",
        state: "exited",
        code: 1,
        stderr: `Process spawn failed: ${errMsg}`,
      });
    });

    return true;
  }

  async runBuffered(options: TurnOptions): Promise<AgentEvent[]> {
    if (!Platform.isDesktop) {
      return [
        {
          type: "dj.error",
          message: "Local CLI execution is only supported on Desktop.",
        },
      ];
    }

    const requested = options.agent || this.settings.agent;
    const agentBinary = this.detectLocalAgentBinary(requested);
    if (!agentBinary) {
      return [
        {
          type: "dj.error",
          message: `Local agent binary not found for "${requested}". Ensure "${requested}" is installed in your PATH.`,
        },
      ];
    }

    const isAgy = agentBinary.toLowerCase().includes("agy");
    const isClaude = agentBinary.toLowerCase().includes("claude");

    if (isAgy && options.prompt && options.prompt.length > 100 * 1024) {
      return [
        {
          type: "dj.error",
          message: "Prompt exceeds 100 KiB limit for local agy CLI.",
        },
      ];
    }

    const fs = getNodeFs();
    const cp = getNodeChildProcess();
    const proc = getNodeProcess();
    if (!fs || !cp) {
      return [
        {
          type: "dj.error",
          message: "Local Node desktop environment is unavailable.",
        },
      ];
    }

    const args = this.buildCliArgs(agentBinary, options);
    const env = getEnhancedEnv();
    let cwd = options.cwd && fs.existsSync(options.cwd) ? options.cwd : undefined;
    if (!cwd && this.vaultPath && fs.existsSync(this.vaultPath)) {
      cwd = this.vaultPath;
    }
    if (!cwd) {
      const pCwd = proc?.cwd ? proc.cwd() : undefined;
      cwd = (pCwd && fs.existsSync(pCwd)) ? pCwd : "/";
    }

    return new Promise<AgentEvent[]>((resolve) => {
      const events: AgentEvent[] = [];
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let resultText = "";

      try {
        const child = cp.spawn(agentBinary, args, {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        LocalAgentRunner.trackedProcesses.add(child);

        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");

        if (isClaude || !isAgy) {
          try {
            child.stdin?.write(options.prompt || "");
            child.stdin?.end();
          } catch {
            /* ignore */
          }
        } else {
          try {
            child.stdin?.end();
          } catch {
            /* ignore */
          }
        }

        child.stdout?.on("data", (chunk: unknown) => {
          stdoutBuffer += typeof chunk === "string" ? chunk : String(chunk);
          const lines = stdoutBuffer.split("\n");
          stdoutBuffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed) as AgentEvent;
              events.push(parsed);
              const pRaw = parsed as Record<string, unknown>;
              if (parsed.type === "result" && typeof (parsed as StreamResult).result === "string") {
                resultText = (parsed as StreamResult).result ?? "";
              } else if (pRaw.event === "result") {
                const resObj = pRaw.result as Record<string, unknown> | undefined;
                if (typeof resObj?.response === "string") {
                  resultText = resObj.response;
                }
              } else if (parsed.type === "assistant") {
                for (const b of (parsed as StreamAssistant).message?.content ?? []) {
                  if (b.type === "text" && b.text) resultText += b.text;
                }
              } else if (pRaw.event === "step_update") {
                const updateObj = pRaw.step_update as Record<string, unknown> | undefined;
                if (typeof updateObj?.text_delta === "string") {
                  resultText += updateObj.text_delta;
                }
              }
            } catch {
              /* ignore non-json line */
            }
          }
        });

        child.stderr?.on("data", (chunk: unknown) => {
          stderrBuffer += typeof chunk === "string" ? chunk : String(chunk);
        });

        child.on("error", (err: unknown) => {
          LocalAgentRunner.trackedProcesses.delete(child);
          const errMsg = err instanceof Error ? err.message : String(err);
          resolve([
            {
              type: "dj.error",
              message: `Failed to spawn ${agentBinary}: ${errMsg}`,
            },
          ]);
        });

        child.on("close", (code: unknown) => {
          LocalAgentRunner.trackedProcesses.delete(child);
          if (stdoutBuffer.trim()) {
            try {
              const parsed = JSON.parse(stdoutBuffer.trim()) as AgentEvent;
              events.push(parsed);
              const pRaw = parsed as Record<string, unknown>;
              if (parsed.type === "result" && typeof (parsed as StreamResult).result === "string") {
                resultText = (parsed as StreamResult).result ?? "";
              } else if (pRaw.event === "result") {
                const resObj = pRaw.result as Record<string, unknown> | undefined;
                if (typeof resObj?.response === "string") {
                  resultText = resObj.response;
                }
              }
            } catch {
              /* ignore */
            }
          }

          const hasResult = events.some((e) => {
            const raw = e as Record<string, unknown>;
            return e.type === "result" || raw.event === "result";
          });

          const exitCode = typeof code === "number" ? code : 0;
          if (exitCode !== 0 && !hasResult) {
            resolve([
              {
                type: "dj.error",
                message: `Agent exited with code ${exitCode}. ${stderrBuffer.trim()}`,
              },
            ]);
            return;
          }

          if (!hasResult) {
            events.push({
              type: "result",
              subtype: "turn_complete",
              result: resultText,
            });
          }

          resolve(events);
        });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        resolve([
          {
            type: "dj.error",
            message: `Execution failed: ${errMsg}`,
          },
        ]);
      }
    });
  }

  public detectLocalAgentBinary(requestedAgent: string): string | null {
    return detectLocalBinary(requestedAgent);
  }

  private buildCliArgs(binary: string, options: TurnOptions): string[] {
    const isAgy = binary.toLowerCase().includes("agy");
    const isClaude = binary.toLowerCase().includes("claude");
    const args: string[] = ["--output-format", "stream-json"];

    if (isClaude) {
      args.push("--verbose");
    }

    if (this.sessionId && !options.fork) {
      if (isAgy) {
        args.push("--conversation", this.sessionId);
      } else {
        args.push("--resume", this.sessionId);
      }
    }

    if (options.model) {
      if (isAgy) {
        let validAgyModel = options.model;
        const hasEffortSuffix = /-(high|medium|low)$/.test(validAgyModel);
        if (options.effort) {
          if (hasEffortSuffix) {
            validAgyModel = validAgyModel.replace(/-(high|medium|low)$/, `-${options.effort}`);
          } else {
            args.push("--effort", options.effort);
          }
        }
        args.push("--model", validAgyModel);
      } else {
        // Pass model through unchanged (DOC-25: no silent fallback)
        args.push("--model", options.model);
        if (options.effort) {
          args.push("--effort", options.effort);
        }
      }
    } else if (options.effort) {
      args.push("--effort", options.effort);
    }

    const permMode = clampToSupported(
      options.permission_mode ?? this.settings.permissionMode,
      ["plan", "acceptEdits", "bypassPermissions"]
    );
    const permArgs = getCliPermissionArgs(isClaude ? "claude" : "agy", permMode);
    args.push(...permArgs);

    let promptText = options.prompt || "";
    if (isAgy && options.append_system_prompt) {
      promptText = `System Context:\n${options.append_system_prompt}\n\n---\n\n${promptText}`;
    } else if (options.append_system_prompt) {
      args.push("--append-system-prompt", options.append_system_prompt);
    }

    if (options.json_schema) {
      args.push("--json-schema", JSON.stringify(options.json_schema));
    }

    if (isAgy) {
      args.push(`-p=${promptText}`);
    }

    return args;
  }

  private dispatch(event: AgentEvent): void {
    if (!event || typeof event !== "object") return;

    const raw = event as Record<string, unknown>;
    const resObj = (raw.result && typeof raw.result === "object") ? (raw.result as Record<string, unknown>) : undefined;
    const stepUpdateObj = (raw.step_update && typeof raw.step_update === "object") ? (raw.step_update as Record<string, unknown>) : undefined;

    const sid =
      (typeof raw.session_id === "string" && raw.session_id) ||
      (typeof raw.sessionId === "string" && raw.sessionId) ||
      (typeof raw.conversation_id === "string" && raw.conversation_id) ||
      (typeof resObj?.conversation_id === "string" && resObj.conversation_id) ||
      (typeof stepUpdateObj?.conversation_id === "string" && stepUpdateObj.conversation_id) ||
      undefined;
    if (sid) this.sessionId = sid;

    // Claude Code stream-json format
    if (event.type === "system") {
      const init = event as StreamInit;
      if (init.subtype === "init") this.handlers.onInit?.(init);
      return;
    }

    if (event.type === "assistant") {
      const msg = (event as StreamAssistant).message;
      const model = msg?.model;
      for (const block of msg?.content ?? []) {
        if (block.type === "text" && block.text) {
          this.handlers.onAssistantText?.(block.text, model);
        } else if (block.type === "thinking" && (block.thinking || block.text)) {
          this.handlers.onThinking?.(block.thinking ?? block.text ?? "");
        } else if (block.type === "tool_use") {
          this.handlers.onToolUse?.(block);
        }
      }
      return;
    }

    if (event.type === "user") {
      for (const block of (event as StreamUser).message?.content ?? []) {
        if (block.type === "tool_result") this.handlers.onToolResult?.(block);
      }
      return;
    }

    if (event.type === "result" || raw.stop_reason === "end_turn") {
      const rawRes = raw.result;
      const resultText =
        typeof rawRes === "string"
          ? rawRes
          : typeof resObj?.response === "string"
          ? resObj.response
          : "";
      const dur =
        typeof raw.duration_ms === "number"
          ? raw.duration_ms
          : typeof raw.duration_seconds === "number"
          ? Math.round(raw.duration_seconds * 1000)
          : undefined;
      const usageObj = (raw.usage && typeof raw.usage === "object")
        ? (raw.usage as Record<string, unknown>)
        : undefined;

      this.handlers.onResult?.({
        type: "result",
        subtype: raw.is_error ? "turn_error" : "turn_complete",
        result: resultText,
        session_id: sid,
        duration_ms: dur,
        num_turns: typeof raw.num_turns === "number" ? raw.num_turns : 1,
        usage: usageObj
          ? {
              input_tokens: typeof usageObj.input_tokens === "number" ? usageObj.input_tokens : 0,
              output_tokens: typeof usageObj.output_tokens === "number" ? usageObj.output_tokens : 0,
              ...(typeof usageObj.cache_read_tokens === "number"
                ? { cache_read_input_tokens: usageObj.cache_read_tokens }
                : {}),
            }
          : undefined,
        total_cost_usd: typeof raw.total_cost_usd === "number" ? raw.total_cost_usd : typeof raw.cost_usd === "number" ? raw.cost_usd : undefined,
        is_error: Boolean(raw.is_error),
      });
      return;
    }

    if (event.type === "dj.status") {
      this.handlers.onStatus?.(event as DjStatus);
      return;
    }

    // agy stream-json format (event.event)
    if (raw.event === "init") {
      const initData = (raw.init && typeof raw.init === "object") ? (raw.init as Partial<StreamInit>) : {};
      this.handlers.onInit?.({
        type: "system",
        subtype: "init",
        session_id: sid,
        ...initData,
      });
      return;
    }

    if (raw.event === "step_update") {
      const update = stepUpdateObj;
      if (update?.step_type === "agent_response") {
        if (typeof update.text_delta === "string") {
          this.handlers.onAssistantText?.(update.text_delta);
        }
        if (typeof update.thinking === "string") {
          this.handlers.onThinking?.(update.thinking);
        }
      } else if (update?.step_type === "tool") {
        const stepIndex = typeof update.step_index === "number" ? update.step_index : 0;
        const stepId = `step-${stepIndex}`;
        const toolInfo = (update.tool_info && typeof update.tool_info === "object") ? (update.tool_info as Record<string, unknown>) : undefined;
        const toolName = (typeof update.tool_name === "string" && update.tool_name) || (typeof toolInfo?.name === "string" && toolInfo.name) || "tool";
        if (update.state === "ACTIVE") {
          const params = (toolInfo?.parameters && typeof toolInfo.parameters === "object") ? (toolInfo.parameters as Record<string, unknown>) : {};
          this.handlers.onToolUse?.({
            type: "tool_use",
            id: stepId,
            name: toolName,
            input: params,
          });
        } else if (update.state === "DONE") {
          const output = typeof toolInfo?.output === "string" ? toolInfo.output : "";
          this.handlers.onToolResult?.({
            type: "tool_result",
            tool_use_id: stepId,
            content: output,
          });
        }
      }
      return;
    }

    if (raw.event === "result") {
      const res = resObj;
      const dur = typeof res?.duration_seconds === "number" ? res.duration_seconds : undefined;
      const statusStr = typeof res?.status === "string" ? res.status.toUpperCase() : "";
      const isError = Boolean(res?.is_error) || statusStr === "ERROR" || statusStr === "FAILED";
      const usageObj = (res?.usage && typeof res.usage === "object") ? (res.usage as Record<string, unknown>) : undefined;
      const numTurns = typeof res?.num_turns === "number" ? res.num_turns : 1;
      const responseText = typeof res?.response === "string" ? res.response : "";

      this.handlers.onResult?.({
        type: "result",
        subtype: isError ? "turn_error" : "turn_complete",
        result: responseText,
        session_id: sid,
        duration_ms: dur ? Math.round(dur * 1000) : undefined,
        num_turns: numTurns,
        usage: usageObj
          ? {
              input_tokens: typeof usageObj.input_tokens === "number" ? usageObj.input_tokens : 0,
              output_tokens: typeof usageObj.output_tokens === "number" ? usageObj.output_tokens : 0,
              ...(typeof usageObj.cache_read_tokens === "number"
                ? { cache_read_input_tokens: usageObj.cache_read_tokens }
                : {}),
            }
          : undefined,
        is_error: isError,
      });
      return;
    }
  }
}

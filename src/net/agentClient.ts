/**
 * Structured agent channel client (protocol v2).
 *
 * Talks to the host's /ws/agent endpoint, which spawns the coding-agent CLI
 * with --output-format stream-json and forwards its NDJSON event stream. We
 * translate those events into a typed callback surface the views can render.
 */

import { App, requestUrl } from "obsidian";
import type { DarjeelingSettings, RuntimeMode } from "../settings/schema";
import { DirectApiRunner } from "../runtime/directApi";
import { LocalAgentRunner } from "../runtime/localAgentRunner";
import { clampToSupported } from "../models/permissions";
import { isBypassConfirmedForConversation } from "../ui/modals/confirm";
import { getAgentPermissionModes } from "../runtime/agents";
import {
  checkProtocolCompatibility,
  mapAc17Error,
  type Ac17ErrorInfo,
  type ProtocolCheckResult,
} from "../errors";
import { toWebSocketUrl } from "./url";
import {
  getCachedLocalBinary,
  resolveDeviceRuntime,
} from "../runtime/router";
import {
  dropContinuityPointer,
  getContinuityPointer,
  setContinuityPointer,
} from "../settings/device";

/** Events Claude Code emits on stdout under --output-format stream-json. */
export interface StreamInit {
  type: "system";
  subtype: "init";
  session_id?: string;
  model?: string;
  cwd?: string;
  tools?: string[];
  permissionMode?: string;
  slash_commands?: string[];
}

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking" | (string & Record<never, never>);
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface StreamAssistant {
  type: "assistant";
  session_id?: string;
  message: {
    id?: string;
    role: "assistant";
    model?: string;
    content: ContentBlock[];
    stop_reason?: string | null;
    usage?: TokenUsage;
  };
}

export interface StreamUser {
  type: "user";
  session_id?: string;
  message: { role: "user"; content: ContentBlock[] };
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface StreamResult {
  type: "result";
  subtype: string;
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: TokenUsage;
  structured_output?: unknown;
}

/** Frames the Darjeeling server adds around the CLI's own output. */
export interface DjStatus {
  type: "dj.status";
  state: "starting" | "running" | "exited" | "interrupted";
  agent?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  cwd?: string;
  command?: string;
  code?: number;
  sessionId?: string;
  durationMs?: number;
  stderr?: string;
}

export interface DjError {
  type: "dj.error";
  message: string;
}

export type AgentEvent =
  | StreamInit
  | StreamAssistant
  | StreamUser
  | StreamResult
  | DjStatus
  | DjError
  | { type: "dj.raw"; line: string }
  | { type: "dj.pong"; t: number }
  | { type: "turn_expired"; turn_id: string }
  | { type: "session_busy"; session_id: string }
  | { type: "stream_event"; event: Record<string, unknown> }
  | { type: string; [key: string]: unknown };

export type AgentEventListener = (event: AgentEvent) => void;

export interface ModelProbe {
  requested: string;
  resolved?: string;
  ok: boolean;
  substituted?: boolean;
}

/** What a turn asks the host to run. Mirrors server.TurnRequest. */
export interface TurnOptions {
  agent: string;
  prompt: string;
  model?: string;
  fallback_model?: string;
  effort?: string;
  permission_mode?: string;
  resume?: string;
  fork?: boolean;
  cwd?: string;
  append_system_prompt?: string;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  partial_messages?: boolean;
  /** Handed to the CLI's --json-schema so a turn returns parseable JSON. */
  json_schema?: Record<string, unknown>;
  client_turn_id?: string;
  is_plan_turn?: boolean;
  is_buffered_turn?: boolean;
}

export interface AgentHandlers {
  onInit?: (event: StreamInit) => void;
  onAssistantText?: (text: string, model?: string) => void;
  onThinking?: (text: string) => void;
  onToolUse?: (block: ContentBlock) => void;
  onToolResult?: (block: ContentBlock) => void;
  onResult?: (event: StreamResult) => void;
  onStatus?: (event: DjStatus) => void;
  onError?: (message: string) => void;
  onConnectionChange?: (state: ConnectionState) => void;
  onConnectionError?: (info: Ac17ErrorInfo) => void;
}

export type ConnectionState = "connecting" | "open" | "closed" | "unauthorized";

export interface AgentDescriptor {
  key: string;
  label: string;
  binary: string;
  available: boolean;
  version: string | null;
  models: { id: string; label: string }[];
  efforts: string[];
  permissionModes: { id: string; label: string }[];
  isApi?: boolean;
}

export interface ConnectionSnapshot {
  baseUrl: string;
  token: string;
  hostId: string;
  mode: RuntimeMode;
}

export class AgentClient {
  private settings: DarjeelingSettings;
  private socket: WebSocket | null = null;
  private handlers: AgentHandlers = {};
  private state: ConnectionState = "closed";

  private directApiRunner: DirectApiRunner;
  private localAgentRunner: LocalAgentRunner;
  private vaultPath: string;
  private app?: App;

  /** Continuity token from the CLI, threaded into the next turn as --resume. */
  private sessionId: string | null = null;
  private activeCwd: string = "";
  private activeAgent: string = "";

  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private wantConnection = false;
  private turnActive = false;
  private heartbeatTimer: number | null = null;
  private pongTimeout: number | null = null;

  // S2-W2 Protocol v2 state tracking
  private activeTurnId: string | null = null;
  private lastSeq = 0;
  private currentClientTurnId: string | null = null;
  private lastSnapshot: ConnectionSnapshot | null = null;

  // Listener Registry (Task 4, 11)
  private globalListeners = new Set<AgentEventListener>();
  private turnListeners = new Map<string, Set<AgentEventListener>>();

  // Bound window event handlers
  private onVisibilityChangeBound: (() => void) | null = null;
  private onOnlineBound: (() => void) | null = null;

  constructor(settings: DarjeelingSettings, vaultPath: string = "", app?: App) {
    this.settings = settings;
    this.vaultPath = vaultPath;
    this.app = app;
    this.directApiRunner = new DirectApiRunner(settings);
    this.localAgentRunner = new LocalAgentRunner(settings, vaultPath);
    this.lastSnapshot = this.takeSnapshot();

    this.bindWindowEvents();
  }

  private bindWindowEvents(): void {
    if (typeof document !== "undefined" && typeof window !== "undefined") {
      this.onVisibilityChangeBound = () => {
        if (document.visibilityState === "visible") {
          this.handleForeground();
        }
      };
      this.onOnlineBound = () => {
        this.handleForeground();
      };
      document.addEventListener("visibilitychange", this.onVisibilityChangeBound);
      window.addEventListener("online", this.onOnlineBound);
    }
  }

  public destroy(): void {
    this.disconnect();
    if (typeof document !== "undefined" && this.onVisibilityChangeBound) {
      document.removeEventListener("visibilitychange", this.onVisibilityChangeBound);
      this.onVisibilityChangeBound = null;
    }
    if (typeof window !== "undefined" && this.onOnlineBound) {
      window.removeEventListener("online", this.onOnlineBound);
      this.onOnlineBound = null;
    }
    this.globalListeners.clear();
    this.turnListeners.clear();
  }

  public isBusy(): boolean {
    return this.turnActive;
  }

  public handleForeground(): void {
    const mode = this.getEffectiveRuntimeMode();
    if (mode !== "remote") return;

    // Reset backoff on foreground (Task 6)
    this.reconnectAttempt = 0;

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      // Send immediate ping and set 10s pong deadline
      try {
        this.socket.send(JSON.stringify({ type: "ping" }));
      } catch {
        /* socket send error */
      }
      this.schedulePongDeadline(10000);
    } else if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      if (this.wantConnection) {
        this.connect();
      }
    }
  }

  private schedulePongDeadline(timeoutMs = 10000): void {
    if (this.pongTimeout !== null) {
      window.clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
    this.pongTimeout = window.setTimeout(() => {
      this.pongTimeout = null;
      // Socket is half-open; force close and reconnect
      if (this.socket) {
        try {
          this.socket.close();
        } catch {
          /* ignore */
        }
        this.socket = null;
      }
      if (this.wantConnection) {
        this.connect();
      }
    }, timeoutMs);
  }

  private clearPongDeadline(): void {
    if (this.pongTimeout !== null) {
      window.clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  get directRunner(): DirectApiRunner {
    return this.directApiRunner;
  }

  get localRunner(): LocalAgentRunner {
    return this.localAgentRunner;
  }

  /**
   * Resolves explicit per-device runtime mode without triggering side effects or UI notices (CORE-31).
   */
  getEffectiveRuntimeMode(): RuntimeMode {
    return resolveDeviceRuntime(this.settings, this.app);
  }

  public getBaseUrl(): string {
    const activeHost = this.settings.hosts?.find((h) => h.id === this.settings.activeHostId);
    if (activeHost?.baseUrl) {
      return activeHost.baseUrl.replace(/\/$/, "");
    }
    const host = this.settings.meshnetHost || "127.0.0.1";
    const port = this.settings.port || 8765;
    return `http://${host}:${port}`;
  }

  public getAuthToken(): string {
    if (this.settings.authToken) {
      return this.settings.authToken;
    }
    const activeHost = this.settings.hosts?.find(
      (h) => h.id === this.settings.activeHostId
    );
    if (activeHost?.authToken) {
      return activeHost.authToken;
    }
    const remoteHost = this.settings.remoteHosts?.find(
      (h) => h.id === (this.settings.activeRemoteHostId || this.settings.activeHostId)
    );
    if (remoteHost?.authToken) {
      return remoteHost.authToken;
    }
    const tokenSecretId = activeHost?.tokenSecretId || remoteHost?.tokenSecretId || "dj_token";
    if (this.app) {
      const typed = this.app as unknown as { loadLocalStorage?(k: string): string | null };
      try {
        const val =
          typed.loadLocalStorage?.(`dj_secret_${tokenSecretId}`) ||
          typed.loadLocalStorage?.("dj_secret_dj_token") ||
          typed.loadLocalStorage?.("dj_secret_primary");
        if (val) return val;
      } catch {
        /* ignore */
      }
    }
    if (typeof window !== "undefined" && window.localStorage) {
      const val =
        window.localStorage.getItem(`dj_secret_${tokenSecretId}`) ||
        window.localStorage.getItem("dj_secret_dj_token") ||
        window.localStorage.getItem("dj_secret_primary");
      if (val) return val;
    }
    return "";
  }

  public setAuthToken(token: string): void {
    this.settings.authToken = token;
    const activeHost = this.settings.hosts?.find(
      (h) => h.id === this.settings.activeHostId
    );
    if (activeHost) activeHost.authToken = token;
    const remoteHost = this.settings.remoteHosts?.find(
      (h) => h.id === (this.settings.activeRemoteHostId || this.settings.activeHostId)
    );
    if (remoteHost) remoteHost.authToken = token;
    const tokenSecretId = activeHost?.tokenSecretId || remoteHost?.tokenSecretId || "dj_token";
    if (this.app) {
      const typed = this.app as unknown as { saveLocalStorage?(k: string, v: string): void };
      try {
        typed.saveLocalStorage?.(`dj_secret_${tokenSecretId}`, token);
        typed.saveLocalStorage?.("dj_secret_dj_token", token);
      } catch {
        /* ignore */
      }
    }
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(`dj_secret_${tokenSecretId}`, token);
      window.localStorage.setItem("dj_secret_dj_token", token);
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
      if (this.wantConnection) {
        this.connect();
      }
    }
  }

  private takeSnapshot(): ConnectionSnapshot {
    return {
      baseUrl: this.getBaseUrl(),
      token: this.getAuthToken(),
      hostId: this.settings.activeHostId || "",
      mode: this.getEffectiveRuntimeMode(),
    };
  }

  updateSettings(settings: DarjeelingSettings): void {
    this.settings = settings;
    this.directApiRunner.updateSettings(settings);
    this.localAgentRunner.updateSettings(settings);

    const newSnapshot = this.takeSnapshot();
    const snapshotChanged =
      !this.lastSnapshot ||
      this.lastSnapshot.baseUrl !== newSnapshot.baseUrl ||
      this.lastSnapshot.token !== newSnapshot.token ||
      this.lastSnapshot.hostId !== newSnapshot.hostId ||
      this.lastSnapshot.mode !== newSnapshot.mode;

    this.lastSnapshot = newSnapshot;

    if (newSnapshot.mode === "remote") {
      if (snapshotChanged || !this.socket || this.socket.readyState === WebSocket.CLOSED) {
        this.disconnect();
        this.connect();
      }
    } else {
      if (this.socket) {
        this.disconnect();
      }
      this.setState("open");
    }
  }

  setHandlers(handlers: AgentHandlers): void {
    this.handlers = handlers;
    this.directApiRunner.setHandlers(handlers);
    this.localAgentRunner.setHandlers(handlers);
    this.handlers.onConnectionChange?.(this.connectionState);
  }

  // Listener Registry API (Task 4, 11)
  addListener(listener: AgentEventListener): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  removeListener(listener: AgentEventListener): void {
    this.globalListeners.delete(listener);
  }

  addTurnListener(turnId: string, listener: AgentEventListener): () => void {
    let set = this.turnListeners.get(turnId);
    if (!set) {
      set = new Set();
      this.turnListeners.set(turnId, set);
    }
    set.add(listener);
    return () => {
      const current = this.turnListeners.get(turnId);
      current?.delete(listener);
      if (current?.size === 0) {
        this.turnListeners.delete(turnId);
      }
    };
  }

  get connectionState(): ConnectionState {
    const mode = this.getEffectiveRuntimeMode();
    if (mode === "local" || mode === "direct-api") {
      return "open";
    }
    return this.state;
  }

  get isTurnActive(): boolean {
    return (
      this.turnActive ||
      this.directApiRunner.isTurnActive ||
      this.localAgentRunner.isTurnActive
    );
  }

  get resumeId(): string | null {
    const mode = this.getEffectiveRuntimeMode();
    if (mode === "direct-api") return this.directApiRunner.resumeId;
    if (mode === "local") return this.localAgentRunner.resumeId;
    return this.sessionId;
  }

  getSessionId(): string | null {
    return this.resumeId;
  }

  /** Forget continuity so the next turn starts a fresh agent conversation. */
  resetConversation(): void {
    this.sessionId = null;
    this.directApiRunner.resetConversation();
    this.localAgentRunner.resetConversation();
    if (this.app) {
      dropContinuityPointer(
        this.app,
        this.getEffectiveRuntimeMode(),
        this.settings.activeHostId,
        this.activeAgent,
        this.activeCwd
      );
    }
  }

  /**
   * Adopt a session id captured earlier.
   * Direct runner NEVER adopts remote IDs (CORE-09, CHAT-05, PD-17, PD-39).
   */
  adoptSession(id: string | null): void {
    this.sessionId = id;
    const mode = this.getEffectiveRuntimeMode();
    if (mode === "local") {
      this.localAgentRunner.adoptSession(id);
    }
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.handlers.onConnectionChange?.(next);
  }

  connect(): void {
    this.wantConnection = true;
    const mode = this.getEffectiveRuntimeMode();
    if (mode === "direct-api" || mode === "local") {
      this.state = "open";
      this.handlers.onConnectionChange?.("open");
      return;
    }

    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const baseUrl = this.getBaseUrl();
    const token = this.getAuthToken();
    const wsUrl = toWebSocketUrl(baseUrl, "/ws/agent");
    this.setState("connecting");

    const protocols = token ? [`darjeeling.token.${token}`] : undefined;

    let socket: WebSocket;
    try {
      // egress: host-ws
      socket = protocols ? new WebSocket(wsUrl, protocols) : new WebSocket(wsUrl);
      this.socket = socket;
    } catch (err) {
      const errInfo = mapAc17Error("unreachable", `Could not open agent channel: ${String(err)}`);
      this.handlers.onConnectionError?.(errInfo);
      this.setState("closed");
      this.scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      // Guard against stale socket instances (CHAT-07)
      if (this.socket !== socket) return;

      this.reconnectAttempt = 0;
      this.setState("open");
      this.startHeartbeat();

      // If a turn was active when we reconnected, re-attach to the running turn! (Task 6, ADR-11)
      if (this.turnActive && this.activeTurnId) {
        socket.send(
          JSON.stringify({
            type: "attach",
            turn_id: this.activeTurnId,
            since_seq: this.lastSeq,
          })
        );
      }
    };

    socket.onmessage = (event: MessageEvent) => {
      // Guard against stale socket instances (CHAT-07)
      if (this.socket !== socket) return;

      if (typeof event.data !== "string") return;
      for (const line of event.data.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          this.dispatch(JSON.parse(trimmed) as AgentEvent);
        } catch {
          this.handlers.onError?.(`Unparseable frame: ${trimmed.slice(0, 200)}`);
        }
      }
    };

    socket.onerror = () => {
      // Guard against stale socket instances (CHAT-07)
      if (this.socket !== socket) return;
      // onclose carries actionable detail; avoid double-reporting.
    };

    socket.onclose = (event: CloseEvent) => {
      // Stale onclose is ignored! (CHAT-07)
      if (this.socket !== socket) return;

      this.stopHeartbeat();
      this.clearPongDeadline();
      this.socket = null;

      // Close code 4401 (or legacy 1008): unauthorized -> stop retrying immediately (QA-07, CHAT-14)
      if (event.code === 4401 || event.code === 1008) {
        this.setState("unauthorized");
        this.turnActive = false;
        const errInfo = mapAc17Error(
          "token_rejected",
          "Authentication failed: token rejected by host (close 4401)."
        );
        this.handlers.onConnectionError?.(errInfo);
        return;
      }

      this.setState("closed");

      // Under ADR-11, turns outlive disconnected sockets. If a turn is active, do NOT fail it;
      // schedule reconnect to re-attach.
      if (this.turnActive) {
        this.handlers.onConnectionError?.(
          mapAc17Error("unreachable", "Connection dropped during active turn; reconnecting...")
        );
      }

      if (this.wantConnection) {
        this.scheduleReconnect();
      }
    };
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        try {
          this.socket.send(JSON.stringify({ type: "ping" }));
        } catch {
          /* ignore */
        }
      }
    }, 10000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private waitForSocketOpen(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        resolve(true);
        return;
      }
      const start = Date.now();
      const interval = window.setInterval(() => {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
          window.clearInterval(interval);
          resolve(true);
        } else if (Date.now() - start > timeoutMs) {
          window.clearInterval(interval);
          resolve(false);
        }
      }, 100);
    });
  }

  disconnect(): void {
    this.wantConnection = false;
    this.stopHeartbeat();
    this.clearPongDeadline();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already gone */
      }
      this.socket = null;
    }
    this.directApiRunner.interrupt();
    this.localAgentRunner.interrupt();
    this.turnActive = false;
    this.activeTurnId = null;
    this.lastSeq = 0;
    this.setState("closed");
  }

  private scheduleReconnect(): void {
    if (!this.wantConnection || this.reconnectTimer !== null) return;
    const base = Math.min(1000 * 2 ** this.reconnectAttempt, 30000);
    const delay = base + Math.random() * 500;
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 6);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wantConnection) this.connect();
    }, delay);
  }

  private dispatch(event: AgentEvent): void {
    if (!event || typeof event !== "object") return;

    // Handle pong frame
    if (event.type === "dj.pong") {
      this.clearPongDeadline();
      return;
    }

    // Protocol v2 sequence tracking and deduplication
    const raw = event as Record<string, unknown>;
    const djTurn = typeof raw.dj_turn === "string" ? raw.dj_turn : null;
    const djSeq = typeof raw.dj_seq === "number" ? raw.dj_seq : null;

    if (djTurn) {
      this.activeTurnId = djTurn;
    }

    if (djSeq !== null) {
      if (djSeq <= this.lastSeq) {
        // Deduplicate replay frame (Task 6)
        return;
      }
      this.lastSeq = djSeq;
    }

    // Capture continuity from whichever frame or property carries it
    const resObj = (raw.result && typeof raw.result === "object") ? (raw.result as Record<string, unknown>) : undefined;
    const stepUpdateObj = (raw.step_update && typeof raw.step_update === "object") ? (raw.step_update as Record<string, unknown>) : undefined;

    const sid =
      (typeof raw.session_id === "string" && raw.session_id) ||
      (typeof raw.sessionId === "string" && raw.sessionId) ||
      (typeof raw.conversation_id === "string" && raw.conversation_id) ||
      (typeof resObj?.conversation_id === "string" && resObj.conversation_id) ||
      (typeof stepUpdateObj?.conversation_id === "string" && stepUpdateObj.conversation_id) ||
      undefined;
    if (sid) {
      this.sessionId = sid;
    }

    // Notify listeners (global and turn-specific)
    for (const listener of this.globalListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[Darjeeling] Global listener error:", err);
      }
    }
    if (this.activeTurnId) {
      const turnSet = this.turnListeners.get(this.activeTurnId);
      if (turnSet) {
        for (const listener of turnSet) {
          try {
            listener(event);
          } catch (err) {
            console.error("[Darjeeling] Turn listener error:", err);
          }
        }
      }
    }

    // Handle turn expired
    if (event.type === "turn_expired") {
      this.turnActive = false;
      this.handlers.onError?.("The remote turn buffer expired on the host.");
      return;
    }

    // Handle session busy
    if (event.type === "session_busy") {
      this.turnActive = false;
      this.handlers.onError?.("Session is currently running another turn on the host.");
      return;
    }

    // Handle raw Antigravity CLI event stream (event.event)
    if (typeof raw.event === "string") {
      if (raw.event === "init") {
        const initData = (raw.init && typeof raw.init === "object")
          ? (raw.init as Partial<StreamInit>)
          : {};
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
          const toolInfo = (update.tool_info && typeof update.tool_info === "object")
            ? (update.tool_info as Record<string, unknown>)
            : undefined;
          const toolName =
            (typeof update.tool_name === "string" && update.tool_name) ||
            (typeof toolInfo?.name === "string" && toolInfo.name) ||
            "tool";
          if (update.state === "ACTIVE") {
            const params = (toolInfo?.parameters && typeof toolInfo.parameters === "object")
              ? (toolInfo.parameters as Record<string, unknown>)
              : {};
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
        this.turnActive = false;
        const res = resObj;
        const dur = typeof res?.duration_seconds === "number" ? res.duration_seconds : undefined;
        const statusStr = typeof res?.status === "string" ? res.status.toUpperCase() : "";
        const isError = Boolean(res?.is_error) || statusStr === "ERROR" || statusStr === "FAILED";
        const usageObj = (res?.usage && typeof res.usage === "object")
          ? (res.usage as Record<string, unknown>)
          : undefined;
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
                cache_read_input_tokens:
                  typeof usageObj.cache_read_tokens === "number" ? usageObj.cache_read_tokens : undefined,
              }
            : undefined,
          is_error: isError,
          structured_output: res?.structured_output,
        });
        if (sid) {
          this.recordContinuityOnTurnSuccess(sid);
        }
        return;
      }
    }

    switch (event.type) {
      case "system": {
        const init = event as StreamInit;
        if (init.subtype === "init") this.handlers.onInit?.(init);
        return;
      }

      case "assistant": {
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

      case "user": {
        for (const block of (event as StreamUser).message?.content ?? []) {
          if (block.type === "tool_result") this.handlers.onToolResult?.(block);
        }
        return;
      }

      case "result": {
        this.turnActive = false;
        const result = event as StreamResult;
        if (result.session_id) this.sessionId = result.session_id;
        this.handlers.onResult?.(result);
        this.recordContinuityOnTurnSuccess(result.session_id);
        return;
      }

      case "dj.status": {
        const status = event as DjStatus;
        if (status.state === "running" || status.state === "starting") {
          this.turnActive = true;
        }
        if (status.state === "exited" || status.state === "interrupted") {
          this.turnActive = false;
          if (status.sessionId) this.sessionId = status.sessionId;
          this.recordContinuityOnTurnSuccess(status.sessionId);
        }
        this.handlers.onStatus?.(status);
        return;
      }

      case "dj.error": {
        this.turnActive = false;
        const errMessage = (event as DjError).message;
        if (
          errMessage.includes("session invalid") ||
          errMessage.includes("session not found") ||
          errMessage.includes("failed resume")
        ) {
          if (this.app) {
            dropContinuityPointer(
              this.app,
              this.getEffectiveRuntimeMode(),
              this.settings.activeHostId,
              this.activeAgent,
              this.activeCwd
            );
          }
          this.sessionId = null;
        }
        this.handlers.onError?.(errMessage);
        return;
      }

      case "dj.raw": {
        this.handlers.onError?.(
          `Host output: ${String((event as { line: string }).line)}`
        );
        return;
      }

      default:
        return;
    }
  }

  private recordContinuityOnTurnSuccess(sessionId?: string): void {
    if (!sessionId || !this.app) return;
    const mode = this.getEffectiveRuntimeMode();
    // Continuity pointer in device store (CORE-09, CHAT-05)
    setContinuityPointer(
      this.app,
      mode,
      this.settings.activeHostId,
      this.activeAgent,
      this.activeCwd,
      sessionId
    );
  }

  // ----------------------------------------------------------------- API publications (Task 11)

  /**
   * Start an asynchronous turn on the host. Returns turn_id and status.
   */
  async startAsyncTurn(options: TurnOptions): Promise<{ turn_id: string; status: string } | null> {
    const baseUrl = this.getBaseUrl();
    const token = this.getAuthToken();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) {
      headers["X-Darjeeling-Token"] = token;
      headers["Authorization"] = `Bearer ${token}`;
    }

    try {
      // egress: host-http
      const res = await requestUrl({
        url: `${baseUrl}/api/agent/turn`,
        method: "POST",
        headers,
        body: JSON.stringify({ ...options, async: true }),
        throw: false,
      });

      if (res.status >= 200 && res.status < 300) {
        return res.json as { turn_id: string; status: string };
      }
      return null;
    } catch (err) {
      console.error("[Darjeeling] startAsyncTurn failed:", err);
      return null;
    }
  }

  /**
   * Polls events for an ongoing or completed turn.
   */
  async pollTurn(
    turnId: string,
    sinceSeq = 0,
    waitSeconds = 25
  ): Promise<{
    turn_id: string;
    events: AgentEvent[];
    is_active: boolean;
    latest_seq: number;
  } | null> {
    const baseUrl = this.getBaseUrl();
    const token = this.getAuthToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers["X-Darjeeling-Token"] = token;
      headers["Authorization"] = `Bearer ${token}`;
    }

    const url = `${baseUrl}/api/turns/${encodeURIComponent(turnId)}/events?since_seq=${sinceSeq}&wait=${waitSeconds}`;
    try {
      // egress: host-http
      const res = await requestUrl({
        url,
        method: "GET",
        headers,
        throw: false,
      });

      if (res.status >= 200 && res.status < 300) {
        return res.json as {
          turn_id: string;
          events: AgentEvent[];
          is_active: boolean;
          latest_seq: number;
        };
      }
      return null;
    } catch (err) {
      console.error("[Darjeeling] pollTurn failed:", err);
      return null;
    }
  }

  /**
   * Pushes a single file to the host with sha256 conflict detection (for S2-W6).
   */
  async pushFile(
    path: string,
    baseSha256?: string,
    content?: string
  ): Promise<{ ok: boolean; conflict?: boolean; current_sha256?: string; server_content?: string }> {
    const baseUrl = this.getBaseUrl();
    const token = this.getAuthToken();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) {
      headers["X-Darjeeling-Token"] = token;
      headers["Authorization"] = `Bearer ${token}`;
    }

    try {
      // egress: host-sync
      const res = await requestUrl({
        url: `${baseUrl}/api/vault/push`,
        method: "POST",
        headers,
        body: JSON.stringify({ path, base_sha256: baseSha256, content: content ?? "" }),
        throw: false,
      });

      if (res.status === 200 || res.status === 201) {
        return { ok: true };
      }
      if (res.status === 409) {
        const body = res.json as { current_sha256?: string; server_content?: string };
        return {
          ok: false,
          conflict: true,
          current_sha256: body?.current_sha256,
          server_content: body?.server_content,
        };
      }
      return { ok: false };
    } catch (err) {
      console.error("[Darjeeling] pushFile failed:", err);
      return { ok: false };
    }
  }

  /**
   * Attaches to an active turn over the WebSocket channel.
   */
  attach(turnId: string, sinceSeq = 0): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(
        JSON.stringify({
          type: "attach",
          turn_id: turnId,
          since_seq: sinceSeq,
        })
      );
    }
  }

  /**
   * Queries /health and checks protocol version compatibility (Task 3).
   */
  async checkServerProtocol(): Promise<ProtocolCheckResult> {
    const baseUrl = this.getBaseUrl();
    try {
      // egress: host-http
      const res = await requestUrl({
        url: `${baseUrl}/health`,
        method: "GET",
        throw: false,
      });

      if (res.status >= 200 && res.status < 300) {
        return checkProtocolCompatibility(res.json as Record<string, unknown>);
      }
      return { ok: false, state: "unreachable", message: "Server /health endpoint returned error." };
    } catch (err) {
      return { ok: false, state: "unreachable", message: `Could not reach server: ${String(err)}` };
    }
  }

  // ----------------------------------------------------------------- send turn

  async sendTurn(options: TurnOptions): Promise<boolean> {
    const requested = options.agent || this.settings.agent;
    const mode = this.getEffectiveRuntimeMode();

    this.activeAgent = requested;
    this.activeCwd = options.cwd || "";

    // Clamp permission mode against agent capabilities
    const supportedModes = getAgentPermissionModes(requested);
    const requestedPerm = options.permission_mode ?? this.settings.permissionMode;
    const conversationId = options.resume ?? this.sessionId;

    if (requestedPerm === "bypassPermissions" && !isBypassConfirmedForConversation(conversationId)) {
      options.permission_mode = "plan";
    } else {
      options.permission_mode = clampToSupported(requestedPerm, supportedModes);
    }

    if (mode === "direct-api") {
      return await this.directApiRunner.sendTurn(options);
    }

    if (mode === "local") {
      const bin = getCachedLocalBinary(requested);
      if (!bin) {
        // Dead local -> remote fallback is completely removed (CORE-19, F-22, DOC-16).
        this.handlers.onError?.(
          `Local CLI "${requested}" not found or not executable. Please install it or switch runtime mode in Darjeeling Settings.`
        );
        return false;
      }
      return await this.localAgentRunner.sendTurn(options);
    }

    // Remote mode: ensure socket is connected and ready
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      if (
        !this.socket ||
        this.socket.readyState === WebSocket.CLOSED ||
        this.socket.readyState === WebSocket.CLOSING
      ) {
        this.connect();
      }
      const connected = await this.waitForSocketOpen(5000);
      if (!connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
        const errInfo = mapAc17Error(
          "unreachable",
          `Unable to connect to remote host at ${this.getBaseUrl()}. Daemon may be offline.`
        );
        this.handlers.onConnectionError?.(errInfo);
        this.handlers.onError?.(errInfo.message);
        return false;
      }
    }

    if (this.turnActive) {
      let waits = 0;
      while (this.turnActive && waits < 30) {
        await new Promise((r) => window.setTimeout(r, 50));
        waits++;
      }
      if (this.turnActive) {
        this.handlers.onError?.("A turn is already running. Stop it first.");
        return false;
      }
    }

    // Check device store continuity pointer if not explicit in options
    if (!options.resume && this.app && !options.is_plan_turn && !options.is_buffered_turn) {
      const savedPointer = getContinuityPointer(
        this.app,
        mode,
        this.settings.activeHostId,
        this.activeAgent,
        this.activeCwd
      );
      if (savedPointer) {
        options.resume = savedPointer;
      }
    }

    // Generate client_turn_id for idempotency and attach tracking (Task 6)
    const clientTurnId = `ct_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.currentClientTurnId = clientTurnId;
    this.lastSeq = 0;

    const frame: Record<string, unknown> = {
      type: "turn",
      client_turn_id: clientTurnId,
      ...options,
    };
    if (this.sessionId && !options.resume) frame.resume = this.sessionId;

    for (const key of ["model", "effort", "permission_mode", "fallback_model"]) {
      if (!frame[key]) delete frame[key];
    }

    try {
      this.turnActive = true;
      this.socket.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      this.turnActive = false;
      this.handlers.onError?.(`Failed to send turn: ${String(err)}`);
      return false;
    }
  }

  interrupt(): void {
    const mode = this.getEffectiveRuntimeMode();
    if (mode === "direct-api") {
      this.directApiRunner.interrupt();
    } else if (mode === "local") {
      this.localAgentRunner.interrupt();
    } else if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "interrupt" }));
    }
    this.turnActive = false;
  }
}

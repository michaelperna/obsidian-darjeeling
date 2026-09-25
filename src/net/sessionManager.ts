import { requestUrl, RequestUrlResponse, TFile, Vault } from "obsidian";
import type { DarjeelingSettings } from "../settings/schema";
import type { AgentDescriptor } from "./agentClient";
import type { HostStatus } from "../ui/host/hostTypes";

export interface SessionInfo {
  name: string;
  command: string;
  cwd: string;
  attached: boolean;
  windows: number;
  created: number;
}

export interface VaultStatus {
  path: string;
  exists: boolean;
  file_count: number;
  total_size_bytes: number;
}

/** A past agent conversation, read from the CLI's own session store. */
export interface ConversationSummary {
  sessionId: string;
  modified: number;
  sizeBytes: number;
  turns: number;
  model: string | null;
  toolCalls: number;
  firstMessage: string;
  lastMessage: string;
  title?: string;
  status?: "running" | "idle" | "error";
}

export interface ConversationMessage {
  role: "user" | "assistant";
  text: string;
  model?: string;
  tools?: string[];
  session_id?: string;
  content?: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    input?: Record<string, unknown>;
    output?: unknown;
    is_error?: boolean;
  }>;
}

export interface ArtifactEntry {
  path: string;
  size: number;
  modified: number;
}

export interface ChangedFile {
  path: string;
  modified: number;
}

/**
 * REST client for the Darjeeling host.
 *
 * The token travels in headers, never the query string -- v2 appended
 * `?token=` to every call, which wrote the credential into the host's uvicorn
 * access log on each request.
 */
export class SessionManager {
  private settings: DarjeelingSettings;
  public lastAuthError: string | null = null;

  constructor(
    settings: DarjeelingSettings,
    private getToken: () => string = () => ""
  ) {
    this.settings = settings;
  }

  updateSettings(settings: DarjeelingSettings): void {
    this.settings = settings;
  }

  public get base(): string {
    const activeHost = this.settings.hosts?.find((h) => h.id === this.settings.activeHostId);
    if (activeHost?.baseUrl) {
      return activeHost.baseUrl.replace(/\/$/, "");
    }
    const host = this.settings.meshnetHost || "127.0.0.1";
    const port = this.settings.port || 8765;
    return `http://${host}:${port}`;
  }

  private headers(withBody = false): Record<string, string> {
    const headers: Record<string, string> = {};
    const token = this.getToken();
    if (token) {
      headers["X-Darjeeling-Token"] = token;
      headers["Authorization"] = `Bearer ${token}`;
    }
    if (withBody) headers["Content-Type"] = "application/json";
    return headers;
  }

  private async call(
    path: string,
    init: { method?: string; body?: unknown; timeoutMs?: number } = {}
  ): Promise<RequestUrlResponse | null> {
    const method = init.method ?? "GET";
    const hasBody = init.body !== undefined;

    // Per-endpoint timeouts (default 10s, conversations 30s) (CORE-18, CHAT-26, CORE-39)
    const timeoutMs =
      init.timeoutMs ?? (path.includes("/api/agent/conversations") ? 30000 : 10000);

    let timer: number | null = null;
    const timeoutPromise = new Promise<null>((resolve) => {
      timer = window.setTimeout(() => resolve(null), timeoutMs);
    });

    try {
      // Raced promises caught! (CORE-18, CHAT-26, CORE-39)
      // egress: host-http
      const fetchPromise = requestUrl({
        url: `${this.base}${path}`,
        method,
        headers: this.headers(hasBody),
        body: hasBody ? JSON.stringify(init.body) : undefined,
        throw: false,
      }).catch((err) => {
        console.warn(`[Darjeeling] ${method} ${path} network error:`, err);
        return null;
      });

      const res = await Promise.race([fetchPromise, timeoutPromise]);
      if (res && res.status === 401) {
        this.lastAuthError = "Unauthorized (HTTP 401): invalid or missing auth token.";
      } else if (res && res.status >= 200 && res.status < 300) {
        this.lastAuthError = null;
      }
      return res;
    } catch (err) {
      console.error(`[Darjeeling] ${method} ${path} failed:`, err);
      return null;
    } finally {
      // Timers cleared in finally (CORE-18)
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    }
  }

  private ok(res: RequestUrlResponse | null): boolean {
    return !!res && res.status >= 200 && res.status < 300;
  }

  /** Human-readable reason a call failed, for surfacing in the UI. */
  public reason(res: RequestUrlResponse | null): string {
    if (!res) return "host unreachable";
    if (res.status === 401) return "unauthorized — check the auth token";
    if (res.status === 503) return "not available on the host";
    try {
      const detail = (res.json as { detail?: string })?.detail;
      if (detail) return detail;
    } catch {
      /* not JSON */
    }
    return `HTTP ${res.status}`;
  }

  // ------------------------------------------------------------ meta

  async health(): Promise<Record<string, unknown> | null> {
    const res = await this.call("/health", { timeoutMs: 5000 });
    return this.ok(res) ? (res!.json as Record<string, unknown>) : null;
  }

  /**
   * What the host can actually run. Drives the model controls, and stops the
   * UI offering an agent whose binary isn't installed.
   */
  async listAgents(): Promise<AgentDescriptor[]> {
    const res = await this.call("/api/agents");
    if (!this.ok(res)) return [];
    return ((res!.json as { agents?: AgentDescriptor[] }).agents ?? []).map((a) => ({
      ...a,
      models: a.models ?? [],
      efforts: a.efforts ?? [],
      permissionModes: a.permissionModes ?? [],
    }));
  }

  // ---------------------------------------------------------------- host

  async hostStatus(): Promise<HostStatus | null> {
    const res = await this.call("/api/host/status");
    return this.ok(res) ? (res!.json as HostStatus) : null;
  }

  /** Cap how full the battery charges. The real lever on a mains-tethered laptop. */
  async setChargeThreshold(end: number, start?: number): Promise<boolean> {
    return this.ok(
      await this.call("/api/host/battery/threshold", {
        method: "POST",
        body: { end, start },
      })
    );
  }

  // -------------------------------------------------------- tmux sessions

  async listSessions(): Promise<SessionInfo[]> {
    const res = await this.call("/api/sessions");
    if (!this.ok(res)) return [];
    return (res!.json as { sessions?: SessionInfo[] }).sessions ?? [];
  }

  async createSession(
    name: string,
    agent = "bash",
    cwd?: string
  ): Promise<{ ok: boolean; name?: string; error?: string }> {
    const res = await this.call("/api/sessions", {
      method: "POST",
      body: { name, agent, cwd },
    });
    if (this.ok(res)) {
      const returnedName = (res?.json as { name?: string })?.name ?? name;
      return { ok: true, name: returnedName };
    }
    return { ok: false, error: this.reason(res) };
  }

  async deleteSession(name: string): Promise<boolean> {
    return this.ok(
      await this.call(`/api/sessions/${encodeURIComponent(name)}`, { method: "DELETE" })
    );
  }

  async sendInputToSession(name: string, text: string, pressEnter = true): Promise<boolean> {
    return this.ok(
      await this.call(`/api/sessions/${encodeURIComponent(name)}/send`, {
        method: "POST",
        body: { text, press_enter: pressEnter },
      })
    );
  }

  // --------------------------------------------------------------- vault

  async getVaultStatus(): Promise<VaultStatus | null> {
    const res = await this.call("/api/vault/status");
    return this.ok(res) ? (res!.json as VaultStatus) : null;
  }

  async pushFile(file: TFile, vault: Vault): Promise<boolean> {
    const content = await vault.read(file);
    // Timeout scaled by size: at least 10s, + 1s per 100KB (CORE-18)
    const timeoutMs = Math.max(10000, 10000 + Math.floor(content.length / 100000) * 1000);
    return this.ok(
      await this.call("/api/vault/sync/file", {
        method: "POST",
        body: { path: file.path, content },
        timeoutMs,
      })
    );
  }

  /** Read a file back off the host. The reverse direction v2 never had. */
  async pullFile(path: string): Promise<string | null> {
    const res = await this.call(`/api/vault/file?path=${encodeURIComponent(path)}`);
    if (!this.ok(res)) return null;
    return (res!.json as { content?: string }).content ?? null;
  }

  async changedSince(since: number): Promise<ChangedFile[]> {
    const res = await this.call(`/api/vault/changed?since=${Math.floor(since)}`);
    if (!this.ok(res)) return [];
    return (res!.json as { changed?: ChangedFile[] }).changed ?? [];
  }

  /**
   * Past conversations for a working directory.
   *
   * The agent CLI persists every session itself, so this is authoritative even
   * when the plugin has lost its own pointer to one.
   */
  async listConversations(cwd?: string, minTurns = 1): Promise<ConversationSummary[]> {
    const params = new URLSearchParams({ limit: "40", min_turns: String(minTurns) });
    if (cwd) params.set("cwd", cwd);
    const res = await this.call(`/api/agent/conversations?${params.toString()}`, {
      timeoutMs: 30000,
    });
    if (!this.ok(res)) return [];
    return (res!.json as { conversations?: ConversationSummary[] }).conversations ?? [];
  }

  async readConversation(sessionId: string, cwd?: string): Promise<ConversationMessage[]> {
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);
    const res = await this.call(
      `/api/agent/conversations/${encodeURIComponent(sessionId)}?${params.toString()}`,
      { timeoutMs: 30000 }
    );
    if (!this.ok(res)) return [];
    return (res!.json as { messages?: ConversationMessage[] }).messages ?? [];
  }

  async listRunningTurns(): Promise<Array<{ id: string; session_id: string; state: string }>> {
    const res = await this.call("/api/turns?state=running");
    if (!this.ok(res)) return [];
    return (res!.json as { turns?: Array<{ id: string; session_id: string; state: string }> }).turns ?? [];
  }

  // ----------------------------------------------------------- artifacts

  async listArtifacts(): Promise<ArtifactEntry[]> {
    const res = await this.call("/api/artifacts");
    if (!this.ok(res)) return [];
    return (res!.json as { artifacts?: ArtifactEntry[] }).artifacts ?? [];
  }

  async readArtifact(path: string): Promise<string | null> {
    const res = await this.call(`/api/artifacts/read?path=${encodeURIComponent(path)}`);
    if (!this.ok(res)) return null;
    return (res!.json as { content?: string }).content ?? null;
  }

  async writeArtifact(path: string, content: string): Promise<boolean> {
    return this.ok(
      await this.call("/api/artifacts/write", { method: "POST", body: { path, content } })
    );
  }
}

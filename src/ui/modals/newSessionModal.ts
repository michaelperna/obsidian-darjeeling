import { App, Modal, Notice, Platform, Setting, setIcon, requestUrl } from "obsidian";
import type DarjeelingPlugin from "../../main";
import {
  DirectApiProvider,
  RemoteHostConfig,
  RuntimeMode,
} from "../../settings/schema";
import {
  getModelForHarness,
  setModelForHarness,
  sanitizeModelForHarness,
} from "../../models/registry";
import { detectLocalBinary } from "../../runtime/localAgentRunner";
import { setDeviceRuntime } from "../../runtime/router";
import { getTeaLeafBranchSvg } from "../illustrations";
import { verifyHostAuthentication } from "../../net/pairing";
import { openDarjeelingSettings } from "../../settings/openSettings";

export interface SessionTarget {
  mode: RuntimeMode;
  agent?: string;
  model?: string;
  provider?: DirectApiProvider;
  meshnetHost?: string;
  port?: number;
}

/**
 * Darjeeling New Session Modal
 *
 * Implements a high-craft, Mobbin/Linear-standard host selection and configuration flow.
 * Decouples the 3 top-level host selector cards from the active configuration panel,
 * ensuring only the selected host's settings are visible, responsive, and clear.
 * Free of accidental focus-trap hijacks. Staged edits until submit (CORE-28, CORE-39).
 */
export class DarjeelingNewSessionModal extends Modal {
  private selectedMode: RuntimeMode;
  private askHostOnNewSession: boolean;

  // Local state
  private localAgent: string;
  private localModel: string;

  // Remote state
  private remoteHost: string;
  private remotePort: number;
  private remoteAgent: string;
  private remoteModel: string;
  private selectedRemoteHostId: string = "";
  private remoteAgentsList: Array<{ id: string; name: string; available?: boolean }> = [];

  // Direct API state
  private apiProvider: DirectApiProvider;
  private apiModel: string;

  // UI elements
  private selectorCards: Map<RuntimeMode, HTMLElement> = new Map();
  private radioDots: Map<RuntimeMode, HTMLElement> = new Map();
  private configSectionEl: HTMLElement | null = null;
  private reachabilityChip: HTMLElement | null = null;
  private isTestingConnection = false;
  private isSubmitting = false;
  private isClosed = false;

  constructor(
    app: App,
    private plugin: DarjeelingPlugin,
    private onSelect: (target: SessionTarget) => void
  ) {
    super(app);
    const settings = this.plugin.settings;

    // Detect initial mode safely
    if (Platform.isDesktop) {
      this.selectedMode = settings.runtimeMode;
    } else {
      // Mobile: never default to local
      this.selectedMode =
        settings.runtimeMode === "local"
          ? settings.meshnetHost
            ? "remote"
            : "direct-api"
          : settings.runtimeMode;
    }

    this.askHostOnNewSession = settings.askHostOnNewSession ?? true;

    this.localAgent = settings.agent || "agy";
    this.localModel = getModelForHarness(settings, this.localAgent);

    this.remoteHost = settings.meshnetHost || "";
    this.remotePort = settings.port || 8765;
    this.remoteAgent = settings.agent || "agy";
    this.remoteModel = getModelForHarness(settings, this.remoteAgent);
    this.selectedRemoteHostId = settings.activeRemoteHostId || "";
    if (this.plugin.availableAgents?.length) {
      this.remoteAgentsList = this.plugin.availableAgents.map((a) => ({
        id: a.key,
        name: a.label,
        available: a.available,
      }));
    }

    this.apiProvider = settings.directApiProvider || "deepseek";
    this.apiModel = getModelForHarness(settings, this.apiProvider);
  }

  onOpen(): void {
    this.modalEl.addClass("dj-session-modal-window");

    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("darjeeling-root", "dj-session-modal");

    // 1. Header with botanical tea leaf emblem
    const header = contentEl.createDiv({ cls: "dj-session-modal-header" });
    
    const badgeRow = header.createDiv({ cls: "dj-session-badge-row" });
    const badge = badgeRow.createDiv({ cls: "dj-session-badge" });
    const badgeEmblem = badge.createSpan({ cls: "dj-session-badge-emblem" });
    if (typeof DOMParser !== "undefined") {
      const emblemSvg = new DOMParser().parseFromString(getTeaLeafBranchSvg(14), "image/svg+xml").documentElement;
      if (emblemSvg) badgeEmblem.appendChild(emblemSvg);
    }
    badge.createSpan({ text: "Darjeeling Session" });

    header.createEl("h2", { cls: "dj-session-title", text: "Start New Session" });
    header.createEl("p", {
      cls: "dj-session-sub",
      text: "Select your execution host and environment for this conversation:",
    });

    // Scrollable modal body
    const body = contentEl.createDiv({ cls: "dj-session-modal-body" });

    // Mobile info hint
    if (!Platform.isDesktop) {
      const mobNotice = body.createDiv({ cls: "dj-session-mobile-hint" });
      const mobIcon = mobNotice.createSpan({ cls: "dj-notice-icon" });
      setIcon(mobIcon, "smartphone");
      mobNotice.createSpan({
        text: "Obsidian Mobile: Local CLI is desktop-only. Running via Remote Host or Direct API.",
      });
    }

    // 2. Top Segmented Host Cards (3-column selection grid)
    const modeGrid = body.createDiv({ cls: "dj-session-mode-grid" });

    if (Platform.isDesktop) {
      this.buildSelectorCard(
        modeGrid,
        "local",
        "laptop",
        "Local Machine",
        "Zero Latency • Local Vault",
        "Run CLI agent directly on your workstation with native file access."
      );
    }

    this.buildSelectorCard(
      modeGrid,
      "remote",
      "server",
      "Remote Host",
      "Workstation / Meshnet",
      "Connect to headless Darjeeling daemon over Meshnet or Tailscale."
    );

    this.buildSelectorCard(
      modeGrid,
      "direct-api",
      "zap",
      "Direct API",
      "Zero Setup • Mobile/Cloud",
      "Direct native HTTPS calls to Gemini, Claude, DeepSeek, or Ollama."
    );

    // 3. Dedicated Active Host Configuration Section (ONLY active host options render here)
    this.configSectionEl = body.createDiv({ cls: "dj-session-config-section" });
    this.renderConfigSection();

    // 4. Footer with toggle & actions (pinned at bottom)
    const footer = contentEl.createDiv({ cls: "dj-session-footer" });

    const toggleWrap = footer.createDiv({ cls: "dj-session-toggle-wrap" });
    const toggleLabel = toggleWrap.createEl("label", { cls: "dj-session-checkbox-label" });
    const toggleInput = toggleLabel.createEl("input", { type: "checkbox" });
    toggleInput.checked = this.askHostOnNewSession;
    toggleInput.addEventListener("change", () => {
      this.askHostOnNewSession = toggleInput.checked;
    });
    toggleLabel.createSpan({ text: "Ask host every new session" });

    footer.createDiv({ cls: "dj-spacer" });

    const cancelBtn = footer.createEl("button", {
      cls: "dj-btn",
      text: "Cancel",
    });
    cancelBtn.addEventListener("click", () => this.close());

    const startBtn = footer.createEl("button", {
      cls: "dj-btn dj-btn-accent mod-cta dj-session-start-btn",
    });
    const startIcon = startBtn.createSpan({ cls: "dj-btn-icon-prefix" });
    setIcon(startIcon, "play");
    startBtn.createSpan({ text: "Start Session" });
    startBtn.addEventListener("click", () => {
      void this.submit();
    });

    // Enter key scoped to inputs and primary button per DM-27
    contentEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        const target = evt.target as HTMLElement | null;
        if (
          target instanceof HTMLInputElement ||
          target === startBtn ||
          (target && target.classList.contains("dj-btn-accent"))
        ) {
          evt.preventDefault();
          void this.submit();
        }
      }
    });
  }

  /**
   * Builds one of the 3 top-level host selector cards.
   * Note: strictly click/key selection without focusin listeners to prevent focus trap race conditions.
   */
  private buildSelectorCard(
    parent: HTMLElement,
    mode: RuntimeMode,
    iconName: string,
    title: string,
    badgeText: string,
    descText: string
  ): void {
    const isSelected = this.selectedMode === mode;
    const card = parent.createDiv({
      cls: `dj-session-card ${isSelected ? "is-selected" : ""}`,
    });
    this.selectorCards.set(mode, card);

    const head = card.createDiv({ cls: "dj-session-card-head" });
    const radio = head.createDiv({ cls: "dj-session-radio" });
    const radioDot = radio.createSpan({
      cls: `dj-session-radio-dot ${isSelected ? "is-active" : ""}`,
    });
    this.radioDots.set(mode, radioDot);

    const titleGroup = head.createDiv({ cls: "dj-session-card-title-group" });
    const topRow = titleGroup.createDiv({ cls: "dj-session-card-top-row" });
    const cardTitle = topRow.createDiv({ cls: "dj-card-title-wrap" });
    const cardIcon = cardTitle.createSpan({ cls: "dj-card-icon" });
    setIcon(cardIcon, iconName);
    cardTitle.createEl("h3", { text: title });
    topRow.createSpan({ cls: "dj-session-pill", text: badgeText });

    titleGroup.createEl("p", {
      cls: "dj-session-card-desc",
      text: descText,
    });

    // Clicking explicitly sets mode and re-mounts the config panel
    card.addEventListener("click", () => {
      if (this.selectedMode !== mode) {
        this.selectMode(mode);
      }
    });
  }

  private selectMode(mode: RuntimeMode): void {
    this.selectedMode = mode;

    // Update cards visual state
    for (const [m, c] of this.selectorCards) {
      c.toggleClass("is-selected", m === mode);
    }
    for (const [m, r] of this.radioDots) {
      r.toggleClass("is-active", m === mode);
    }

    // Re-render configuration section for only this mode
    this.renderConfigSection();
  }

  /**
   * Dynamically renders ONLY the active host's configuration controls.
   * Completely eliminates clutter from showing all 3 hosts simultaneously.
   */
  private renderConfigSection(): void {
    if (!this.configSectionEl) return;
    this.configSectionEl.empty();

    const secHeader = this.configSectionEl.createDiv({ cls: "dj-config-section-header" });
    const headerTitle = secHeader.createDiv({ cls: "dj-config-section-title" });
    const headerIcon = headerTitle.createSpan({ cls: "dj-config-header-icon" });

    if (this.selectedMode === "local") {
      setIcon(headerIcon, "laptop");
      headerTitle.createSpan({ text: "Local Machine Configuration" });
      this.renderLocalConfig(this.configSectionEl);
    } else if (this.selectedMode === "remote") {
      setIcon(headerIcon, "server");
      headerTitle.createSpan({ text: "Remote Host Configuration" });
      this.renderRemoteConfig(this.configSectionEl);
    } else if (this.selectedMode === "direct-api") {
      setIcon(headerIcon, "zap");
      headerTitle.createSpan({ text: "Direct Provider API Configuration" });
      this.renderDirectApiConfig(this.configSectionEl);
    }
  }

  private renderLocalConfig(container: HTMLElement): void {
    const formRow = container.createDiv({ cls: "dj-session-opt-row" });

    // Agent selector
    const agentWrap = formRow.createDiv({ cls: "dj-session-opt-item" });
    agentWrap.createEl("label", { text: "Agent CLI:" });
    const agentSelect = agentWrap.createEl("select", { cls: "dj-select" });
    agentSelect.createEl("option", { value: "claude", text: "Claude Code (claude)" });
    agentSelect.createEl("option", { value: "agy", text: "Antigravity CLI (agy)" });
    agentSelect.value = this.localAgent === "agy" ? "agy" : "claude";

    // Model selector
    const modelWrap = formRow.createDiv({ cls: "dj-session-opt-item flex-grow" });
    modelWrap.createEl("label", { text: "Model Override:" });
    const modelSelect = modelWrap.createEl("select", { cls: "dj-select" });
    this.paintLocalModels(modelSelect);
    modelSelect.value = this.localModel;

    // Status pill for detected binary
    const statusWrap = container.createDiv({ cls: "dj-binary-status-row" });
    const updateBinaryStatus = () => {
      statusWrap.empty();
      const detected = detectLocalBinary(this.localAgent);
      const chip = statusWrap.createSpan({
        cls: `dj-status-badge ${detected ? "is-available" : "is-missing"}`,
      });
      const iconSpan = chip.createSpan({ cls: "dj-badge-icon" });
      if (detected) {
        setIcon(iconSpan, "check-circle");
        chip.createSpan({ text: `CLI Ready: ${detected}` });
      } else {
        setIcon(iconSpan, "alert-circle");
        chip.createSpan({
          text: `"${this.localAgent}" not found in PATH. Install via terminal or select Direct API.`,
        });
      }
    };
    updateBinaryStatus();

    agentSelect.addEventListener("change", () => {
      this.localAgent = agentSelect.value;
      this.localModel = getModelForHarness(this.plugin.settings, this.localAgent);
      this.paintLocalModels(modelSelect);
      updateBinaryStatus();
    });

    modelSelect.addEventListener("change", () => {
      this.localModel = modelSelect.value;
    });
  }

  private paintRemoteAgents(selectEl: HTMLSelectElement): void {
    selectEl.empty();
    if (this.remoteAgentsList.length > 0) {
      for (const a of this.remoteAgentsList) {
        selectEl.createEl("option", {
          value: a.id,
          text: `${a.name || a.id} (${a.id})${a.available === false ? " - not installed" : ""}`,
        });
      }
      if (!this.remoteAgentsList.some((a) => a.id === this.remoteAgent)) {
        this.remoteAgent = this.remoteAgentsList[0]?.id || "claude";
      }
    } else {
      selectEl.createEl("option", { value: "claude", text: "Claude Code (claude)" });
      selectEl.createEl("option", { value: "agy", text: "Antigravity (agy)" });
      selectEl.createEl("option", { value: "deepseek", text: "DeepSeek (deepseek)" });
    }
  }

  private async getAuthTokenForRemoteHost(): Promise<string> {
    const targetUrl = `http://${this.remoteHost}:${this.remotePort}`;
    const targetUrlHttps = `https://${this.remoteHost}:${this.remotePort}`;

    const hosts = this.plugin.settings.hosts ?? [];
    const matchedHost = hosts.find(
      (h) => h.baseUrl === targetUrl || h.baseUrl === targetUrlHttps
    );

    if (matchedHost?.tokenSecretId) {
      try {
        const sec = await this.plugin.secretStorage.getSecret(matchedHost.tokenSecretId);
        if (sec) return sec;
      } catch {
        /* ignore */
      }
    }

    if (this.plugin.settings.activeHostId) {
      const active = hosts.find((h) => h.id === this.plugin.settings.activeHostId);
      if (active?.tokenSecretId) {
        try {
          const sec = await this.plugin.secretStorage.getSecret(active.tokenSecretId);
          if (sec) return sec;
        } catch {
          /* ignore */
        }
      }
    }

    const remoteHosts = this.plugin.settings.remoteHosts ?? [];
    const matchedRemoteHost = remoteHosts.find(
      (h) => h.host === this.remoteHost && h.port === this.remotePort
    );
    if (matchedRemoteHost?.tokenSecretId) {
      try {
        const sec = await this.plugin.secretStorage.getSecret(matchedRemoteHost.tokenSecretId);
        if (sec) return sec;
      } catch {
        /* ignore */
      }
    }
    if (matchedRemoteHost?.authToken) {
      return matchedRemoteHost.authToken;
    }

    return this.plugin.settings.authToken || "";
  }

  private renderRemoteConfig(container: HTMLElement): void {
    const formRow = container.createDiv({ cls: "dj-session-opt-row" });

    // Host IP / Hostname
    const hostWrap = formRow.createDiv({ cls: "dj-session-opt-item flex-grow" });
    hostWrap.createEl("label", { text: "Host Address / IP:" });
    const hostInput = hostWrap.createEl("input", {
      cls: "dj-input dj-input-compact",
      type: "text",
      value: this.remoteHost,
      placeholder: "100.x.y.z",
    });
    hostInput.addEventListener("input", () => {
      this.remoteHost = hostInput.value.trim();
    });

    // Port
    const portWrap = formRow.createDiv({ cls: "dj-session-opt-item" });
    portWrap.createEl("label", { text: "Port:" });
    const portInput = portWrap.createEl("input", {
      cls: "dj-input dj-input-compact dj-input-num",
      type: "number",
      value: String(this.remotePort),
    });
    portInput.addEventListener("input", () => {
      this.remotePort = parseInt(portInput.value, 10) || 8765;
    });

    // Remote Agent
    const agentWrap = formRow.createDiv({ cls: "dj-session-opt-item" });
    agentWrap.createEl("label", { text: "Remote Agent:" });
    const agentSelect = agentWrap.createEl("select", { cls: "dj-select" });
    this.paintRemoteAgents(agentSelect);
    agentSelect.value = this.remoteAgent;
    agentSelect.addEventListener("change", () => {
      this.remoteAgent = agentSelect.value;
      this.remoteModel = getModelForHarness(this.plugin.settings, this.remoteAgent);
    });

    // Saved hosts picker if user has defined multiple
    const savedHosts = this.plugin.settings.remoteHosts ?? [];
    if (savedHosts.length > 1) {
      const presetRow = container.createDiv({ cls: "dj-session-opt-row" });
      const presetWrap = presetRow.createDiv({ cls: "dj-session-opt-item flex-grow" });
      presetWrap.createEl("label", { text: "Saved Host Preset:" });
      const presetSelect = presetWrap.createEl("select", { cls: "dj-select" });
      for (const h of savedHosts) {
        presetSelect.createEl("option", { value: h.id, text: `${h.name} (${h.host}:${h.port})` });
      }
      if (this.selectedRemoteHostId) {
        presetSelect.value = this.selectedRemoteHostId;
      }
      presetSelect.addEventListener("change", () => {
        const found = savedHosts.find((h) => h.id === presetSelect.value);
        if (found) {
          hostInput.value = found.host;
          this.remoteHost = found.host;
          portInput.value = String(found.port);
          this.remotePort = found.port;
          this.selectedRemoteHostId = found.id;
        }
      });
    }

    // Live Reachability Test & Diagnostic Bar
    const testBar = container.createDiv({ cls: "dj-remote-test-bar" });
    const testBtn = testBar.createEl("button", {
      cls: "dj-btn dj-btn-sm dj-test-btn",
    });
    const testIcon = testBtn.createSpan({ cls: "dj-btn-icon-prefix" });
    setIcon(testIcon, "refresh-cw");
    testBtn.createSpan({ text: "Test Connection" });

    this.reachabilityChip = testBar.createDiv({ cls: "dj-reachability-chip" });
    testBtn.addEventListener("click", () => {
      void this.testRemoteReachability(agentSelect);
    });
  }

  /**
   * Pings the remote host and tests authentication (F-17, CORE-28).
   * Dynamically populates agents from /api/agents.
   */
  private async testRemoteReachability(agentSelectEl?: HTMLSelectElement): Promise<boolean> {
    if (this.isClosed || this.isTestingConnection || !this.reachabilityChip) return false;
    this.isTestingConnection = true;

    this.reachabilityChip.empty();
    const testSpan = this.reachabilityChip.createSpan({ cls: "dj-status-badge is-testing" });
    const testIcon = testSpan.createSpan({ cls: "dj-badge-icon is-spinning" });
    setIcon(testIcon, "refresh-cw");
    testSpan.createSpan({ text: `Testing http://${this.remoteHost}:${this.remotePort}...` });

    try {
      const baseUrl = `http://${this.remoteHost}:${this.remotePort}`;
      const token = await this.getAuthTokenForRemoteHost();

      if (token) {
        const authRes = await verifyHostAuthentication(baseUrl, token);
        if (this.isClosed || !this.reachabilityChip) {
          this.isTestingConnection = false;
          return false;
        }

        if (authRes.ok) {
          this.reachabilityChip.empty();
          const okSpan = this.reachabilityChip.createSpan({ cls: "dj-status-badge is-available" });
          const okIcon = okSpan.createSpan({ cls: "dj-badge-icon" });
          setIcon(okIcon, "check-circle");
          okSpan.createSpan({ text: "Connected: Darjeeling Server Online" });

          if (authRes.agents && authRes.agents.length > 0) {
            this.remoteAgentsList = authRes.agents.map((a) => ({
              id: a.key,
              name: a.label,
              available: a.available,
            }));
            this.plugin.availableAgents = authRes.agents;
            if (agentSelectEl) {
              this.paintRemoteAgents(agentSelectEl);
              agentSelectEl.value = this.remoteAgent;
            }
          }
          this.isTestingConnection = false;
          return true;
        } else {
          this.reachabilityChip.empty();
          const errSpan = this.reachabilityChip.createSpan({ cls: "dj-status-badge is-missing" });
          const errIcon = errSpan.createSpan({ cls: "dj-badge-icon" });
          setIcon(errIcon, "alert-circle");
          errSpan.createSpan({
            text: authRes.error || "Authentication failed (token rejected)",
          });
          this.isTestingConnection = false;
          return false;
        }
      }

      // No token found: probe /health to check reachability without faking "Connected"
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Connection timed out (2.5s)")), 2500)
      );
      // egress: host-http
      const healthPromise = requestUrl({
        url: `${baseUrl}/health`,
        method: "GET",
      });
      const res = await Promise.race([healthPromise, timeoutPromise]);

      if (this.isClosed || !this.reachabilityChip) {
        this.isTestingConnection = false;
        return false;
      }

      if (res && res.status === 200) {
        this.reachabilityChip.empty();
        const unauthSpan = this.reachabilityChip.createSpan({ cls: "dj-status-badge is-testing" });
        const unauthIcon = unauthSpan.createSpan({ cls: "dj-badge-icon" });
        setIcon(unauthIcon, "alert-circle");
        unauthSpan.createSpan({ text: "Reachable (unauthenticated: host not paired)" });
        this.isTestingConnection = false;
        return true;
      }
    } catch {
      if (this.isClosed || !this.reachabilityChip) {
        this.isTestingConnection = false;
        return false;
      }
      this.reachabilityChip.empty();
      const errWrap = this.reachabilityChip.createDiv({ cls: "dj-remote-err-wrap" });

      const errSpan = errWrap.createSpan({ cls: "dj-status-badge is-missing" });
      const errIcon = errSpan.createSpan({ cls: "dj-badge-icon" });
      setIcon(errIcon, "alert-circle");
      errSpan.createSpan({ text: `Host Unreachable (${this.remoteHost}:${this.remotePort})` });

      const hintText = errWrap.createDiv({ cls: "dj-remote-hint-text" });
      hintText.setText(
        "Make sure the host is powered on, NordVPN Meshnet is connected, and server.py is running."
      );

      const switchBtn = errWrap.createEl("button", {
        cls: "dj-btn dj-btn-xs dj-btn-accent",
        text: "Switch to Direct API instead",
      });
      switchBtn.addEventListener("click", () => {
        this.selectMode("direct-api");
      });
    }

    this.isTestingConnection = false;
    return false;
  }

  private renderDirectApiConfig(container: HTMLElement): void {
    const formRow = container.createDiv({ cls: "dj-session-opt-row" });

    // Provider dropdown
    const provWrap = formRow.createDiv({ cls: "dj-session-opt-item" });
    provWrap.createEl("label", { text: "Provider:" });
    const provSelect = provWrap.createEl("select", { cls: "dj-select" });
    provSelect.createEl("option", { value: "gemini", text: "Google Gemini (Recommended)" });
    provSelect.createEl("option", { value: "deepseek", text: "DeepSeek (Official API)" });
    provSelect.createEl("option", { value: "anthropic", text: "Anthropic Claude" });
    provSelect.createEl("option", {
      value: "openai-compatible",
      text: "Custom / OpenAI-compatible",
    });
    provSelect.createEl("option", { value: "ollama", text: "Ollama (Local Private AI)" });
    provSelect.value = this.apiProvider;

    // Model input
    const modelWrap = formRow.createDiv({ cls: "dj-session-opt-item flex-grow" });
    modelWrap.createEl("label", { text: "Model ID:" });
    const modelInput = modelWrap.createEl("input", {
      cls: "dj-input dj-input-compact",
      type: "text",
      value: this.apiModel,
      placeholder: "e.g. gemini-3.8-flash, deepseek-chat, claude-opus-5",
    });
    modelInput.addEventListener("input", () => {
      this.apiModel = modelInput.value.trim();
    });

    // API Key status row
    const keyRow = container.createDiv({ cls: "dj-binary-status-row" });
    const updateKeyStatus = () => {
      keyRow.empty();
      let hasKey = false;
      let label = "";

      if (this.apiProvider === "gemini") {
        hasKey = Boolean(this.plugin.settings.geminiApiKey);
        label = hasKey ? "Gemini API key configured" : "Gemini API key missing";
      } else if (this.apiProvider === "deepseek") {
        hasKey = Boolean(this.plugin.settings.deepseekApiKey);
        label = hasKey ? "DeepSeek API key configured" : "DeepSeek API key missing";
      } else if (this.apiProvider === "anthropic") {
        hasKey = Boolean(this.plugin.settings.anthropicApiKey);
        label = hasKey ? "Anthropic API key configured" : "Anthropic API key missing";
      } else if (this.apiProvider === "openai-compatible") {
        hasKey = Boolean(this.plugin.settings.openaiApiKey);
        label = hasKey ? "OpenAI API key configured" : "Keyless / Local server (Key optional)";
      } else if (this.apiProvider === "ollama") {
        hasKey = true;
        label = "Ollama Local API (No key required)";
      }

      const chip = keyRow.createSpan({
        cls: `dj-status-badge ${hasKey ? "is-available" : "is-missing"}`,
      });
      const iconSpan = chip.createSpan({ cls: "dj-badge-icon" });
      setIcon(iconSpan, hasKey ? "check-circle" : "alert-circle");
      chip.createSpan({ text: label });

      if (!hasKey) {
        const setLink = keyRow.createEl("button", {
          cls: "dj-btn dj-btn-xs",
          text: "Open settings",
        });
        setLink.addEventListener("click", () => {
          this.close();
          openDarjeelingSettings(this.app);
        });
      }
    };
    updateKeyStatus();

    provSelect.addEventListener("change", () => {
      this.apiProvider = provSelect.value as DirectApiProvider;
      this.paintApiModels(modelInput);
      updateKeyStatus();
    });
  }

  private paintLocalModels(selectEl: HTMLSelectElement): void {
    selectEl.empty();
    if (this.localAgent === "agy") {
      selectEl.createEl("option", { value: "gemini-3.8-flash-high", text: "Gemini 3.8 Flash (High Reasoning)" });
      selectEl.createEl("option", { value: "gemini-3.8-flash-medium", text: "Gemini 3.8 Flash (Medium Reasoning)" });
      selectEl.createEl("option", { value: "gemini-3.8-flash-low", text: "Gemini 3.8 Flash (Low Reasoning)" });
      this.localModel = sanitizeModelForHarness("agy", this.localModel);
    } else {
      selectEl.createEl("option", { value: "claude-opus-5", text: "Opus 5" });
      selectEl.createEl("option", { value: "claude-sonnet-5", text: "Sonnet 5" });
      selectEl.createEl("option", { value: "claude-haiku-4-5-20251001", text: "Haiku 4.5" });
      this.localModel = sanitizeModelForHarness("claude", this.localModel);
    }
    selectEl.value = this.localModel;
  }

  private paintApiModels(inputEl: HTMLInputElement): void {
    const model = getModelForHarness(this.plugin.settings, this.apiProvider);
    inputEl.value = model;
    this.apiModel = model;
  }

  private async submit(): Promise<void> {
    if (this.isSubmitting || this.isClosed) return;
    this.isSubmitting = true;

    const target: SessionTarget = {
      mode: this.selectedMode,
    };

    if (this.selectedMode === "local") {
      target.agent = this.localAgent;
      const validModel = sanitizeModelForHarness(this.localAgent, this.localModel);
      target.model = validModel;
      this.plugin.settings.agent = this.localAgent;
      this.plugin.settings.model = validModel;
      setModelForHarness(this.plugin.settings, this.localAgent, validModel);
    } else if (this.selectedMode === "remote") {
      target.meshnetHost = this.remoteHost;
      target.port = this.remotePort;
      target.agent = this.remoteAgent;
      const validModel = sanitizeModelForHarness(this.remoteAgent, this.remoteModel);
      target.model = validModel;
      this.plugin.settings.meshnetHost = this.remoteHost;
      this.plugin.settings.port = this.remotePort;
      this.plugin.settings.agent = this.remoteAgent;
      this.plugin.settings.model = validModel;
      setModelForHarness(this.plugin.settings, this.remoteAgent, validModel);
      if (this.selectedRemoteHostId) {
        this.plugin.settings.activeRemoteHostId = this.selectedRemoteHostId;
      }
    } else if (this.selectedMode === "direct-api") {
      target.provider = this.apiProvider;
      const validModel = sanitizeModelForHarness(this.apiProvider, this.apiModel);
      target.model = validModel;
      this.plugin.settings.directApiProvider = this.apiProvider;
      this.plugin.settings.model = validModel;
      setModelForHarness(this.plugin.settings, this.apiProvider, validModel);
      if (this.apiProvider === "deepseek" || this.apiProvider === "openai-compatible") {
        this.plugin.settings.openaiModel = validModel;
        if (this.apiProvider === "deepseek" && !this.plugin.settings.openaiBaseUrl) {
          this.plugin.settings.openaiBaseUrl = "https://api.deepseek.com";
        }
      }
    }

    // Persist explicitly so subsequent sessions retain the selected mode
    setDeviceRuntime(this.app, this.plugin.settings, this.selectedMode);
    this.plugin.settings.askHostOnNewSession = this.askHostOnNewSession;
    await this.plugin.saveSettings();

    this.close();
    this.onSelect(target);
  }

  onClose(): void {
    this.isClosed = true;
    const { contentEl } = this;
    contentEl.empty();
  }
}

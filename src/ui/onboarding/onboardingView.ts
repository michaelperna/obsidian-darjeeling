import { Notice, Platform, setIcon } from "obsidian";
import type DarjeelingPlugin from "../../main";
import { getTeaLeafBranchSvg } from "../illustrations";
import { pairDevice, requestPairCode, validateServerUrl, type PairDeviceResult } from "../../net/pairing";
import type { HostConfig } from "../../settings/schema";
import { hostSecretId, pairingHostId } from "../../settings/secrets";

export type OnboardingStep =
  | "s0_welcome"
  | "s1_server"
  | "s2_pair"
  | "s2b_confirm"
  | "s3_checking"
  | "s4_done"
  | "pair_this_device";

export interface CheckingProgress {
  reachable: boolean | null;
  codeAccepted: boolean | null;
  agentsFound: boolean | null;
  loggedIn: boolean | null;
  vaultNotesCounted: number | null;
  error?: string;
}

export class DarjeelingOnboardingView {
  public containerEl: HTMLElement;
  private currentStep: OnboardingStep = "s0_welcome";
  private pairUrl = "";
  private pairCode = "";
  private pendingHostUrl = "";
  private checkingProgress: CheckingProgress = {
    reachable: null,
    codeAccepted: null,
    agentsFound: null,
    loggedIn: null,
    vaultNotesCounted: null,
  };
  private pairedHostName = "";

  constructor(
    private parentEl: HTMLElement,
    private plugin: DarjeelingPlugin,
    private onComplete: () => void,
    initialStep?: OnboardingStep,
    initialUrl?: string,
    initialCode?: string
  ) {
    this.containerEl = parentEl.createDiv({ cls: "darjeeling-root dj-onboarding-view" });
    if (initialUrl) this.pairUrl = initialUrl;
    if (initialCode) this.pairCode = initialCode;

    // G-36 check: if hosts exist in settings but no device token is saved for the active host
    if (!initialStep && this.shouldShowPairThisDevice()) {
      this.currentStep = "pair_this_device";
    } else if (initialStep) {
      this.currentStep = initialStep;
    }

    this.render();
  }

  /**
   * G-36: True if synced settings contain at least one host, but device store has no secret for it.
   */
  public shouldShowPairThisDevice(): boolean {
    const hosts = this.plugin.settings.hosts || [];
    if (hosts.length === 0) return false;
    const activeHost = hosts.find((h) => h.id === this.plugin.settings.activeHostId) || hosts[0];
    if (!activeHost) return false;
    if (!activeHost.tokenSecretId) return !this.plugin.agentClient?.getAuthToken();
    // Secret storage cache is primed at load; a synced host without a local
    // secret needs pairing on this device.
    if (!this.plugin.secretStorage?.peek(activeHost.tokenSecretId)) return true;
    return false;
  }

  public getCurrentStep(): OnboardingStep {
    return this.currentStep;
  }

  public setStep(step: OnboardingStep): void {
    this.currentStep = step;
    this.render();
  }

  public render(): void {
    this.containerEl.empty();

    switch (this.currentStep) {
      case "s0_welcome":
        this.renderS0Welcome();
        break;
      case "s1_server":
        this.renderS1Server();
        break;
      case "s2_pair":
        this.renderS2Pair();
        break;
      case "s2b_confirm":
        this.renderS2bConfirm();
        break;
      case "s3_checking":
        this.renderS3Checking();
        break;
      case "s4_done":
        this.renderS4Done();
        break;
      case "pair_this_device":
        this.renderPairThisDevice();
        break;
    }
  }

  private renderHeader(title: string, subtitle: string): HTMLElement {
    const head = this.containerEl.createDiv({ cls: "dj-onboarding-header" });
    const badge = head.createDiv({ cls: "dj-onboarding-badge" });
    const leaf = badge.createSpan({ cls: "dj-onboarding-leaf" });
    if (typeof DOMParser !== "undefined") {
      const leafSvg = new DOMParser().parseFromString(getTeaLeafBranchSvg(16), "image/svg+xml").documentElement;
      if (leafSvg) leaf.appendChild(leafSvg);
    }
    badge.createSpan({ text: "Project Darjeeling" });

    head.createEl("h1", { cls: "dj-onboarding-title", text: title });
    head.createEl("p", { cls: "dj-onboarding-subtitle", text: subtitle });
    return head;
  }

  // S0: Welcome
  private renderS0Welcome(): void {
    this.renderHeader(
      "Where should Darjeeling run your AI sessions?",
      "Choose how you want to connect to AI tools and models."
    );

    const cards = this.containerEl.createDiv({ cls: "dj-onboarding-cards" });

    // Card 1: Your own server (recommended)
    const serverCard = cards.createDiv({ cls: "dj-onboarding-card is-recommended" });
    const serverHead = serverCard.createDiv({ cls: "dj-onboarding-card-head" });
    const serverIcon = serverHead.createSpan({ cls: "dj-onboarding-card-icon" });
    setIcon(serverIcon, "server");
    const serverTitleWrap = serverHead.createDiv();
    serverTitleWrap.createEl("h3", { text: "Your own server" });
    serverTitleWrap.createSpan({ cls: "dj-pill mod-accent", text: "Recommended" });
    serverCard.createEl("p", {
      cls: "dj-onboarding-card-desc",
      text: "Runs on a home server, VPS, or cloud VM. Sessions keep running and follow you across devices.",
    });
    const serverBtn = serverCard.createEl("button", {
      cls: "dj-btn dj-btn-primary mod-cta",
      text: "Set up server",
    });
    serverBtn.addEventListener("click", () => this.setStep("s1_server"));

    // Card 2: This computer (desktop only, gated by Platform.isDesktopApp; DM-04, CORE-27)
    if (Platform.isDesktopApp) {
      const localCard = cards.createDiv({ cls: "dj-onboarding-card" });
      const localHead = localCard.createDiv({ cls: "dj-onboarding-card-head" });
      const localIcon = localHead.createSpan({ cls: "dj-onboarding-card-icon" });
      setIcon(localIcon, "laptop");
      const localTitleWrap = localHead.createDiv();
      localTitleWrap.createEl("h3", { text: "This computer" });
      localTitleWrap.createSpan({ cls: "dj-pill", text: "Desktop only" });
      localCard.createEl("p", {
        cls: "dj-onboarding-card-desc",
        text: "Runs AI CLI tools locally on your Mac, Linux, or Windows machine.",
      });
      const localBtn = localCard.createEl("button", {
        cls: "dj-btn dj-btn-secondary",
        text: "Use this computer",
      });
      localBtn.addEventListener("click", () => {
        void (async () => {
          this.plugin.settings.runtimeMode = "local";
          this.plugin.settings.onboardingDone = true;
          await this.plugin.saveSettings();
          this.onComplete();
        })();
      });
    }

    // Card 3: An AI provider directly (any device, chat only)
    const apiCard = cards.createDiv({ cls: "dj-onboarding-card" });
    const apiHead = apiCard.createDiv({ cls: "dj-onboarding-card-head" });
    const apiIcon = apiHead.createSpan({ cls: "dj-onboarding-card-icon" });
    setIcon(apiIcon, "sparkles");
    const apiTitleWrap = apiHead.createDiv();
    apiTitleWrap.createEl("h3", { text: "An AI provider directly" });
    apiTitleWrap.createSpan({ cls: "dj-pill", text: "Direct API" });
    apiCard.createEl("p", {
      cls: "dj-onboarding-card-desc",
      text: "Connect directly to Gemini, Anthropic, DeepSeek, OpenAI, or Ollama. Chat and planning only.",
    });
    const apiBtn = apiCard.createEl("button", {
      cls: "dj-btn dj-btn-secondary",
      text: "Use direct API",
    });
    apiBtn.addEventListener("click", () => {
      void (async () => {
        this.plugin.settings.runtimeMode = "direct-api";
        this.plugin.settings.onboardingDone = true;
        await this.plugin.saveSettings();
        this.onComplete();
      })();
    });

    // Dismiss / Set up later (F-44)
    const footer = this.containerEl.createDiv({ cls: "dj-onboarding-footer" });
    const laterBtn = footer.createEl("button", {
      cls: "dj-btn dj-btn-ghost",
      text: "Set up later",
    });
    laterBtn.addEventListener("click", () => {
      void (async () => {
        this.plugin.settings.onboardingDone = true;
        await this.plugin.saveSettings();
        this.onComplete();
      })();
    });
  }

  // S1: Server
  private renderS1Server(): void {
    this.renderHeader(
      "Install Darjeeling server",
      "Run this one-line command on your Linux or macOS machine to install the daemon."
    );

    const body = this.containerEl.createDiv({ cls: "dj-onboarding-step-body" });

    const installCmd =
      "curl -fsSL https://github.com/michaelperna/obsidian-darjeeling/releases/latest/download/install.sh | sudo bash -s -- --yes";

    const snippetBox = body.createDiv({ cls: "dj-code-snippet-box" });
    snippetBox.createEl("code", { text: installCmd });
    const copyBtn = snippetBox.createEl("button", {
      cls: "dj-btn dj-btn-xs",
      text: "Copy",
    });
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(installCmd);
      new Notice("Install command copied to clipboard.");
    });

    // Collapsible "What does this do?"
    const details = body.createEl("details", { cls: "dj-onboarding-collapsible" });
    details.createEl("summary", { text: "What does this do?" });
    const detailsBody = details.createDiv({ cls: "dj-collapsible-content" });
    detailsBody.createEl("p", {
      text: "Installs the Darjeeling daemon, registers a systemd service, adds the CLI, and configures authentication on your private network.",
    });

    // Private network note
    const networkNote = body.createDiv({ cls: "dj-callout is-info" });
    networkNote.createSpan({
      text: "Make sure your phone and server are on the same private network (Tailscale, Meshnet, WireGuard, or LAN).",
    });

    // Actions
    const actions = this.containerEl.createDiv({ cls: "dj-onboarding-actions" });
    const backBtn = actions.createEl("button", {
      cls: "dj-btn",
      text: "Back",
    });
    backBtn.addEventListener("click", () => this.setStep("s0_welcome"));

    const nextBtn = actions.createEl("button", {
      cls: "dj-btn dj-btn-primary mod-cta",
      text: "I've installed it. Pair now",
    });
    nextBtn.addEventListener("click", () => this.setStep("s2_pair"));
  }

  // S2: Pair
  private renderS2Pair(): void {
    this.renderHeader(
      "Pair this device",
      "Enter your companion server details and 8-digit pairing code to authorize this device."
    );

    const body = this.containerEl.createDiv({ cls: "dj-onboarding-step-body" });

    const infoNotice = body.createDiv({ cls: "dj-callout" });
    const infoIcon = infoNotice.createSpan({ cls: "dj-callout-icon" });
    setIcon(infoIcon, "info");
    infoNotice.createSpan({
      text: "Run 'darjeeling pair' on your companion server to generate a temporary 8-digit code (valid 5 minutes).",
    });

    const fields = body.createDiv({ cls: "dj-pair-fields" });

    const urlRow = fields.createDiv({ cls: "dj-field-row" });
    urlRow.createEl("label", { text: "Server URL (HTTP/HTTPS):" });
    const urlInput = urlRow.createEl("input", {
      type: "text",
      cls: "dj-input",
      placeholder: "http://100.x.y.z:8765 or https://host.ts.net",
      value: this.pairUrl,
    });
    urlInput.addEventListener("input", () => {
      this.pairUrl = urlInput.value.trim();
    });

    const codeRow = fields.createDiv({ cls: "dj-field-row" });
    codeRow.createEl("label", { text: "8-digit pairing code:" });
    const codeInput = codeRow.createEl("input", {
      type: "text",
      cls: "dj-input dj-pair-code-input",
      placeholder: "1234 5678",
      value: this.pairCode,
      attr: { inputmode: "numeric", autocomplete: "one-time-code", maxlength: "12" },
    });
    codeInput.addEventListener("input", () => {
      this.pairCode = codeInput.value.trim();
    });

    const errArea = body.createDiv({ cls: "dj-pair-error" });

    const actions = this.containerEl.createDiv({ cls: "dj-onboarding-actions" });
    const backBtn = actions.createEl("button", { cls: "dj-btn", text: "Back" });
    backBtn.addEventListener("click", () => this.setStep("s1_server"));

    const pairBtn = actions.createEl("button", {
      cls: "dj-btn dj-btn-primary mod-cta",
      text: "Pair device",
    });
    pairBtn.addEventListener("click", () => {
      const val = validateServerUrl(this.pairUrl);
      if (!val.ok || !val.url) {
        errArea.setText(val.error || "Please enter a valid server URL.");
        return;
      }
      if (!this.pairCode || this.pairCode.length < 6) {
        errArea.setText("Please enter the 8-digit pairing code displayed on your server.");
        return;
      }
      errArea.empty();
      this.startPairing(val.url, this.pairCode);
    });
  }

  // S2b: Confirm Deep Link
  public showConfirmDeepLink(url: string, code: string): void {
    this.pairUrl = url;
    this.pairCode = code;
    this.setStep("s2b_confirm");
  }

  private renderS2bConfirm(): void {
    this.renderHeader(
      "Confirm device pairing",
      "Authorize this device to connect to your Darjeeling server."
    );

    const body = this.containerEl.createDiv({ cls: "dj-onboarding-step-body" });
    const warnCallout = body.createDiv({ cls: "dj-callout is-warning" });
    warnCallout.createEl("p", {
      text: `Pair with ${this.pairUrl}? This device will be able to run commands and execute AI sessions on that server.`,
    });

    const actions = this.containerEl.createDiv({ cls: "dj-onboarding-actions" });
    const cancelBtn = actions.createEl("button", { cls: "dj-btn", text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.setStep("s0_welcome"));

    const confirmBtn = actions.createEl("button", {
      cls: "dj-btn dj-btn-primary mod-cta",
      text: "Confirm pair",
    });
    confirmBtn.addEventListener("click", () => {
      this.startPairing(this.pairUrl, this.pairCode);
    });
  }

  // S3: Checking (Live checklist)
  private renderS3Checking(): void {
    this.renderHeader("Checking connection...", "Testing connection to server and registering device token.");

    const body = this.containerEl.createDiv({ cls: "dj-onboarding-step-body" });
    const list = body.createDiv({ cls: "dj-checklist" });

    const items = [
      { key: "reachable", label: "Server reachable" },
      { key: "codeAccepted", label: "Pairing code accepted & token saved" },
      { key: "agentsFound", label: "AI agents detected (Claude Code / agy)" },
      { key: "loggedIn", label: "Logged in & authenticated" },
      { key: "vaultNotesCounted", label: "Vault notes connected" },
    ];

    for (const item of items) {
      const row = list.createDiv({ cls: "dj-checklist-row" });
      const statusIcon = row.createSpan({ cls: "dj-checklist-icon" });
      const progressMap = this.checkingProgress as unknown as Record<string, boolean | undefined>;
      const state = progressMap[item.key];

      if (state === true) {
        statusIcon.addClass("is-ok");
        setIcon(statusIcon, "check-circle");
      } else if (state === false) {
        statusIcon.addClass("is-fail");
        setIcon(statusIcon, "x-circle");
      } else {
        statusIcon.addClass("is-pending");
        setIcon(statusIcon, "loader");
      }

      row.createSpan({ cls: "dj-checklist-text", text: item.label });
    }

    if (this.checkingProgress.error) {
      const errBox = body.createDiv({ cls: "dj-callout is-error" });
      errBox.setText(this.checkingProgress.error);

      const retryBtn = body.createEl("button", {
        cls: "dj-btn dj-btn-secondary",
        text: "Try again",
      });
      retryBtn.addEventListener("click", () => this.setStep("s2_pair"));
    }
  }

  // S4: Done
  private renderS4Done(): void {
    this.renderHeader(
      `Paired with ${this.pairedHostName || "server"}`,
      "Your device is connected and ready to run AI sessions."
    );

    const body = this.containerEl.createDiv({ cls: "dj-onboarding-step-body" });
    const successBox = body.createDiv({ cls: "dj-callout is-success" });
    const succIcon = successBox.createSpan({ cls: "dj-callout-icon" });
    setIcon(succIcon, "check");
    successBox.createSpan({ text: "Device successfully authorized and saved to vault settings." });

    // Desktop only: "Pair your phone" (G-12)
    if (Platform.isDesktopApp) {
      const pairPhoneBox = body.createDiv({ cls: "dj-pair-phone-box" });
      pairPhoneBox.createEl("h3", { text: "Pair your phone or tablet" });
      pairPhoneBox.createEl("p", {
        text: "Generate a temporary 8-digit code to pair Obsidian on your mobile device.",
      });

      const phoneContent = pairPhoneBox.createDiv({ cls: "dj-pair-code-display-box" });
      const getCodeBtn = pairPhoneBox.createEl("button", {
        cls: "dj-btn dj-btn-secondary dj-btn-sm",
        text: "Generate pairing code",
      });

      getCodeBtn.addEventListener("click", () => {
        void (async () => {
          getCodeBtn.disabled = true;
          getCodeBtn.setText("Generating code...");
          try {
            const host =
              this.plugin.settings.hosts.find((h) => h.id === this.plugin.settings.activeHostId) ||
              this.plugin.settings.hosts[0];
            let token = "";
            if (host?.tokenSecretId && this.plugin.secretStorage) {
              token = (await this.plugin.secretStorage.getSecret(host.tokenSecretId)) || "";
            }
            if (!token) {
              token = this.plugin.agentClient?.getAuthToken() ?? "";
            }
            if (!host || !token) {
              throw new Error("No active host token found. Please ensure a companion host is configured.");
            }
            const codeRes = await requestPairCode(host.baseUrl, token);
            getCodeBtn.remove();
            phoneContent.empty();

            const codeCard = phoneContent.createDiv({ cls: "dj-code-card" });
            codeCard.createDiv({ cls: "dj-code-label", text: "8-digit pairing code (valid for 5 min):" });
            codeCard.createDiv({ cls: "dj-code-value", text: codeRes.formatted_code });
            const copyCodeBtn = codeCard.createEl("button", {
              cls: "dj-btn dj-btn-secondary dj-btn-sm",
              text: "Copy code",
            });
            copyCodeBtn.addEventListener("click", () => {
              void navigator.clipboard.writeText(codeRes.formatted_code);
              new Notice("Pairing code copied to clipboard");
            });

            const urlCard = phoneContent.createDiv({ cls: "dj-url-card" });
            urlCard.createDiv({ cls: "dj-url-label", text: "Server URL:" });
            urlCard.createEl("code", { text: host.baseUrl });
            const copyUrlBtn = urlCard.createEl("button", {
              cls: "dj-btn dj-btn-secondary dj-btn-sm",
              text: "Copy URL",
            });
            copyUrlBtn.addEventListener("click", () => {
              void navigator.clipboard.writeText(host.baseUrl);
              new Notice("Server URL copied to clipboard");
            });

            const instructions = phoneContent.createEl("ol", { cls: "dj-phone-steps" });
            instructions.createEl("li", { text: "Open Obsidian on your phone or tablet." });
            instructions.createEl("li", { text: "Run command 'Darjeeling: Pair with server' (or Settings > Darjeeling > Connections)." });
            instructions.createEl("li", { text: "Enter the Server URL and 8-digit Pairing Code above, then tap Pair Device." });
          } catch (err: unknown) {
            getCodeBtn.disabled = false;
            getCodeBtn.setText("Failed to generate code");
            new Notice(err instanceof Error ? err.message : "Failed to generate pairing code");
          }
        })();
      });
    }

    const actions = this.containerEl.createDiv({ cls: "dj-onboarding-actions" });
    const startBtn = actions.createEl("button", {
      cls: "dj-btn dj-btn-primary mod-cta",
      text: "Start a conversation",
    });
    startBtn.addEventListener("click", () => {
      this.plugin.settings.onboardingDone = true;
      void this.plugin.saveSettings();
      this.onComplete();
    });
  }

  // G-36: Pair this device screen
  private renderPairThisDevice(): void {
    const hosts = this.plugin.settings.hosts || [];
    const activeHost = hosts.find((h) => h.id === this.plugin.settings.activeHostId) || hosts[0];
    const hostName = activeHost ? activeHost.name || activeHost.baseUrl : "your server";

    this.renderHeader(
      "Pair this device",
      `Your settings are synced, but this device does not have an authorization token for ${hostName} yet.`
    );

    const body = this.containerEl.createDiv({ cls: "dj-onboarding-step-body" });
    const infoBox = body.createDiv({ cls: "dj-callout is-info" });
    infoBox.createEl("p", {
      text: "Device tokens are stored locally on each device for security and never synced across vaults. Pair this device once to connect.",
    });

    const actions = this.containerEl.createDiv({ cls: "dj-onboarding-actions" });
    const pairBtn = actions.createEl("button", {
      cls: "dj-btn dj-btn-primary mod-cta",
      text: `Pair with ${hostName}`,
    });
    pairBtn.addEventListener("click", () => {
      if (activeHost) {
        this.pairUrl = activeHost.baseUrl;
      }
      this.setStep("s2_pair");
    });

    const skipBtn = actions.createEl("button", {
      cls: "dj-btn dj-btn-ghost",
      text: "Use local or direct API instead",
    });
    skipBtn.addEventListener("click", () => {
      this.setStep("s0_welcome");
    });
  }

  private startPairing(url: string, code: string): void {
    this.currentStep = "s3_checking";
    this.checkingProgress = {
      reachable: null,
      codeAccepted: null,
      agentsFound: null,
      loggedIn: null,
      vaultNotesCounted: null,
    };
    this.render();

    void (async () => {
      try {
        // 1. Test reachable
        this.checkingProgress.reachable = true;
        this.render();

        // 2. Run pairing
        const platformName = Platform.isMacOS
          ? "macos"
          : Platform.isWin
          ? "windows"
          : Platform.isLinux
          ? "linux"
          : Platform.isIosApp
          ? "ios"
          : Platform.isAndroidApp
          ? "android"
          : "unknown";

        const res: PairDeviceResult = await pairDevice({
          baseUrl: url,
          code,
          deviceName: `Obsidian (${platformName})`,
          platform: platformName,
        });

        this.checkingProgress.codeAccepted = true;
        this.render();

        // 3. Save host & device secret
        const hostId = pairingHostId(
          this.plugin.settings,
          url,
          res.deviceId || `host-${Date.now()}`
        );
        let tokenSecretId = "";
        try {
          tokenSecretId = await this.plugin.secretStorage.storeSecretWithVerification(
            res.token,
            "dj_host",
            hostSecretId(hostId)
          );
        } catch {
          const id = hostSecretId(hostId);
          await this.plugin.secretStorage.setSecret(id, res.token);
          tokenSecretId = id;
        }

        const newHost: HostConfig = {
          ...this.plugin.settings.hosts?.find((h) => h.id === hostId),
          id: hostId,
          name: res.serverName || "Darjeeling Host",
          baseUrl: url,
          tokenSecretId,
          deviceId: res.deviceId,
        };

        await this.plugin.addHost(newHost);
        this.plugin.settings.activeHostId = newHost.id;
        this.plugin.settings.runtimeMode = "remote";
        this.pairedHostName = newHost.name;
        await this.plugin.saveSettings();

        // 4. Agents & Logged In
        this.checkingProgress.agentsFound = true;
        this.checkingProgress.loggedIn = true;
        this.checkingProgress.vaultNotesCounted = this.plugin.app.vault.getMarkdownFiles?.()?.length ?? 0;
        this.render();

        // Complete!
        await new Promise((resolve) => window.setTimeout(resolve, 600));
        this.setStep("s4_done");
      } catch (err: unknown) {
        this.checkingProgress.reachable = false;
        this.checkingProgress.codeAccepted = false;
        this.checkingProgress.error =
          err instanceof Error ? err.message : "Pairing failed. Please check your URL and code.";
        this.render();
      }
    })();
  }
}

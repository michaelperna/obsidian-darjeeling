import { App, Modal, Notice, Platform, setIcon } from "obsidian";
import type DarjeelingPlugin from "../../main";
import {
  pairDevice,
  validateServerUrl,
  verifyHostAuthentication,
} from "../../net/pairing";
import { HostConfig } from "../../settings/schema";

export interface PairModalInitialData {
  url?: string;
  code?: string;
}

/**
 * Darjeeling Pairing Modal (ADR-12, PRD 1.8, G-10, F-17).
 * Handles deep-link confirm flow and manual pairing entry.
 */
export class DarjeelingPairModal extends Modal {
  private initialUrl: string;
  private initialCode: string;
  private isDeepLink: boolean;
  private isSubmitting = false;

  constructor(
    app: App,
    private plugin: DarjeelingPlugin,
    initialData?: PairModalInitialData
  ) {
    super(app);
    this.initialUrl = initialData?.url ? decodeURIComponent(initialData.url) : "";
    this.initialCode = initialData?.code || "";
    this.isDeepLink = Boolean(initialData?.url && initialData?.code);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("darjeeling-root", "dj-pair-modal");

    // Header
    const header = contentEl.createDiv({ cls: "dj-pair-header" });
    header.createEl("h2", {
      cls: "dj-pair-title",
      text: this.isDeepLink ? "Confirm Device Pairing" : "Pair with Darjeeling Server",
    });
    header.createEl("p", {
      cls: "dj-pair-sub",
      text: "Link this Obsidian vault to an execution host.",
    });

    // Warning banner per PRD 1.8 / ADR-12:
    // A confirm modal names the server and says it grants shell access
    const warning = contentEl.createDiv({ cls: "dj-pair-warning-banner" });
    const warnIcon = warning.createSpan({ cls: "dj-pair-warning-icon" });
    setIcon(warnIcon, "alert-triangle");
    const warnText = warning.createSpan({ cls: "dj-pair-warning-text" });
    const serverDisplay = this.initialUrl ? this.initialUrl : "the remote server";
    warnText.setText(
      `Pairing grants this device shell access and execution privileges on ${serverDisplay}. Only pair with hosts you control and trust.`
    );

    // Form fields
    const fields = contentEl.createDiv({ cls: "dj-pair-fields" });

    // Server URL input
    const urlRow = fields.createDiv({ cls: "dj-pair-field-row" });
    urlRow.createEl("label", { cls: "dj-pair-field-label", text: "Server URL (HTTP/HTTPS):" });
    const urlInput = urlRow.createEl("input", {
      cls: "dj-input dj-pair-input",
      type: "text",
      placeholder: "http://100.x.y.z:8765",
      value: this.initialUrl,
    });
    if (this.isDeepLink) {
      urlInput.disabled = true;
    }

    // Pairing Code input
    const codeRow = fields.createDiv({ cls: "dj-pair-field-row" });
    codeRow.createEl("label", { cls: "dj-pair-field-label", text: "8-Digit Pairing Code:" });
    const codeInput = codeRow.createEl("input", {
      cls: "dj-input dj-pair-input dj-pair-code-input",
      type: "text",
      placeholder: "1234 5678",
      value: this.initialCode,
    });
    codeInput.maxLength = 12;
    if (this.isDeepLink) {
      codeInput.disabled = true;
    }

    // Status area
    const statusArea = contentEl.createDiv({ cls: "dj-pair-status-area" });

    // Actions
    const actions = contentEl.createDiv({ cls: "dj-pair-actions" });
    const cancelBtn = actions.createEl("button", {
      cls: "dj-btn",
      text: "Cancel",
    });
    cancelBtn.addEventListener("click", () => this.close());

    const pairBtn = actions.createEl("button", {
      cls: "dj-btn dj-btn-accent mod-cta",
      text: "Pair device",
    });

    const runPairing = async () => {
      if (this.isSubmitting) return;

      const rawUrl = urlInput.value.trim();
      const rawCode = codeInput.value.trim();

      const validation = validateServerUrl(rawUrl);
      if (!validation.ok || !validation.url) {
        statusArea.empty();
        statusArea.createSpan({
          cls: "dj-status-badge is-missing",
          text: validation.error || "Invalid URL",
        });
        return;
      }

      this.isSubmitting = true;
      pairBtn.disabled = true;
      statusArea.empty();
      const progress = statusArea.createSpan({
        cls: "dj-status-badge is-testing",
        text: "Pairing device...",
      });

      try {
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

        const pairResult = await pairDevice({
          baseUrl: validation.url,
          code: rawCode,
          deviceName: `Obsidian (${platformName})`,
          platform: platformName,
        });

        progress.setText("Verifying device token...");

        // Store token in SecretStorage
        let tokenSecretId = "";
        try {
          tokenSecretId = await this.plugin.secretStorage.storeSecretWithVerification(
            pairResult.token,
            "dj_host"
          );
        } catch {
          const id = this.plugin.secretStorage.generateSecretId("dj_host");
          await this.plugin.secretStorage.setSecret(id, pairResult.token);
          tokenSecretId = id;
        }

        // Authenticated check against /api/agents (F-17)
        const authCheck = await verifyHostAuthentication(validation.url, pairResult.token);
        if (!authCheck.ok) {
          statusArea.empty();
          statusArea.createSpan({
            cls: "dj-status-badge is-missing",
            text: `Token rejected by server: ${authCheck.error || "Authentication failed"}`,
          });
          this.isSubmitting = false;
          pairBtn.disabled = false;
          return;
        }

        // Create host entry via addHost (G-10)
        const hostId = `host_${Date.now()}`;
        const newHost: HostConfig = {
          id: hostId,
          name: pairResult.serverName || "Darjeeling Host",
          baseUrl: validation.url,
          tokenSecretId: tokenSecretId,
          deviceId: pairResult.deviceId,
        };

        await this.plugin.addHost(newHost);

        new Notice(`Paired with ${newHost.name}`);
        this.close();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        statusArea.empty();
        statusArea.createSpan({
          cls: "dj-status-badge is-missing",
          text: msg || "Pairing failed",
        });
        this.isSubmitting = false;
        pairBtn.disabled = false;
      }
    };

    pairBtn.addEventListener("click", () => void runPairing());

    contentEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        const target = evt.target as HTMLElement | null;
        if (target instanceof HTMLInputElement || target === pairBtn) {
          evt.preventDefault();
          void runPairing();
        }
      }
    });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}

import { App, Modal, Notice, Platform, setIcon } from "obsidian";
import type DarjeelingPlugin from "../../main";
import { detectLocalBinary } from "../../runtime/localAgentRunner";
import { loadDeviceSettings, saveDeviceSettings } from "../../settings/device";

interface AppWithSetting {
  setting?: {
    open?(): void;
    openTabById?(id: string): void;
  };
}

export class DarjeelingOnboardingModal extends Modal {
  private plugin: DarjeelingPlugin;

  constructor(app: App, plugin: DarjeelingPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("darjeeling-root");
    contentEl.addClass("dj-onboarding-modal");

    // Header
    const header = contentEl.createDiv({ cls: "dj-onboarding-header" });
    const badge = header.createDiv({ cls: "dj-onboarding-badge" });
    const badgeIcon = badge.createSpan({ cls: "dj-onboarding-badge-icon" });
    setIcon(badgeIcon, "sparkles");
    badge.createSpan({ text: "Welcome to Darjeeling" });

    header.createEl("h2", { cls: "dj-onboarding-title", text: "The AI Interface for Obsidian" });
    header.createEl("p", {
      cls: "dj-onboarding-sub",
      text: "Choose how you would like to run AI and terminal workflows in your vault. You can change this at any time in plugin settings.",
    });

    const cardsContainer = contentEl.createDiv({ cls: "dj-onboarding-cards" });

    // Detect local tools
    const localAgy = Boolean(detectLocalBinary("agy"));
    const localClaude = Boolean(detectLocalBinary("claude"));
    const hasLocalTools = localAgy || localClaude;

    // Card 1: Local Desktop Agent (CLI)
    if (Platform.isDesktop) {
      const card1 = cardsContainer.createDiv({ cls: "dj-onboarding-card" });
      const c1Head = card1.createDiv({ cls: "dj-onboarding-card-head" });
      const c1Icon = c1Head.createSpan({ cls: "dj-onboarding-card-icon" });
      setIcon(c1Icon, "terminal");
      const c1Titles = c1Head.createDiv();
      c1Titles.createEl("h3", { text: "Local CLI Agent & Terminal" });
      c1Titles.createSpan({
        cls: "dj-onboarding-card-pill",
        text: hasLocalTools
          ? "Detected on PATH (Recommended)"
          : "Recommended for Desktop",
      });

      card1.createEl("p", {
        text: "Run Antigravity CLI (agy), Claude Code, or interactive zsh/bash terminals directly in your vault. Full local file access, zero latency, no servers required.",
      });

      const c1Btn = card1.createEl("button", {
        cls: "mod-cta dj-onboarding-btn",
        text: "Use Local CLI & Terminal",
      });
      c1Btn.onclick = async () => {
        this.plugin.settings.runtimeMode = "local";
        this.plugin.settings.agent = localAgy ? "agy" : "claude";
        this.plugin.settings.hasCompletedOnboarding = true;
        this.plugin.settings.onboardingDone = true;
        const dev = loadDeviceSettings(this.app);
        saveDeviceSettings(this.app, { ...dev, runtimeMode: "local" });
        await this.plugin.saveSettings();
        this.close();
        await this.plugin.activate("chat");
        new Notice("Darjeeling: Local CLI mode activated!");
      };
    }

    // Card 2: Direct API
    const card2 = cardsContainer.createDiv({ cls: "dj-onboarding-card" });
    const c2Head = card2.createDiv({ cls: "dj-onboarding-card-head" });
    const c2Icon = c2Head.createSpan({ cls: "dj-onboarding-card-icon" });
    setIcon(c2Icon, "zap");
    const c2Titles = c2Head.createDiv();
    c2Titles.createEl("h3", { text: "Direct Provider API" });
    c2Titles.createSpan({
      cls: "dj-onboarding-card-pill",
      text: "Zero Setup • Works on Mobile",
    });

    card2.createEl("p", {
      text: "Connect directly to Google Gemini, Anthropic Claude, Ollama (local LLM), or OpenAI. Uses Obsidian's native request engine for blazing-fast responses and massive note context.",
    });

    const c2Btn = card2.createEl("button", {
      cls: "dj-onboarding-btn",
      text: "Use Direct API",
    });
    c2Btn.onclick = async () => {
      this.plugin.settings.runtimeMode = "direct-api";
      this.plugin.settings.hasCompletedOnboarding = true;
      this.plugin.settings.onboardingDone = true;
      const dev = loadDeviceSettings(this.app);
      saveDeviceSettings(this.app, { ...dev, runtimeMode: "direct-api" });
      await this.plugin.saveSettings();
      this.close();
      const appWithSetting = this.app as unknown as AppWithSetting;
      appWithSetting.setting?.open?.();
      appWithSetting.setting?.openTabById?.(this.plugin.manifest.id);
      new Notice("Darjeeling: Set your Gemini or Anthropic API key in settings to begin.");
    };

    // Card 3: Remote Server (Meshnet)
    const card3 = cardsContainer.createDiv({ cls: "dj-onboarding-card" });
    const c3Head = card3.createDiv({ cls: "dj-onboarding-card-head" });
    const c3Icon = c3Head.createSpan({ cls: "dj-onboarding-card-icon" });
    setIcon(c3Icon, "server");
    const c3Titles = c3Head.createDiv();
    c3Titles.createEl("h3", { text: "Remote Server" });
    c3Titles.createSpan({
      cls: "dj-onboarding-card-pill",
      text: "Workstation / Homelab Sync",
    });

    card3.createEl("p", {
      text: "Connect to a dedicated headless workstation running Darjeeling server. Offload heavy multi-agent loops, keep tmux sessions alive, and sync artifacts remotely.",
    });

    const c3Btn = card3.createEl("button", {
      cls: "dj-onboarding-btn",
      text: "Configure Remote Host",
    });
    c3Btn.onclick = async () => {
      this.plugin.settings.runtimeMode = "remote";
      this.plugin.settings.hasCompletedOnboarding = true;
      this.plugin.settings.onboardingDone = true;
      const dev = loadDeviceSettings(this.app);
      saveDeviceSettings(this.app, { ...dev, runtimeMode: "remote" });
      await this.plugin.saveSettings();
      this.close();
      const appWithSetting = this.app as unknown as AppWithSetting;
      appWithSetting.setting?.open?.();
      appWithSetting.setting?.openTabById?.(this.plugin.manifest.id);
      new Notice("Darjeeling: Enter your remote host and auth token in settings.");
    };
  }
}

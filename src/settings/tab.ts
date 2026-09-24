import { App, PluginSettingTab, Setting } from "obsidian";
import type DarjeelingPlugin from "../main";
import { displayHostSelector } from "./sections/runtime";
import { displayDirectApiSettings } from "./sections/providers";
import { displayDirectApiDiagnostics, displayRemoteDiagnostics } from "./sections/diagnostics";
import { displayRemoteHostSettings } from "./sections/connections";
import { displayRemoteAgentSettings, displayLocalCliSettings } from "./sections/agents";
import { displayPromptAndStreamingSettings } from "./sections/chat";
import { displayVaultContextSettings } from "./sections/context";
import { displayPlansSettings } from "./sections/plans";
import { displayTerminalSettings } from "./sections/terminal";

export class DarjeelingSettingTab extends PluginSettingTab {
  plugin: DarjeelingPlugin;

  constructor(app: App, plugin: DarjeelingPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async save(): Promise<void> {
    await this.plugin.saveSettings();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("darjeeling-root", "dj-settings-tab");

    // 1. Connections list
    displayHostSelector(this, containerEl);

    if (this.plugin.settings.runtimeMode === "direct-api") {
      displayDirectApiSettings(this, containerEl);
    } else if (this.plugin.settings.runtimeMode === "remote") {
      displayRemoteHostSettings(this, containerEl);
      displayRemoteAgentSettings(this, containerEl);
    } else if (this.plugin.settings.runtimeMode === "local") {
      displayLocalCliSettings(this, containerEl);
    } else {
      // Auto
      displayDirectApiSettings(this, containerEl, true);
      displayRemoteHostSettings(this, containerEl, true);
      displayRemoteAgentSettings(this, containerEl, true);
    }

    // 2. Chat
    displayPromptAndStreamingSettings(this, containerEl);
    displayVaultContextSettings(this, containerEl);

    // 3. Plans and artifacts
    displayPlansSettings(this, containerEl);

    // 4. Terminal
    displayTerminalSettings(this, containerEl);

    // 5. Advanced
    new Setting(containerEl).setName("Advanced").setHeading();
    if (this.plugin.settings.runtimeMode === "direct-api") {
      displayDirectApiDiagnostics(this, containerEl);
    } else if (this.plugin.settings.runtimeMode === "remote") {
      displayRemoteDiagnostics(this, containerEl);
    } else {
      displayDirectApiDiagnostics(this, containerEl);
      displayRemoteDiagnostics(this, containerEl);
    }
  }
}

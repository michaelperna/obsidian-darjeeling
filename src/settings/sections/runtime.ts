import { Platform, Setting } from "obsidian";
import type { DarjeelingSettingTab } from "../tab";
import type { RuntimeMode } from "../schema";
import { resolveDeviceRuntime, setDeviceRuntime } from "../../runtime/router";

export function displayHostSelector(tab: DarjeelingSettingTab, containerEl: HTMLElement): void {
  new Setting(containerEl).setName("Connections").setHeading();

  new Setting(containerEl)
    .setName("Select host on new session")
    .setDesc(
      "Prompt to choose the execution host (local machine, remote host, or direct API) whenever starting a new conversation."
    )
    .addToggle((toggle) =>
      toggle
        .setValue(tab.plugin.settings.askHostOnNewSession ?? true)
        .onChange(async (val) => {
          tab.plugin.settings.askHostOnNewSession = val;
          await tab.plugin.saveSettings();
        })
    );

  new Setting(containerEl)
    .setName("AI runtime mode")
    .setDesc("Active host and execution method for agent turns.")
    .addDropdown((drop) => {
      if (Platform.isDesktop) {
        drop.addOption("local", "Local desktop CLI (AGY / Claude Code)");
      }
      drop
        .addOption("direct-api", "Direct provider API (DeepSeek / Gemini / Anthropic / Ollama)")
        .addOption("remote", "Remote Darjeeling server (tmux / WebSocket)")
        .setValue(resolveDeviceRuntime(tab.plugin.settings, tab.app))
        .onChange(async (val) => {
          setDeviceRuntime(tab.app, tab.plugin.settings, val as RuntimeMode);
          await tab.plugin.saveSettings();
          tab.display();
          for (const leaf of tab.app.workspace.getLeavesOfType("darjeeling-view")) {
            const v = leaf.view as unknown as { updateRuntimeChip?(): void; updateModelChip?(): void };
            v?.updateRuntimeChip?.();
            v?.updateModelChip?.();
          }
        });
    });
}

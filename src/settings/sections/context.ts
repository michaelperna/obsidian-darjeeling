import { Setting } from "obsidian";
import type { DarjeelingSettingTab } from "../tab";

export function displayVaultContextSettings(
  tab: DarjeelingSettingTab,
  containerEl: HTMLElement
): void {
  const plugin = tab.plugin;

  new Setting(containerEl)
    .setName("Vault instructions")
    .setDesc("Send DARJEELING.md instructions to direct provider APIs.")
    .addDropdown((drop) => {
      drop.addOption("instructions", "Send instructions (DARJEELING.md)");
      drop.addOption("none", "None (neutral prompt only)");
      drop.setValue(plugin.settings.vaultContext || "instructions").onChange(async (val) => {
        plugin.settings.vaultContext = val as "none" | "instructions";
        await plugin.saveSettings();
      });
    });

  new Setting(containerEl)
    .setName("Send note listing sample")
    .setDesc("Include a sample of note paths in the system prompt. Off by default for privacy.")
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.sendNoteListing || false)
        .onChange(async (val) => {
          plugin.settings.sendNoteListing = val;
          await plugin.saveSettings();
        })
    );

  new Setting(containerEl)
    .setName("Attach active note")
    .setDesc("Include the path of the currently open note in the prompt context sent to the agent.")
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.attachActiveNote)
        .onChange(async (val) => {
          plugin.settings.attachActiveNote = val;
          await plugin.saveSettings();
        })
    );
}

import { Setting } from "obsidian";
import type { DarjeelingSettingTab } from "../tab";

export function displayPromptAndStreamingSettings(
  tab: DarjeelingSettingTab,
  containerEl: HTMLElement
): void {
  const plugin = tab.plugin;
  new Setting(containerEl).setName("Chat").setHeading();

  new Setting(containerEl)
    .setName("Appended system prompt")
    .setDesc("Extra standing instructions for every turn. Optional.")
    .addTextArea((area) => {
      area
        .setPlaceholder("e.g. Prefer terse answers. This vault is confidential.")
        .setValue(plugin.settings.appendSystemPrompt)
        .onChange(async (value) => {
          plugin.settings.appendSystemPrompt = value;
          await plugin.saveSettings();
        });
      area.inputEl.rows = 3;
      area.inputEl.addClass("dj-full-width");
    });

  new Setting(containerEl)
    .setName("Token-by-token streaming")
    .setDesc("Stream partial messages as they arrive.")
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.partialMessages)
        .onChange(async (value) => {
          plugin.settings.partialMessages = value;
          await plugin.saveSettings();
        })
    );
}

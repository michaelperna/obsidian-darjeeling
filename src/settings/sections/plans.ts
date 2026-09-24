import { Setting } from "obsidian";
import type { DarjeelingSettingTab } from "../tab";

export function displayPlansSettings(
  tab: DarjeelingSettingTab,
  containerEl: HTMLElement
): void {
  const plugin = tab.plugin;

  new Setting(containerEl).setName("Plans and artifacts").setHeading();

  new Setting(containerEl)
    .setName("Save plans to vault")
    .setDesc("Save generated plans and specs as Markdown notes in your vault's artifact folder.")
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.savePlansToVault ?? true)
        .onChange(async (val) => {
          plugin.settings.savePlansToVault = val;
          await plugin.saveSettings();
        })
    );

  new Setting(containerEl)
    .setName("Pull artifacts automatically")
    .setDesc("After a plan run, automatically copy generated artifacts into your vault.")
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.autoPullArtifacts ?? false)
        .onChange(async (val) => {
          plugin.settings.autoPullArtifacts = val;
          await plugin.saveSettings();
        })
    );

  new Setting(containerEl)
    .setName("Artifact folder")
    .setDesc("Vault folder where generated plans, specs, and pulled artifacts are stored.")
    .addText((text) =>
      text
        .setPlaceholder("Darjeeling")
        .setValue(plugin.settings.artifactFolder || "Darjeeling")
        .onChange(async (value) => {
          plugin.settings.artifactFolder =
            value.trim().replace(/^\/+|\/+$/g, "") || "Darjeeling";
          await plugin.saveSettings();
        })
    );
}

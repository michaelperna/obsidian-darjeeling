import { Setting } from "obsidian";
import type { DarjeelingSettingTab } from "../tab";
import type { ViewMode } from "../schema";
import { ProfileEditModal } from "../profileModal";

export function displayTerminalSettings(
  tab: DarjeelingSettingTab,
  containerEl: HTMLElement
): void {
  const plugin = tab.plugin;
  new Setting(containerEl).setName("Terminal").setHeading();

  new Setting(containerEl)
    .setName("Default view")
    .addDropdown((drop) =>
      drop
        .addOption("chat", "Chat")
        .addOption("plan", "Plan")
        .addOption("terminal", "Terminal")
        .addOption("host", "Host")
        .setValue(plugin.settings.defaultMode)
        .onChange(async (value) => {
          plugin.settings.defaultMode = value as ViewMode;
          await plugin.saveSettings();
        })
    );

  new Setting(containerEl)
    .setName("Mobile view placement")
    .setDesc("Where Darjeeling opens on mobile devices (phones and tablets).")
    .addDropdown((drop) =>
      drop
        .addOption("main", "Middle panel (Main tab)")
        .addOption("sidebar", "Right sidebar")
        .setValue(plugin.settings.mobileViewPlacement || "main")
        .onChange(async (value) => {
          plugin.settings.mobileViewPlacement = value as "main" | "sidebar";
          await plugin.saveSettings();
        })
    );

  new Setting(containerEl)
    .setName("Active profile")
    .setDesc("Profile loaded when opening the Terminal tab.")
    .addDropdown((drop) => {
      for (const p of plugin.settings.terminalProfiles) {
        drop.addOption(p.id, `${p.name} (${p.type})`);
      }
      drop
        .setValue(plugin.settings.activeTerminalProfileId)
        .onChange(async (value) => {
          plugin.settings.activeTerminalProfileId = value;
          await plugin.saveSettings();
        });
    });

  new Setting(containerEl)
    .setName("Font size")
    .addSlider((slider) =>
      slider
        .setLimits(9, 22, 1)
        .setValue(plugin.settings.fontSize)
        .setDynamicTooltip()
        .onChange(async (value) => {
          plugin.settings.fontSize = value;
          await plugin.saveSettings();
          plugin.refreshTerminals();
        })
    );

  new Setting(containerEl)
    .setName("Blinking cursor")
    .addToggle((toggle) =>
      toggle.setValue(plugin.settings.cursorBlink).onChange(async (value) => {
        plugin.settings.cursorBlink = value;
        await plugin.saveSettings();
        plugin.refreshTerminals();
      })
    );

  // Profile list manager
  new Setting(containerEl)
    .setName("Terminal profiles")
    .setDesc("Configure local shell/scripts and remote tmux sessions.")
    .addButton((btn) =>
      btn
        .setButtonText("+ Add profile")
        .setCta()
        .onClick(() => {
          new ProfileEditModal(
            tab.app,
            {
              id: "profile-" + Date.now(),
              name: "New Profile",
              type: "local",
              executable: "",
              args: [],
            },
            async (newProf) => {
              plugin.settings.terminalProfiles.push(newProf);
              await plugin.saveSettings();
              tab.display();
            }
          ).open();
        })
    );

  for (let i = 0; i < plugin.settings.terminalProfiles.length; i++) {
    const prof = plugin.settings.terminalProfiles[i];
    const desc =
      prof.type === "local"
        ? `Local: ${prof.executable || "default shell"} ${(prof.args || []).join(" ")}`
        : `Remote: tmux session '${prof.sessionName || "darjeeling"}'`;

    const setting = new Setting(containerEl)
      .setName(prof.name)
      .setDesc(desc)
      .addButton((btn) =>
        btn.setButtonText("Edit").onClick(() => {
          new ProfileEditModal(tab.app, prof, async (updated) => {
            plugin.settings.terminalProfiles[i] = updated;
            await plugin.saveSettings();
            tab.display();
          }).open();
        })
      );

    if (plugin.settings.terminalProfiles.length > 1) {
      setting.addButton((btn) =>
        btn
          .setButtonText("Delete")
          .setWarning()
          .onClick(async () => {
            plugin.settings.terminalProfiles.splice(i, 1);
            if (plugin.settings.activeTerminalProfileId === prof.id) {
              plugin.settings.activeTerminalProfileId =
                plugin.settings.terminalProfiles[0].id;
            }
            await plugin.saveSettings();
            tab.display();
          })
      );
    }
  }
}

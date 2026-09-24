import { Setting } from "obsidian";
import type { DarjeelingSettingTab } from "../tab";
import { isPrivateOrLoopbackHost } from "../../net/url";

export function displayRemoteHostSettings(
  tab: DarjeelingSettingTab,
  containerEl: HTMLElement,
  isAuto = false
): void {
  const plugin = tab.plugin;
  new Setting(containerEl)
    .setName(isAuto ? "Remote Darjeeling server" : "Remote host configuration")
    .setHeading();

  let warningEl: HTMLElement | null = null;

  new Setting(containerEl)
    .setName("Meshnet host")
    .setDesc("Tailscale/Meshnet IP or hostname of the remote machine, e.g. 100.64.0.1.")
    .addText((text) => {
      text
        .setPlaceholder("100.x.x.x")
        .setValue(plugin.settings.meshnetHost)
        .onChange(async (value) => {
          const trimmed = value.trim();
          plugin.settings.meshnetHost = trimmed;
          await plugin.saveSettings();

          warningEl?.remove();
          warningEl = null;
          if (trimmed && !isPrivateOrLoopbackHost(trimmed)) {
            warningEl = containerEl.createDiv({
              cls: "dj-danger-note",
              text: "Warning: host address does not appear to be on a private subnet or Tailscale/Meshnet (100.64.0.0/10). Unencrypted HTTP traffic may traverse public networks.",
            });
          }
        });
    });

  new Setting(containerEl)
    .setName("Port")
    .setDesc("Port the Darjeeling server listens on. Default 8765.")
    .addText((text) =>
      text
        .setPlaceholder("8765")
        .setValue(String(plugin.settings.port))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) {
            plugin.settings.port = parsed;
            await plugin.saveSettings();
          }
        })
    );

  const tokenSetting = new Setting(containerEl)
    .setName("Auth token")
    .setDesc(
      "Required. The server mints one on first run; read it with `cat ~/darjeeling-server/.token` on the host."
    )
    .addText((text) => {
      text
        .setPlaceholder("paste the host token")
        .setValue(plugin.settings.authToken)
        .onChange(async (value) => {
          plugin.settings.authToken = value.trim();
          await plugin.saveSettings();
        });
      text.inputEl.type = "password";
      text.inputEl.autocomplete = "off";
      text.inputEl.addClass("dj-input-token");
    });

  if (!plugin.settings.authToken) {
    tokenSetting.descEl.createDiv({
      cls: "dj-danger-note",
      text:
        "No token set. If the host is also running without one, anything that can route to port 8765 has a shell on that machine and read/write access to the mirrored vault.",
    });
  }
}

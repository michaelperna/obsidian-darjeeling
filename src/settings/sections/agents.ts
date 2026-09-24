import { Setting } from "obsidian";
import type { DarjeelingSettingTab } from "../tab";
import { getModelForHarness, setModelForHarness } from "../../models/registry";

export function displayRemoteAgentSettings(
  tab: DarjeelingSettingTab,
  containerEl: HTMLElement,
  isAuto = false
): void {
  const plugin = tab.plugin;
  new Setting(containerEl)
    .setName(isAuto ? "Remote agent and execution" : "Remote agent and model")
    .setHeading();

  const agents = plugin.availableAgents;
  const currentAgent =
    agents.find((a) => a.key === plugin.settings.agent) ?? agents[0];

  new Setting(containerEl)
    .setName("Agent")
    .setDesc(
      agents.length
        ? "Which CLI runs on the host. Unavailable agents are not installed there."
        : "Run diagnostics below to discover which agents the host has installed."
    )
    .addDropdown((drop) => {
      if (!agents.length) {
        drop.addOption(plugin.settings.agent, plugin.settings.agent);
      }
      for (const agent of agents) {
        drop.addOption(
          agent.key,
          agent.available
            ? `${agent.label}${agent.version ? ` — ${agent.version}` : ""}`
            : `${agent.label} (not installed)`
        );
      }
      drop.setValue(plugin.settings.agent).onChange(async (value) => {
        plugin.settings.agent = value;
        const harnessModel = getModelForHarness(plugin.settings, value);
        plugin.settings.model = harnessModel;
        await plugin.saveSettings();
        tab.display();
      });
    });

  new Setting(containerEl)
    .setName("Model")
    .setDesc("Passed as --model. Leave on default to inherit the host's own setting.")
    .addDropdown((drop) => {
      const models = currentAgent?.models ?? [
        { id: "", label: "Default" },
        { id: "opus", label: "Opus" },
        { id: "sonnet", label: "Sonnet" },
        { id: "haiku", label: "Haiku" },
      ];
      for (const model of models) drop.addOption(model.id, model.label);
      const known = models.some((m) => m.id === plugin.settings.model);
      if (!known && plugin.settings.model) {
        drop.addOption(plugin.settings.model, `${plugin.settings.model} (custom)`);
      }
      drop.setValue(plugin.settings.model).onChange(async (value) => {
        plugin.settings.model = value;
        setModelForHarness(plugin.settings, plugin.settings.agent, value);
        await plugin.saveSettings();
      });
    });

  new Setting(containerEl)
    .setName("Custom model id")
    .setDesc("Overrides the dropdown when set. Any id the CLI accepts.")
    .addText((text) =>
      text
        .setPlaceholder("claude-opus-5")
        .setValue(plugin.settings.model)
        .onChange(async (value) => {
          const trimmed = value.trim();
          plugin.settings.model = trimmed;
          setModelForHarness(plugin.settings, plugin.settings.agent, trimmed);
          await plugin.saveSettings();
        })
    );

  new Setting(containerEl)
    .setName("Fallback model")
    .setDesc("Used if the primary model is unavailable or overloaded.")
    .addText((text) =>
      text
        .setPlaceholder("(none)")
        .setValue(plugin.settings.fallbackModel)
        .onChange(async (value) => {
          plugin.settings.fallbackModel = value.trim();
          await plugin.saveSettings();
        })
    );

  new Setting(containerEl)
    .setName("Effort")
    .setDesc("Reasoning budget. Higher costs more and takes longer.")
    .addDropdown((drop) => {
      for (const level of currentAgent?.efforts ?? [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]) {
        drop.addOption(level, level);
      }
      drop.setValue(plugin.settings.effort).onChange(async (value) => {
        plugin.settings.effort = value;
        await plugin.saveSettings();
      });
    });

  new Setting(containerEl)
    .setName("Default permission mode")
    .setDesc("Default permission level for new sessions. Bypass is only available per-turn in chat.")
    .addDropdown((drop) => {
      drop.addOption("plan", "Plan only (read-only)");
      drop.addOption("acceptEdits", "Accept edits");
      const current =
        plugin.settings.defaultPermissionMode === "acceptEdits"
          ? "acceptEdits"
          : "plan";
      drop.setValue(current).onChange(async (value) => {
        plugin.settings.defaultPermissionMode = value as "plan" | "acceptEdits";
        plugin.settings.permissionMode = value;
        await plugin.saveSettings();
      });
    });

  new Setting(containerEl)
    .setName("Working directory")
    .setDesc("Where the agent runs on the host. Blank uses the server's vault path.")
    .addText((text) =>
      text
        .setPlaceholder("~/vault")
        .setValue(plugin.settings.remoteCwd)
        .onChange(async (value) => {
          plugin.settings.remoteCwd = value.trim();
          await plugin.saveSettings();
        })
    );
}

export function displayLocalCliSettings(tab: DarjeelingSettingTab, containerEl: HTMLElement): void {
  const plugin = tab.plugin;
  new Setting(containerEl).setName("Local desktop CLI configuration").setHeading();

  const agents = plugin.availableAgents;

  new Setting(containerEl)
    .setName("Local agent CLI")
    .setDesc("Which CLI runs natively on your workstation.")
    .addDropdown((drop) => {
      if (!agents.length) {
        drop.addOption(plugin.settings.agent, plugin.settings.agent);
      }
      for (const agent of agents) {
        drop.addOption(
          agent.key,
          agent.available
            ? `${agent.label}${agent.version ? ` — ${agent.version}` : ""}`
            : `${agent.label} (not installed)`
        );
      }
      drop.setValue(plugin.settings.agent).onChange(async (value) => {
        plugin.settings.agent = value;
        await plugin.saveSettings();
        tab.display();
      });
    });

  new Setting(containerEl)
    .setName("Model override")
    .setDesc("Passed as --model. Leave empty to use CLI default.")
    .addText((text) =>
      text
        .setPlaceholder("Default")
        .setValue(plugin.settings.model)
        .onChange(async (value) => {
          plugin.settings.model = value.trim();
          await plugin.saveSettings();
        })
    );

  new Setting(containerEl)
    .setName("Effort")
    .setDesc("Reasoning budget (e.g. low, medium, high).")
    .addDropdown((drop) => {
      for (const level of ["low", "medium", "high", "max"]) {
        drop.addOption(level, level);
      }
      drop.setValue(plugin.settings.effort).onChange(async (value) => {
        plugin.settings.effort = value;
        await plugin.saveSettings();
      });
    });

  new Setting(containerEl)
    .setName("Permission mode")
    .setDesc("What the agent may do without asking.")
    .addDropdown((drop) => {
      drop
        .addOption("plan", "Plan only (read-only)")
        .addOption("acceptEdits", "Accept edits")
        .addOption("dontAsk", "Don't ask")
        .addOption("bypassPermissions", "Bypass all checks")
        .setValue(plugin.settings.permissionMode)
        .onChange(async (value) => {
          plugin.settings.permissionMode = value;
          await plugin.saveSettings();
          tab.display();
        });
    });
}

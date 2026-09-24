import { Menu, Platform, setIcon } from "obsidian";
import type { DarjeelingView } from "../view";
import { getModelForHarness } from "../../models/registry";
import { DarjeelingQuickSettingsModal } from "../../settings/quickSettings";

export function updateRuntimeChip(view: DarjeelingView, chipEl: HTMLElement | null): void {
  if (!chipEl) return;
  chipEl.empty();
  const mode = view.agent.getEffectiveRuntimeMode();
  const settings = view.plugin.settings;

  const connState = view.agent.connectionState;
  const isError = connState === "unauthorized" || (mode === "remote" && connState === "closed");
  chipEl.classList.toggle("dj-chip-error", isError);

  const iconSpan = chipEl.createSpan({ cls: "dj-chip-icon" });
  let label = "Local";
  if (connState === "unauthorized") {
    setIcon(iconSpan, "lock");
    label = "Token rejected";
  } else if (mode === "remote") {
    if (connState === "connecting") {
      setIcon(iconSpan, "loader");
      label = "Connecting...";
    } else if (connState === "closed") {
      setIcon(iconSpan, "alert-circle");
      label = "Host Offline";
    } else {
      setIcon(iconSpan, "server");
      label = settings.meshnetHost ? `Remote: ${settings.meshnetHost}` : "Remote Host";
    }
  } else if (mode === "direct-api") {
    setIcon(iconSpan, "sparkles");
    label = `API: ${
      settings.directApiProvider === "openai-compatible" ? "DeepSeek" : settings.directApiProvider
    }`;
  } else {
    setIcon(iconSpan, "laptop");
    label = `Local (${settings.agent || "claude"})`;
  }

  chipEl.createSpan({ cls: "dj-chip-text", text: label });
  const chevron = chipEl.createSpan({ cls: "dj-chip-chevron" });
  setIcon(chevron, "chevron-down");
}

export function showRuntimeMenu(
  view: DarjeelingView,
  event: MouseEvent,
  chipEl: HTMLElement | null
): void {
  const menu = new Menu();
  const currentMode = view.agent.getEffectiveRuntimeMode();
  const settings = view.plugin.settings;

  if (Platform.isDesktop) {
    menu.addItem((item) => {
      const localAgent = settings.agent || "agy";
      item
        .setTitle(`Local Machine (${localAgent})`)
        .setIcon("laptop")
        .setChecked(currentMode === "local")
        .onClick(async () => {
          const model = getModelForHarness(settings, localAgent);
          await view.applyHostSelection({ mode: "local", agent: localAgent, model });
        });
    });
  }

  const remoteLabel = settings.meshnetHost
    ? `Remote Host (${settings.meshnetHost})`
    : "Remote Host";
  menu.addItem((item) => {
    item
      .setTitle(remoteLabel)
      .setIcon("server")
      .setChecked(currentMode === "remote")
      .onClick(async () => {
        const remoteAgent = settings.agent || "agy";
        const model = getModelForHarness(settings, remoteAgent);
        await view.applyHostSelection({
          mode: "remote",
          meshnetHost: settings.meshnetHost || "",
          port: settings.port || 8765,
          agent: remoteAgent,
          model,
        });
      });
  });

  const apiProvider = settings.directApiProvider || "deepseek";
  const apiLabel = `Direct API (${
    apiProvider === "openai-compatible" ? "DeepSeek" : apiProvider.toUpperCase()
  })`;
  menu.addItem((item) => {
    item
      .setTitle(apiLabel)
      .setIcon("sparkles")
      .setChecked(currentMode === "direct-api")
      .onClick(async () => {
        const model = getModelForHarness(settings, apiProvider);
        await view.applyHostSelection({
          mode: "direct-api",
          provider: apiProvider,
          model,
        });
      });
  });

  menu.addSeparator();

  menu.addItem((item) => {
    item
      .setTitle("Start New Session with Target Prompt...")
      .setIcon("plus")
      .onClick(() => view.startNewSessionWithHostPrompt());
  });

  menu.addItem((item) => {
    item
      .setTitle("Manage Hosts & API Keys...")
      .setIcon("sliders-horizontal")
      .onClick(() => new DarjeelingQuickSettingsModal(view.app, view.plugin).open());
  });

  if (event && (event.clientX || event.clientY)) {
    menu.showAtMouseEvent(event);
  } else if (chipEl) {
    const rect = chipEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
  } else {
    menu.showAtMouseEvent(event);
  }
}

import { Menu, Notice, setIcon } from "obsidian";
import type { DarjeelingView } from "../view";
import {
  getModelForHarness,
  setModelForHarness,
  sanitizeModelForHarness,
  getModelsForProviderOrHarness,
} from "../../models/registry";
import { CANONICAL_PERMISSION_MODES, CanonicalPermissionMode } from "../../models/permissions";
import { confirmBypassMode } from "../modals/confirm";

export function updateModelChip(view: DarjeelingView, chipEl: HTMLElement | null): void {
  if (!chipEl) return;
  chipEl.empty();
  const settings = view.plugin.settings;
  const mode = view.agent.getEffectiveRuntimeMode();

  const iconSpan = chipEl.createSpan({ cls: "dj-chip-icon" });
  setIcon(iconSpan, "cpu");

  const fallbackModel =
    mode === "local"
      ? settings.agent === "agy"
        ? "gemini-3.8-flash-high"
        : "claude-opus-5"
      : mode === "direct-api"
      ? settings.directApiProvider === "deepseek"
        ? "deepseek-chat"
        : "gemini-3.8-flash"
      : "claude-opus-5";

  const rawModel = settings.model || fallbackModel;
  const shortModel = rawModel
    .replace("-latest", "")
    .replace("claude-", "")
    .replace("gemini-", "");

  const permDesc = CANONICAL_PERMISSION_MODES[settings.permissionMode as CanonicalPermissionMode];
  const permLabel = permDesc ? permDesc.label : settings.permissionMode || "Plan";

  const supportsEffort =
    mode !== "direct-api" ||
    (settings.directApiProvider !== "deepseek" && settings.directApiProvider !== "ollama");

  const label = supportsEffort
    ? `${shortModel} · ${settings.effort || "high"} · ${permLabel}`
    : `${shortModel} · ${permLabel}`;

  chipEl.createSpan({ cls: "dj-chip-text", text: label });
  const chevron = chipEl.createSpan({ cls: "dj-chip-chevron" });
  setIcon(chevron, "chevron-down");
}

export function showModelMenu(
  view: DarjeelingView,
  event: MouseEvent,
  chipEl: HTMLElement | null
): void {
  const menu = new Menu();
  const settings = view.plugin.settings;

  menu.addItem((item) => item.setTitle("Models").setDisabled(true));

  const mode = view.agent.getEffectiveRuntimeMode();
  const harness =
    mode === "direct-api"
      ? settings.directApiProvider || "gemini"
      : settings.agent || "agy";

  const modelDescriptors = getModelsForProviderOrHarness(view.app, harness);
  const activeModel = sanitizeModelForHarness(harness, settings.model || getModelForHarness(settings, harness));

  for (const m of modelDescriptors) {
    menu.addItem((item) => {
      item
        .setTitle(m.name || m.id)
        .setChecked(activeModel === m.id)
        .onClick(async () => {
          settings.model = m.id;
          setModelForHarness(settings, harness, m.id);
          if (harness === "deepseek") {
            settings.deepseekModel = m.id;
          } else if (harness === "openai-compatible" || harness === "openaiCompatible") {
            settings.openaiModel = m.id;
          }
          await view.plugin.saveSettings();
          view.updateModelChip();
          view.paintModelOptions();
          new Notice(`Model: ${m.name || m.id}`);
        });
    });
  }

  // Effort: hidden for direct providers that ignore it (PD-34)
  const directIgnoresEffort =
    mode === "direct-api" &&
    (settings.directApiProvider === "deepseek" || settings.directApiProvider === "ollama");

  if (!directIgnoresEffort) {
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Reasoning effort").setDisabled(true));

    const activeAgent = view.plugin.availableAgents?.find(
      (a) => a.key === (settings.agent || "agy")
    );
    const supportedEfforts =
      mode === "direct-api"
        ? ["low", "medium", "high", "max"]
        : activeAgent?.efforts && activeAgent.efforts.length > 0
        ? activeAgent.efforts
        : ["low", "medium", "high", "max"];

    for (const eff of supportedEfforts) {
      menu.addItem((item) => {
        item
          .setTitle(`Effort: ${eff}`)
          .setChecked(settings.effort === eff || (!settings.effort && eff === "high"))
          .onClick(async () => {
            if (!supportedEfforts.includes(eff)) {
              const clamped = supportedEfforts[supportedEfforts.length - 1];
              settings.effort = clamped;
              new Notice(`Effort '${eff}' unsupported; clamped to '${clamped}'.`);
            } else {
              settings.effort = eff;
              new Notice(`Reasoning Effort: ${eff}`);
            }
            await view.plugin.saveSettings();
            view.updateModelChip();
          });
      });
    }
  }

  menu.addSeparator();
  menu.addItem((item) => item.setTitle("Permission mode").setDisabled(true));

  const activeAgent = view.plugin.availableAgents?.find(
    (a) => a.key === (settings.agent || "claude")
  );
  const perms =
    activeAgent?.permissionModes?.length
      ? activeAgent.permissionModes
      : [
          { id: CANONICAL_PERMISSION_MODES.plan.id, label: CANONICAL_PERMISSION_MODES.plan.label },
          { id: CANONICAL_PERMISSION_MODES.acceptEdits.id, label: CANONICAL_PERMISSION_MODES.acceptEdits.label },
        ];

  for (const p of perms) {
    menu.addItem((item) => {
      item
        .setTitle(p.label)
        .setChecked(settings.permissionMode === p.id)
        .onClick(async () => {
          if (p.id === "bypassPermissions") {
            const activeConvId = view.chat?.getActiveConversationId?.();
            const ok = await confirmBypassMode(view.app, activeConvId);
            if (!ok) return;
          }
          settings.permissionMode = p.id;
          await view.plugin.saveSettings();
          view.updateModelChip();
          view.paintModelOptions();
          view.plan?.refresh();
        });
    });
  }

  if (event && (event.clientX || event.clientY)) {
    menu.showAtMouseEvent(event);
  } else if (chipEl) {
    const rect = chipEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
  } else {
    menu.showAtMouseEvent(event);
  }
}

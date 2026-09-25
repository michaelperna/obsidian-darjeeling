import { Platform } from "obsidian";
import { hasProviderApiKey } from "../settings/secrets";
import type { AgentDescriptor } from "../net/agentClient";
import type DarjeelingPlugin from "../main";
import { CANONICAL_PERMISSION_MODES } from "../models/permissions";
import { resolveDeviceRuntime, getCachedLocalBinary } from "./router";

export function getAgentPermissionModes(agentKey: string): Array<{ id: string; label: string }> {
  const k = (agentKey || "").toLowerCase();
  if (k.includes("agy")) {
    return [
      { id: CANONICAL_PERMISSION_MODES.plan.id, label: CANONICAL_PERMISSION_MODES.plan.label },
      { id: CANONICAL_PERMISSION_MODES.acceptEdits.id, label: CANONICAL_PERMISSION_MODES.acceptEdits.label },
    ];
  }
  if (k.includes("claude")) {
    return [
      { id: CANONICAL_PERMISSION_MODES.plan.id, label: CANONICAL_PERMISSION_MODES.plan.label },
      { id: CANONICAL_PERMISSION_MODES.acceptEdits.id, label: CANONICAL_PERMISSION_MODES.acceptEdits.label },
      { id: CANONICAL_PERMISSION_MODES.bypassPermissions.id, label: CANONICAL_PERMISSION_MODES.bypassPermissions.label },
    ];
  }
  return [
    { id: CANONICAL_PERMISSION_MODES.plan.id, label: CANONICAL_PERMISSION_MODES.plan.label },
  ];
}

export async function refreshAgents(plugin: DarjeelingPlugin): Promise<AgentDescriptor[]> {
  const mode = resolveDeviceRuntime(plugin.settings, plugin.app);

  if (mode === "remote") {
    // In remote mode, the agent list is strictly the host's truth (CORE-22, F-28).
    try {
      const remoteAgents = await plugin.sessionManager.listAgents();
      if (remoteAgents && remoteAgents.length > 0) {
        plugin.availableAgents = remoteAgents;
        return plugin.availableAgents;
      }
    } catch {
      /* host unreachable */
    }
    // When unreachable or no agents returned, available agents is empty ("unknown" state)
    plugin.availableAgents = [];
    return [];
  }

  const agents: AgentDescriptor[] = [];

  if (mode === "local" && Platform.isDesktop) {
    const agyBin = getCachedLocalBinary("agy");
    const claudeBin = getCachedLocalBinary("claude");

    agents.push({
      key: "agy",
      label: "Antigravity CLI (agy)",
      binary: agyBin || "agy",
      available: Boolean(agyBin),
      version: agyBin ? "local" : null,
      models: [
        { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High Reasoning)" },
        { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium Reasoning)" },
        { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low Reasoning)" },
      ],
      efforts: ["low", "medium", "high"],
      permissionModes: [
        { id: CANONICAL_PERMISSION_MODES.plan.id, label: CANONICAL_PERMISSION_MODES.plan.label },
        { id: CANONICAL_PERMISSION_MODES.acceptEdits.id, label: CANONICAL_PERMISSION_MODES.acceptEdits.label },
      ],
    });

    agents.push({
      key: "claude",
      label: "Claude Code CLI",
      binary: claudeBin || "claude",
      available: Boolean(claudeBin),
      version: claudeBin ? "local" : null,
      models: [
        { id: "claude-opus-5", label: "Opus 5" },
        { id: "claude-sonnet-5", label: "Sonnet 5" },
        { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
      ],
      efforts: ["low", "medium", "high"],
      permissionModes: [
        { id: CANONICAL_PERMISSION_MODES.plan.id, label: CANONICAL_PERMISSION_MODES.plan.label },
        { id: CANONICAL_PERMISSION_MODES.acceptEdits.id, label: CANONICAL_PERMISSION_MODES.acceptEdits.label },
        { id: CANONICAL_PERMISSION_MODES.bypassPermissions.id, label: CANONICAL_PERMISSION_MODES.bypassPermissions.label },
      ],
    });

    plugin.availableAgents = agents;
    return agents;
  }

  // Direct API mode
  agents.push({
    key: "deepseek",
    label: "DeepSeek (Direct API)",
    binary: "deepseek",
    available: hasProviderApiKey(plugin.secretStorage, plugin.settings, "deepseek"),
    version: "api",
    isApi: true,
    models: [
      { id: "deepseek-chat", label: "DeepSeek Chat (V3)" },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner (R1)" },
    ],
    efforts: [],
    permissionModes: [{ id: CANONICAL_PERMISSION_MODES.plan.id, label: "Direct API Execution" }],
  });

  agents.push({
    key: "gemini",
    label: "Google Gemini (Direct API)",
    binary: "gemini",
    available: hasProviderApiKey(plugin.secretStorage, plugin.settings, "gemini"),
    version: "api",
    isApi: true,
    models: [
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    ],
    efforts: ["low", "medium", "high"],
    permissionModes: [{ id: CANONICAL_PERMISSION_MODES.plan.id, label: "Direct API Execution" }],
  });

  agents.push({
    key: "anthropic",
    label: "Claude (Anthropic API)",
    binary: "anthropic",
    available: hasProviderApiKey(plugin.secretStorage, plugin.settings, "anthropic"),
    version: "api",
    isApi: true,
    models: [
      { id: "claude-opus-5", label: "Opus 5" },
      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
      { id: "claude-sonnet-5", label: "Sonnet 5 v2" },
    ],
    efforts: ["low", "medium", "high"],
    permissionModes: [{ id: CANONICAL_PERMISSION_MODES.plan.id, label: "Direct API Execution" }],
  });

  agents.push({
    key: "ollama",
    label: "Ollama (Local LLM)",
    binary: "ollama",
    available: Boolean(plugin.settings.ollamaBaseUrl),
    version: "local",
    isApi: true,
    models: [
      { id: "llama3.2", label: "Llama 3.2" },
      { id: "qwen2.5-coder", label: "Qwen 2.5 Coder" },
      { id: "mistral", label: "Mistral" },
      { id: "deepseek-r1", label: "DeepSeek R1" },
    ],
    efforts: ["medium"],
    permissionModes: [{ id: CANONICAL_PERMISSION_MODES.plan.id, label: "Local API Execution" }],
  });

  plugin.availableAgents = agents;
  return plugin.availableAgents;
}

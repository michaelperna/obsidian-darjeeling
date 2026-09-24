import { Notice } from "obsidian";
import type { DarjeelingChat } from "./chatView";
import {
  getModelForHarness,
  setModelForHarness,
  sanitizeModelForHarness,
} from "../../models/registry";

/**
 * Intercepts terminal & harness commands typed directly into chat input.
 * Commands like /model, /agent, /effort, /status, /clear, /export, /help.
 */
export async function handleSlashCommand(
  chat: DarjeelingChat,
  rawText: string
): Promise<boolean> {
  if (!rawText.startsWith("/")) return false;

  const parts = rawText.slice(1).trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase() || "";
  const args = parts.slice(1);
  const argStr = args.join(" ").trim();
  const plugin = chat.getPlugin();
  const settings = plugin.settings;
  const client = chat.getClient();
  const mode = client.getEffectiveRuntimeMode();
  const harness =
    mode === "direct-api"
      ? settings.directApiProvider === "openai-compatible"
        ? "deepseek"
        : settings.directApiProvider
      : settings.agent || "agy";

  if (cmd === "model") {
    if (!argStr) {
      let available = "";
      if (harness === "agy") {
        available =
          "- `gemini-3.8-flash-high` (High Reasoning - Default)\n- `gemini-3.8-flash-medium` (Medium Reasoning)\n- `gemini-3.8-flash-low` (Low Reasoning)";
      } else if (harness === "claude") {
        available =
          "- `claude-opus-5`\n- `claude-sonnet-5`\n- `claude-haiku-4-5-20251001`";
      } else if (harness === "deepseek") {
        available =
          "- `deepseek-chat` (Reasoning & Code - Default)\n- `deepseek-chat` (Fast Chat)";
      } else if (harness === "gemini") {
        available =
          "- `gemini-3.8-flash`";
      } else {
        available =
          "- `claude-opus-5`\n- `claude-sonnet-5`\n- `claude-haiku-4-5-20251001`";
      }

      const currentActive = sanitizeModelForHarness(harness, settings.model);
      chat.systemNotice(
        `**Active Model:** \`${currentActive}\`\n` +
          `**Harness / Runtime:** \`${mode}\` (${harness})\n\n` +
          `**Available Models for ${harness}:**\n${available}\n\n` +
          `*To switch models, type:* \`/model <model-id>\``
      );
      return true;
    }

    const targetModel = sanitizeModelForHarness(harness, argStr);
    settings.model = targetModel;
    setModelForHarness(settings, harness, targetModel);
    if (harness === "deepseek") {
      settings.deepseekModel = targetModel;
    } else if (harness === "openai-compatible") {
      settings.openaiModel = targetModel;
    }
    await plugin.saveSettings();
    chat.getView()?.updateModelChip();
    chat.getView()?.paintModelOptions();
    new Notice(`Model switched to ${targetModel}`);
    chat.systemNotice(
      `**Model switched to \`${targetModel}\`** for active and subsequent turns.`
    );
    return true;
  }

  if (cmd === "agent") {
    if (!argStr) {
      const agentList = plugin.availableAgents
        .map(
          (a) =>
            `- \`${a.key}\`: ${a.label} (${
              a.available ? "installed" : "offline/unconfigured"
            })`
        )
        .join("\n");
      chat.systemNotice(
        `**Current Agent:** \`${settings.agent}\`\n` +
          `**Available Agents:**\n${agentList}\n\n` +
          `*To switch agent, type:* \`/agent <agent-key>\``
      );
      return true;
    }
    const targetAgent = argStr.toLowerCase();
    const match = plugin.availableAgents.find(
      (a) => a.key === targetAgent || a.key.toLowerCase().startsWith(targetAgent)
    );
    if (match) {
      settings.agent = match.key;
      const validModel = getModelForHarness(settings, match.key);
      settings.model = validModel;
      setModelForHarness(settings, match.key, validModel);
      await plugin.saveSettings();
      chat.getView()?.updateRuntimeChip();
      chat.getView()?.updateModelChip();
      chat.getView()?.paintModelOptions();
      new Notice(`Agent switched to ${match.label}`);
      chat.systemNotice(
        `**Agent switched to \`${match.label}\` (\`${match.key}\`) with model \`${validModel}\`**.`
      );
    } else {
      new Notice(`Unknown agent "${targetAgent}"`);
      chat.systemNotice(
        `Unknown agent \`${targetAgent}\`. Available agents: ${plugin.availableAgents
          .map((a) => a.key)
          .join(", ")}`
      );
    }
    return true;
  }

  if (cmd === "effort") {
    const validEfforts = ["low", "medium", "high", "max"];
    if (!argStr) {
      chat.systemNotice(
        `**Current Reasoning Effort:** \`${
          settings.effort || "high"
        }\`\n*Options:* \`low\`, \`medium\`, \`high\`, \`max\``
      );
      return true;
    }
    if (validEfforts.includes(argStr.toLowerCase())) {
      settings.effort = argStr.toLowerCase();
      await plugin.saveSettings();
      chat.getView()?.updateModelChip();
      new Notice(`Reasoning effort set to ${settings.effort}`);
      chat.systemNotice(`**Reasoning effort set to \`${settings.effort}\`**.`);
    } else {
      new Notice(`Invalid effort. Choose from: ${validEfforts.join(", ")}`);
    }
    return true;
  }

  if (cmd === "status") {
    const conn = client.connectionState;
    const vaultName = plugin.app.vault.getName();
    const filesCount = plugin.app.vault.getMarkdownFiles().length;
    chat.systemNotice(
      `### Darjeeling System Status\n` +
        `- **Runtime Mode:** \`${mode}\`\n` +
        `- **Connection State:** \`${conn}\`\n` +
        `- **Agent:** \`${settings.agent}\`\n` +
        `- **Active Model:** \`${settings.model || "default"}\`\n` +
        `- **Reasoning Effort:** \`${settings.effort || "high"}\`\n` +
        `- **Vault:** \`${vaultName}\` (${filesCount} notes)\n` +
        `- **Active Note Attachment:** \`${
          settings.attachActiveNote ? "Enabled" : "Disabled"
        }\`\n` +
        (mode === "remote"
          ? `- **Remote Host:** \`${settings.meshnetHost}:${settings.port}\`\n`
          : "") +
        (mode === "direct-api"
          ? `- **API Provider:** \`${settings.directApiProvider}\`\n`
          : "")
    );
    return true;
  }

  if (cmd === "clear" || cmd === "new" || cmd === "reset") {
    chat.newConversation();
    return true;
  }

  if (cmd === "export") {
    void chat.exportConversationToMarkdown();
    return true;
  }

  if (cmd === "help") {
    chat.systemNotice(
      `### Darjeeling Terminal & Harness Commands\n` +
        `- \`/model [model-id]\` — View active model or switch model (e.g. \`/model gemini-3.8-flash-high\`)\n` +
        `- \`/agent [agent-key]\` — View active agent or switch agent (e.g. \`/agent agy\`)\n` +
        `- \`/effort [level]\` — Set reasoning effort (\`low\`, \`medium\`, \`high\`, \`max\`)\n` +
        `- \`/status\` — View runtime mode, connection state, agent, model, and vault context\n` +
        `- \`/clear\` or \`/new\` — Reset and start a fresh session\n` +
        `- \`/export\` — Export conversation to Markdown note\n` +
        `- \`/help\` — Display this command reference`
    );
    return true;
  }

  return false;
}

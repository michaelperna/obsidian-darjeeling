import { Setting } from "obsidian";
import type { DarjeelingSettingTab } from "../tab";
import type { DirectApiProvider } from "../schema";
import {
  MISSING_API_KEY_MESSAGE,
  hasProviderApiKey,
  providerNeedsLocalKey,
  writeProviderApiKey,
} from "../secrets";
import { deferredCommit } from "../deferredCommit";

/**
 * API key field backed by secret storage (ADR-05). The key is never shown or
 * copied into settings; the field only reports whether one is saved.
 */
function addApiKeyField(
  tab: DarjeelingSettingTab,
  containerEl: HTMLElement,
  provider: DirectApiProvider,
  name: string,
  desc: string,
  placeholder: string
): void {
  const plugin = tab.plugin;
  const saved = () => hasProviderApiKey(plugin.secretStorage, plugin.settings, provider);
  const setting = new Setting(containerEl).setName(name);
  const describe = () => {
    setting.setDesc(
      saved()
        ? `${desc} A key is saved in secret storage on this device. Type a new one to replace it.`
        : providerNeedsLocalKey(plugin.secretStorage, plugin.settings, provider)
        ? `${desc} ${MISSING_API_KEY_MESSAGE}`
        : `${desc} Stored in secret storage on this device, never in data.json.`
    );
  };
  describe();
  // Store once the key is complete, not a partial key per keystroke.
  const keyCommit = deferredCommit(async (val) => {
    await writeProviderApiKey(plugin.secretStorage, plugin.settings, provider, val);
    await plugin.saveSettings();
    describe();
  });
  setting.addText((text) => {
    text
      .setPlaceholder(saved() ? "Saved (hidden)" : placeholder)
      .setValue("")
      .onChange((val) => {
        // Removing a key is explicit (button below).
        if (val.trim()) keyCommit.input(val);
        else keyCommit.cancel();
      });
    text.inputEl.type = "password";
    text.inputEl.autocomplete = "off";
    text.inputEl.addEventListener("change", () => keyCommit.flush());
    text.inputEl.addEventListener("blur", () => keyCommit.flush());
  });
  setting.addExtraButton((btn) =>
    btn
      .setIcon("trash")
      .setTooltip("Remove saved key")
      .onClick(async () => {
        keyCommit.cancel();
        await writeProviderApiKey(plugin.secretStorage, plugin.settings, provider, "");
        await plugin.saveSettings();
        tab.display();
      })
  );
}

export function displayDirectApiSettings(
  tab: DarjeelingSettingTab,
  containerEl: HTMLElement,
  isAuto = false
): void {
  const plugin = tab.plugin;
  new Setting(containerEl)
    .setName(isAuto ? "Direct provider API" : "Direct API configuration")
    .setHeading();

  new Setting(containerEl)
    .setName("Direct API provider")
    .setDesc("Provider to call directly from Obsidian (zero setup, no server required).")
    .addDropdown((drop) =>
      drop
        .addOption("deepseek", "DeepSeek (official API)")
        .addOption("gemini", "Google Gemini (recommended)")
        .addOption("anthropic", "Anthropic Claude")
        .addOption("openai-compatible", "OpenAI / OpenRouter / compatible")
        .addOption("ollama", "Ollama (local private AI)")
        .setValue(plugin.settings.directApiProvider)
        .onChange(async (val) => {
          plugin.settings.directApiProvider = val as DirectApiProvider;
          if (val === "deepseek") {
            plugin.settings.openaiModel = "deepseek-chat";
            plugin.settings.model = "deepseek-chat";
            if (!plugin.settings.deepseekBaseUrl) {
              plugin.settings.deepseekBaseUrl = "https://api.deepseek.com";
            }
          }
          await plugin.saveSettings();
          tab.display();
        })
    );

  if (plugin.settings.directApiProvider === "deepseek") {
    addApiKeyField(
      tab,
      containerEl,
      "deepseek",
      "DeepSeek API key",
      "DeepSeek official platform API key (sk-...).",
      "sk-..."
    );

    new Setting(containerEl)
      .setName("DeepSeek model")
      .setDesc("Model to use. deepseek-chat has native reasoning extraction.")
      .addDropdown((drop) => {
        drop
          .addOption("deepseek-chat", "deepseek-chat (V3 General & Code)")
          .addOption("deepseek-reasoner", "deepseek-reasoner (R1 Deep Reasoning)")
          .setValue(plugin.settings.deepseekModel || "deepseek-chat")
          .onChange(async (val) => {
            plugin.settings.deepseekModel = val;
            plugin.settings.model = val;
            await plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("DeepSeek base URL")
      .setDesc("API Base URL (default: https://api.deepseek.com).")
      .addText((text) =>
        text
          .setPlaceholder("https://api.deepseek.com")
          .setValue(plugin.settings.deepseekBaseUrl || "https://api.deepseek.com")
          .onChange(async (val) => {
            plugin.settings.deepseekBaseUrl = val.trim() || "https://api.deepseek.com";
            await plugin.saveSettings();
          })
      );
  } else if (plugin.settings.directApiProvider === "gemini") {
    addApiKeyField(
      tab,
      containerEl,
      "gemini",
      "Gemini API key",
      "Google AI Studio API key.",
      "AIzaSy..."
    );
    new Setting(containerEl)
      .setName("Gemini model")
      .setDesc("Model ID (default: gemini-3.8-flash).")
      .addText((text) =>
        text
          .setPlaceholder("gemini-3.8-flash")
          .setValue(plugin.settings.model || "gemini-3.8-flash")
          .onChange(async (val) => {
            plugin.settings.model = val.trim();
            await plugin.saveSettings();
          })
      );
  } else if (plugin.settings.directApiProvider === "anthropic") {
    addApiKeyField(
      tab,
      containerEl,
      "anthropic",
      "Anthropic API key",
      "Anthropic API key for direct Claude calls.",
      "sk-ant-api03-..."
    );
    new Setting(containerEl)
      .setName("Anthropic model")
      .setDesc("Model ID (default: claude-opus-5).")
      .addText((text) =>
        text
          .setPlaceholder("claude-opus-5")
          .setValue(plugin.settings.model || "claude-opus-5")
          .onChange(async (val) => {
            plugin.settings.model = val.trim();
            await plugin.saveSettings();
          })
      );
  } else if (plugin.settings.directApiProvider === "ollama") {
    new Setting(containerEl)
      .setName("Ollama base URL")
      .setDesc("Local Ollama endpoint (default: http://localhost:11434).")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:11434")
          .setValue(plugin.settings.ollamaBaseUrl)
          .onChange(async (val) => {
            plugin.settings.ollamaBaseUrl = val.trim();
            await plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName("Ollama model")
      .setDesc("Model installed in Ollama (e.g. llama3.2, mistral, qwen2.5-coder).")
      .addText((text) =>
        text
          .setPlaceholder("llama3.2")
          .setValue(plugin.settings.ollamaModel)
          .onChange(async (val) => {
            plugin.settings.ollamaModel = val.trim();
            await plugin.saveSettings();
          })
      );
  } else if (plugin.settings.directApiProvider === "openai-compatible") {
    addApiKeyField(
      tab,
      containerEl,
      "openai-compatible",
      "API key",
      "OpenAI or OpenRouter API key.",
      "sk-..."
    );
    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("Endpoint URL (e.g. https://api.openai.com/v1 or https://openrouter.ai/api/v1).")
      .addText((text) =>
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(plugin.settings.openaiBaseUrl)
          .onChange(async (val) => {
            plugin.settings.openaiBaseUrl = val.trim();
            await plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName("Model")
      .setDesc("Model ID (e.g. gpt-4o, claude-sonnet-5).")
      .addText((text) =>
        text
          .setPlaceholder("gpt-4o")
          .setValue(plugin.settings.openaiModel)
          .onChange(async (val) => {
            plugin.settings.openaiModel = val.trim();
            await plugin.saveSettings();
          })
      );
  }
}

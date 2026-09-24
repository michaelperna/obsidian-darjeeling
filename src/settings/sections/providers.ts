import { Setting } from "obsidian";
import type { DarjeelingSettingTab } from "../tab";
import type { DirectApiProvider } from "../schema";

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
    new Setting(containerEl)
      .setName("DeepSeek API key")
      .setDesc("DeepSeek official platform API key (sk-...).")
      .addText((text) => {
        text
          .setPlaceholder("sk-...")
          .setValue(plugin.settings.deepseekApiKey)
          .onChange(async (val) => {
            plugin.settings.deepseekApiKey = val.trim();
            await plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

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
    new Setting(containerEl)
      .setName("Gemini API key")
      .setDesc("Google AI Studio API key. Direct, ultra-fast, massive vault context.")
      .addText((text) => {
        text
          .setPlaceholder("AIzaSy...")
          .setValue(plugin.settings.geminiApiKey)
          .onChange(async (val) => {
            plugin.settings.geminiApiKey = val.trim();
            await plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });
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
    new Setting(containerEl)
      .setName("Anthropic API key")
      .setDesc("Anthropic API key for direct Claude calls.")
      .addText((text) => {
        text
          .setPlaceholder("sk-ant-api03-...")
          .setValue(plugin.settings.anthropicApiKey)
          .onChange(async (val) => {
            plugin.settings.anthropicApiKey = val.trim();
            await plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });
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
    new Setting(containerEl)
      .setName("API key")
      .setDesc("OpenAI or OpenRouter API key.")
      .addText((text) => {
        text
          .setPlaceholder("sk-...")
          .setValue(plugin.settings.openaiApiKey)
          .onChange(async (val) => {
            plugin.settings.openaiApiKey = val.trim();
            await plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });
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

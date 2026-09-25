import { Notice, Platform, setIcon } from "obsidian";
import { hasProviderApiKey } from "../../settings/secrets";
import type { DarjeelingChat } from "./chatView";
import { setDeviceRuntime } from "../../runtime/router";

interface AppWithSetting {
  setting?: {
    open?(): void;
    openTabById?(id: string): void;
  };
}

export function showRemoteOfflineCard(chat: DarjeelingChat, originalText: string): void {
  const messagesEl = chat.getMessagesEl();
  if (!messagesEl) return;
  const plugin = chat.getPlugin();
  const host = plugin.settings.meshnetHost?.trim() || "";
  const port = plugin.settings.port || 8765;

  const wrap = messagesEl.createDiv({ cls: "dj-remote-offline-card is-error" });

  const head = wrap.createDiv({ cls: "dj-offline-head" });
  const iconSpan = head.createSpan({ cls: "dj-offline-icon" });
  setIcon(iconSpan, "alert-circle");

  const isConfigured = Boolean(host);
  head.createSpan({
    cls: "dj-offline-title",
    text: isConfigured
      ? `Remote Host Unreachable (${host}:${port})`
      : "Remote Host Not Configured",
  });

  const body = wrap.createDiv({ cls: "dj-offline-body" });
  body.createEl("p", {
    text: isConfigured
      ? "The remote Darjeeling daemon is offline or not responding. Check that the server daemon is running and reachable on the network."
      : "No remote server address has been configured. Configure a remote host in Settings to connect.",
  });

  const actions = wrap.createDiv({ cls: "dj-offline-actions" });

  if (isConfigured) {
    const retryBtn = actions.createEl("button", {
      cls: "dj-btn dj-btn-sm",
    });
    const retryIcon = retryBtn.createSpan({ cls: "dj-btn-icon-prefix" });
    setIcon(retryIcon, "refresh-cw");
    retryBtn.createSpan({ text: "Retry Connection" });
    retryBtn.addEventListener("click", () => {
      wrap.remove();
      chat.getClient().connect();
      new Notice(`Reconnecting to ${host}:${port}...`);
    });
  } else {
    const setupBtn = actions.createEl("button", {
      cls: "dj-btn dj-btn-sm dj-btn-accent",
    });
    const setupIcon = setupBtn.createSpan({ cls: "dj-btn-icon-prefix" });
    setIcon(setupIcon, "settings");
    setupBtn.createSpan({ text: "Open Settings" });
    setupBtn.addEventListener("click", () => {
      wrap.remove();
      const appWithSetting = plugin.app as unknown as AppWithSetting;
      appWithSetting.setting?.open?.();
      appWithSetting.setting?.openTabById?.(plugin.manifest.id);
    });
  }

  // Check if Direct API is configured
  const activeProv = plugin.settings.directApiProvider || plugin.settings.activeProvider || "gemini";
  const hasDirectApiKey =
    activeProv === "ollama" ||
    hasProviderApiKey(plugin.secretStorage, plugin.settings, activeProv);

  const directBtn = actions.createEl("button", {
    cls: "dj-btn dj-btn-sm",
  });
  const directIcon = directBtn.createSpan({ cls: "dj-btn-icon-prefix" });
  setIcon(directIcon, "zap");
  directBtn.createSpan({ text: "Switch to Direct API" });
  directBtn.addEventListener("click", () => {
    void (async () => {
      if (!hasDirectApiKey) {
        new Notice("Direct API is not configured. Please add an API key in settings.");
        const appWithSetting = plugin.app as unknown as AppWithSetting;
        appWithSetting.setting?.open?.();
        appWithSetting.setting?.openTabById?.(plugin.manifest.id);
        return;
      }

      wrap.remove();
      setDeviceRuntime(plugin.app, plugin.settings, "direct-api");
      await plugin.saveSettings();
      chat.getClient().updateSettings(plugin.settings);
      chat.getView()?.updateRuntimeChip();
      chat.getView()?.updateModelChip();
      chat.getView()?.populateHostOptions();
      new Notice("Switched to Direct API mode.");

      if (originalText && originalText !== "New Session") {
        // Per Task 6: Ask before re-sending prompt to a cloud provider
        new Notice("Prompt restored. Press send to run with Direct API.");
        const chatInput = messagesEl.ownerDocument.querySelector<HTMLTextAreaElement>(
          ".dj-chat-input-textarea"
        );
        if (chatInput) {
          chatInput.value = originalText;
          chatInput.focus();
        }
      } else {
        chat.newConversation();
      }
    })();
  });

  if (Platform.isDesktop) {
    const localBtn = actions.createEl("button", {
      cls: "dj-btn dj-btn-sm",
    });
    const localIcon = localBtn.createSpan({ cls: "dj-btn-icon-prefix" });
    setIcon(localIcon, "laptop");
    localBtn.createSpan({ text: "Switch to Local Machine" });
    localBtn.addEventListener("click", () => {
      void (async () => {
        wrap.remove();
        setDeviceRuntime(plugin.app, plugin.settings, "local");
        await plugin.saveSettings();
        chat.getClient().updateSettings(plugin.settings);
        chat.getView()?.updateRuntimeChip();
        chat.getView()?.updateModelChip();
        chat.getView()?.populateHostOptions();
        new Notice("Switched to Local Machine mode.");
        if (originalText && originalText !== "New Session") {
          void chat.executeTurn(originalText);
        } else {
          chat.newConversation();
        }
      })();
    });
  }
}

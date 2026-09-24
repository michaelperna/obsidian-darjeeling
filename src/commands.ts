import { Editor, MarkdownFileInfo, MarkdownView, Notice } from "obsidian";
import type DarjeelingPlugin from "./main";
import type { ViewMode } from "./settings/schema";
import { DarjeelingOnboardingModal } from "./ui/onboarding/onboardingModal";
import { DarjeelingNewSessionModal } from "./ui/modals/newSessionModal";
import { DarjeelingPairModal } from "./ui/onboarding/pairModal";
import { confirmBypassMode, isBypassConfirmedForConversation } from "./ui/modals/confirm";

const VALID_MODES: Set<string> = new Set(["chat", "plan", "terminal", "host"]);

export function registerCommands(plugin: DarjeelingPlugin): void {
  plugin.registerObsidianProtocolHandler("darjeeling", (params) => {
    if (params.action === "pair") {
      void (async () => {
        await plugin.activate("chat");
        const view = Array.from(plugin.views)[0];
        if (view) {
          view.renderOnboarding(
            params.url && params.code ? "s2b_confirm" : "s2_pair",
            params.url,
            params.code
          );
        } else {
          new DarjeelingPairModal(plugin.app, plugin, {
            url: params.url,
            code: params.code,
          }).open();
        }
      })();
      return;
    }

    const rawMode = params.tab || params.mode || "chat";
    const mode = (VALID_MODES.has(rawMode) ? rawMode : "chat") as ViewMode;
    void plugin.activate(mode);
  });

  plugin.addCommand({
    id: "pair-device",
    name: "Pair with server",
    callback: () => {
      new DarjeelingPairModal(plugin.app, plugin).open();
    },
  });

  plugin.addCommand({
    id: "open",
    name: "Open",
    callback: () => void plugin.activate(),
  });

  plugin.addCommand({
    id: "open-main-panel",
    name: "Open in new tab",
    callback: () => void plugin.openInMainPanel(),
  });

  plugin.addCommand({
    id: "open-sidebar",
    name: "Open in right sidebar",
    callback: () => void plugin.openInRightSidebar(),
  });

  plugin.addCommand({
    id: "open-plan",
    name: "Open plan panel",
    callback: () => void plugin.activate("plan"),
  });

  plugin.addCommand({
    id: "export-plan-canvas",
    name: "Export active plan to Canvas",
    checkCallback: (checking: boolean) => {
      if (checking) {
        return !!plugin.plan;
      }
      void plugin.plan?.exportToCanvas();
      return true;
    },
  });

  plugin.addCommand({
    id: "insert-plan-note",
    name: "Insert active plan into note",
    checkCallback: (checking: boolean) => {
      const activeFile = plugin.app.workspace.getActiveFile();
      if (checking) {
        return !!(plugin.plan && activeFile);
      }
      if (!plugin.plan) {
        new Notice("Plan panel not initialized. Open Darjeeling first.");
        return true;
      }
      void plugin.plan.insertPlanIntoActiveNote();
      return true;
    },
  });

  plugin.addCommand({
    id: "export-conversation",
    name: "Export conversation to Markdown",
    checkCallback: (checking: boolean) => {
      if (checking) {
        return !!plugin.chat;
      }
      void plugin.chat?.exportConversationToMarkdown();
      return true;
    },
  });

  plugin.addCommand({
    id: "open-terminal",
    name: "Open terminal",
    callback: () => void plugin.activate("terminal"),
  });

  plugin.addCommand({
    id: "open-host",
    name: "Open host dashboard",
    callback: () => void plugin.activate("host"),
  });

  plugin.addCommand({
    id: "new-conversation",
    name: "New conversation",
    callback: () => {
      const view = Array.from(plugin.views)[0];
      if (view) {
        view.startNewSessionWithHostPrompt();
      } else {
        plugin.chat?.newConversation();
        new Notice("Started a new agent conversation.");
      }
    },
  });

  plugin.addCommand({
    id: "select-host",
    name: "Select host / runtime",
    callback: () => {
      new DarjeelingNewSessionModal(plugin.app, plugin, (target) => {
        void (async () => {
          await plugin.activate("chat");
          const view = Array.from(plugin.views)[0];
          if (view) {
            view.chat?.showSessionStarting(target);
            await view.applyHostSelection(target);
            if (target.mode === "remote" && plugin.agentClient.connectionState !== "open") {
              view.chat?.showRemoteOfflineCard("New Session");
            } else {
              view.chat?.newConversation();
            }
            view.chat?.focus();
          }
        })();
      }).open();
    },
  });

  plugin.addCommand({
    id: "chat-with-active-note",
    name: "Chat with active note",
    checkCallback: (checking: boolean) => {
      const file = plugin.app.workspace.getActiveFile();
      if (checking) {
        return !!file;
      }
      if (!file) {
        new Notice("No active note to chat with.");
        return true;
      }
      void (async () => {
        const content = await plugin.app.vault.read(file);
        const preview =
          content.length > 8000 ? `${content.slice(0, 8000)}\n\n[... truncated ...]` : content;
        await plugin.activate("chat");
        plugin.chat?.prefill(
          `Regarding [[${file.basename}]]:\n\n\`\`\`markdown\n${preview}\n\`\`\`\n\n`
        );
      })();
      return true;
    },
  });

  plugin.addCommand({
    id: "insert-last-response",
    name: "Insert last AI response into note",
    checkCallback: (checking: boolean) => {
      const activeFile = plugin.app.workspace.getActiveFile();
      const text = plugin.chat?.getLastAssistantMessage();
      if (checking) {
        return !!(activeFile && text);
      }
      if (!text) {
        new Notice("No AI response available to insert.");
        return true;
      }
      void plugin.insertTextIntoActiveNote(text, plugin.chat?.getAttachedNote());
      return true;
    },
  });

  plugin.addCommand({
    id: "save-chat-transcript",
    name: "Save chat transcript to new note",
    checkCallback: (checking: boolean) => {
      const md = plugin.chat?.getTranscriptMarkdown();
      if (checking) {
        return !!md;
      }
      if (!md) {
        new Notice("No chat messages to save.");
        return true;
      }
      const date = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `Darjeeling - Chat ${date}.md`;
      void (async () => {
        try {
          const file = await plugin.app.vault.create(
            filename,
            `# Darjeeling Conversation (${date})\n\n${md}`
          );
          const leaf = plugin.app.workspace.getLeaf(false);
          await leaf.openFile(file);
          new Notice(`Saved conversation to ${filename}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          new Notice(`Failed to save note: ${msg}`);
        }
      })();
      return true;
    },
  });

  plugin.addCommand({
    id: "push-active-note",
    name: "Push active note to host",
    checkCallback: (checking: boolean) => {
      const file = plugin.app.workspace.getActiveFile();
      if (checking) {
        return !!file;
      }
      if (!file) {
        new Notice("No active note.");
        return true;
      }
      void (async () => {
        const ok = await plugin.sessionManager.pushFile(file, plugin.app.vault);
        new Notice(ok ? `Pushed ${file.name}` : `Failed to push ${file.name}`);
      })();
      return true;
    },
  });

  plugin.addCommand({
    id: "send-selection",
    name: "Send selection to agent",
    editorCheckCallback: (checking: boolean, editor: Editor, _view: MarkdownView | MarkdownFileInfo) => {
      const selection = editor.getSelection().trim();
      if (checking) {
        return !!selection;
      }
      if (!selection) {
        new Notice("Nothing selected.");
        return true;
      }
      void (async () => {
        await plugin.activate("chat");
        plugin.chat?.prefill(selection);
      })();
      return true;
    },
  });

  // Model controls, reachable from the command palette so they work on mobile.
  plugin.addCommand({
    id: "cycle-model",
    name: "Cycle model",
    callback: async () => {
      const spec = plugin.availableAgents.find((a) => a.key === plugin.settings.agent);
      const models = spec?.models ?? [];
      if (models.length < 2) {
        new Notice("Run diagnostics to discover the host's models first.");
        return;
      }
      const index = models.findIndex((m) => m.id === plugin.settings.model);
      const next = models[(index + 1) % models.length];
      plugin.settings.model = next.id;
      await plugin.saveSettings();
      plugin.refreshModelControls();
      new Notice(`Model: ${next.label}`);
    },
  });

  plugin.addCommand({
    id: "cycle-permission-mode",
    name: "Cycle permission mode",
    callback: async () => {
      const spec = plugin.availableAgents.find((a) => a.key === plugin.settings.agent);
      const modes = spec?.permissionModes ?? [];
      if (!modes.length) return;
      const index = modes.findIndex((m) => m.id === plugin.settings.permissionMode);
      let next = modes[(index + 1) % modes.length];

      if (next.id === "bypassPermissions") {
        const view = Array.from(plugin.views)[0];
        const convId = view?.chat?.getActiveConversationId?.();
        const confirmed = isBypassConfirmedForConversation(convId);
        if (!confirmed) {
          const ok = await confirmBypassMode(plugin.app, convId);
          if (!ok) {
            // Do not land on bypass without confirm; advance to the next mode
            const nextIdx = (modes.indexOf(next) + 1) % modes.length;
            next = modes[nextIdx];
          }
        }
      }

      plugin.settings.permissionMode = next.id;
      await plugin.saveSettings();
      plugin.refreshModelControls();
      new Notice(`Permission mode: ${next.label}`);
    },
  });

  plugin.addCommand({
    id: "show-onboarding",
    name: "Show setup and onboarding guide",
    callback: () => {
      void (async () => {
        await plugin.activate("chat");
        const view = Array.from(plugin.views)[0];
        if (view) {
          view.renderOnboarding("s0_welcome");
        } else {
          new DarjeelingOnboardingModal(plugin.app, plugin).open();
        }
      })();
    },
  });

  plugin.addCommand({
    id: "show-conversations",
    name: "Show conversations",
    callback: () => {
      const view = Array.from(plugin.views)[0];
      if (view) {
        view.showConversationsSheet();
      } else {
        void (async () => {
          await plugin.activate("chat");
          const v = Array.from(plugin.views)[0];
          v?.showConversationsSheet();
        })();
      }
    },
  });
}

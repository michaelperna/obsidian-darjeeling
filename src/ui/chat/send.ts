import { FileSystemAdapter, Notice, TFile, setIcon } from "obsidian";
import type { DarjeelingChat } from "./chatView";
import type { LiveTurn } from "./render";
import {
  sanitizeModelForHarness,
  setModelForHarness,
} from "../../models/registry";
import { clampToSupported } from "../../models/permissions";
import { isBypassConfirmedForConversation } from "../modals/confirm";
import { getAgentPermissionModes } from "../../runtime/agents";
import {
  formatLinkedNotesForRuntime,
  getContextNote,
  getLinkedNotes,
  readContextNoteWithCap,
} from "../../vault/context";
import { pushFileWithGuard } from "../../vault/sync";

export interface QueuedTurn {
  id: string;
  text: string;
  bubble: LiveTurn;
  badgeEl?: HTMLElement | null;
  cancelBtn?: HTMLElement | null;
  targetFile?: TFile | null;
  modeOverride?: string | null;
}

export class TurnDispatcher {
  private queuedTurns: QueuedTurn[] = [];
  private lastClearedTurns: QueuedTurn[] = [];
  private isQueuePaused = false;
  private isPreparing = false;
  private abortPreparation = false;
  private queueBarEl: HTMLElement | null = null;
  private requestedModel = "";
  private warnedSubstitutions = new Set<string>();

  constructor(private chat: DarjeelingChat) {}

  getQueuedCount(): number {
    return this.queuedTurns.length;
  }

  isPaused(): boolean {
    return this.isQueuePaused;
  }

  pauseQueue(): void {
    if (this.queuedTurns.length > 0) {
      this.isQueuePaused = true;
      this.updateQueueIndicator();
    }
  }

  resumeQueue(): void {
    this.isQueuePaused = false;
    this.updateQueueIndicator();
    void this.drainNextQueuedTurn();
  }

  abortActivePreparation(): boolean {
    if (this.isPreparing) {
      this.abortPreparation = true;
      return true;
    }
    return false;
  }

  editFirstQueued(): void {
    if (this.queuedTurns.length === 0) return;
    const first = this.queuedTurns.shift();
    if (!first) return;

    first.bubble.bubbleEl.remove();
    this.updateQueueIndicator();

    const inputEl = this.chat.getInputEl();
    if (inputEl) {
      inputEl.value = first.text;
      inputEl.focus();
      inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
      this.chat.growInput();
    }
    new Notice("Queued message loaded into composer for editing.");
  }

  clearQueue(): QueuedTurn[] {
    const turns = [...this.queuedTurns];
    for (const q of turns) {
      q.bubble?.bubbleEl?.remove?.();
    }
    this.lastClearedTurns = turns;
    this.queuedTurns = [];
    this.updateQueueIndicator();
    return turns;
  }

  undoClearQueue(): void {
    if (this.lastClearedTurns.length === 0) {
      new Notice("No cleared messages to restore.");
      return;
    }
    const messagesEl = this.chat.getMessagesEl();
    for (const q of this.lastClearedTurns) {
      if (messagesEl && q.bubble?.bubbleEl) {
        messagesEl.appendChild(q.bubble.bubbleEl);
      }
      this.queuedTurns.push(q);
    }
    this.lastClearedTurns = [];
    this.updateQueueIndicator();
    new Notice("Queue restored.");
  }

  async enqueueTurn(text: string): Promise<void> {
    const targetFile = this.chat.getAttachChecked() ? this.chat.getAttachedNote() : null;
    const userTurn = this.chat.createBubble("user", "You", targetFile);
    userTurn.text = text;
    await this.chat.paintTurn(userTurn);
    userTurn.bubbleEl.addClass("is-queued");

    const head = userTurn.bubbleEl.querySelector<HTMLElement>(".dj-msg-head");
    let badgeEl: HTMLElement | null = null;
    let cancelBtn: HTMLElement | null = null;
    const turnId = `queue_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    if (head) {
      badgeEl = head.createSpan({ cls: "dj-msg-badge is-queued" });
      const badgeIcon = badgeEl.createSpan({ cls: "dj-queued-badge-icon" });
      setIcon(badgeIcon, "clock");
      badgeEl.createSpan({ text: "Queued" });

      cancelBtn = head.createEl("button", {
        cls: "dj-queued-cancel-btn",
        attr: { "aria-label": "Cancel queued message", title: "Cancel queued message" },
      });
      setIcon(cancelBtn, "x");
      cancelBtn.addEventListener("click", () => {
        this.cancelQueuedTurn(turnId);
      });
    }

    this.chat.scroll();

    const modeOverride = this.chat.getModeOverride();
    this.chat.setModeOverride(null);

    this.queuedTurns.push({
      id: turnId,
      text,
      bubble: userTurn,
      badgeEl,
      cancelBtn,
      targetFile,
      modeOverride,
    });

    this.updateQueueIndicator();
    new Notice("Message queued — will execute after current turn.");
  }

  cancelQueuedTurn(turnId: string): void {
    const idx = this.queuedTurns.findIndex((q) => q.id === turnId);
    if (idx !== -1) {
      const [item] = this.queuedTurns.splice(idx, 1);
      item.bubble.bubbleEl.remove();
      this.updateQueueIndicator();
      new Notice("Queued message cancelled.");
    }
  }

  updateQueueIndicator(): void {
    const hostEl = this.chat.getHostEl();
    if (!hostEl) return;

    if (this.queuedTurns.length === 0) {
      if (this.queueBarEl) {
        this.queueBarEl.remove();
        this.queueBarEl = null;
      }
      return;
    }

    if (!this.queueBarEl) {
      const composer = hostEl.querySelector<HTMLElement>(".dj-composer-island");
      if (composer) {
        this.queueBarEl = composer.createDiv({ cls: "dj-queue-indicator" });
        if (typeof composer.prepend === "function") {
          composer.prepend(this.queueBarEl);
        } else if (composer.firstChild && composer.firstChild !== this.queueBarEl) {
          composer.insertBefore(this.queueBarEl, composer.firstChild);
        }
      }
    }

    if (!this.queueBarEl) return;
    this.queueBarEl.empty();

    const count = this.queuedTurns.length;
    const icon = this.queueBarEl.createSpan({ cls: "dj-queue-icon" });

    if (this.isQueuePaused) {
      setIcon(icon, "pause-circle");
      this.queueBarEl.createSpan({
        cls: "dj-queue-text is-paused",
        text: `Queue paused: ${count} message${count > 1 ? "s" : ""}`,
      });

      const btnGroup = this.queueBarEl.createDiv({ cls: "dj-queue-btn-group" });

      const resumeBtn = btnGroup.createEl("button", {
        cls: "dj-queue-btn dj-btn dj-btn-xs dj-btn-accent",
        text: "Resume",
      });
      resumeBtn.addEventListener("click", () => this.resumeQueue());

      const editBtn = btnGroup.createEl("button", {
        cls: "dj-queue-btn dj-btn dj-btn-xs",
        text: "Edit",
      });
      editBtn.addEventListener("click", () => this.editFirstQueued());

      const clearBtn = btnGroup.createEl("button", {
        cls: "dj-queue-btn dj-btn dj-btn-xs dj-btn-ghost",
        text: "Clear",
      });
      clearBtn.addEventListener("click", () => {
        this.clearQueue();
        const noticeFragment = document.createDocumentFragment();
        noticeFragment.appendChild(document.createTextNode("Queue cleared. "));
        const undoLink = document.createElement("a");
        undoLink.textContent = "Undo";
        undoLink.className = "dj-undo-link";
        undoLink.onclick = () => this.undoClearQueue();
        noticeFragment.appendChild(undoLink);
        new Notice(noticeFragment, 5000);
      });
    } else {
      setIcon(icon, "clock");
      this.queueBarEl.createSpan({
        cls: "dj-queue-text",
        text: `${count} message${count > 1 ? "s" : ""} queued — will execute automatically`,
      });

      const clearBtn = this.queueBarEl.createEl("button", {
        cls: "dj-queue-clear-btn",
        text: "Clear",
      });
      clearBtn.addEventListener("click", () => {
        this.clearQueue();
        const noticeFragment = document.createDocumentFragment();
        noticeFragment.appendChild(document.createTextNode("Queue cleared. "));
        const undoLink = document.createElement("a");
        undoLink.textContent = "Undo";
        undoLink.className = "dj-undo-link";
        undoLink.onclick = () => this.undoClearQueue();
        noticeFragment.appendChild(undoLink);
        new Notice(noticeFragment, 5000);
      });
    }
  }

  async drainNextQueuedTurn(): Promise<void> {
    if (this.isQueuePaused) return;
    if (this.queuedTurns.length === 0) return;
    if (this.chat.isBusy()) return;

    let waits = 0;
    while (this.chat.isBusy() && waits < 15) {
      await new Promise((r) => window.setTimeout(r, 50));
      waits++;
    }
    if (this.chat.isBusy() || this.isQueuePaused) return;

    const next = this.queuedTurns.shift();
    if (!next) return;

    this.updateQueueIndicator();

    next.bubble.bubbleEl.removeClass("is-queued");
    next.badgeEl?.remove();
    next.cancelBtn?.remove();

    await this.executeTurn(next.text, next.bubble, next.targetFile, next.modeOverride);
  }

  async executeTurn(
    text: string,
    existingUserBubble?: LiveTurn,
    overrideFile?: TFile | null,
    modeOverride?: string | null
  ): Promise<void> {
    this.chat.syncActiveEpoch();
    this.isPreparing = true;
    this.abortPreparation = false;

    try {
      const emptyHero = this.chat.getMessagesEl()?.querySelector(".dj-empty-hero");
      if (emptyHero) emptyHero.remove();

      const plugin = this.chat.getPlugin();
      const client = this.chat.getClient();
      const mode = client.getEffectiveRuntimeMode();

      const noteToAttach =
        overrideFile !== undefined
          ? (overrideFile?.extension === "md" ? overrideFile : null)
          : (this.chat.getAttachChecked() ? getContextNote(plugin.app, this.chat.getAttachedNote()) : null);

      // Append user bubble first so thinking indicator is below it (CHAT-40)
      if (!existingUserBubble) {
        const userTurn = this.chat.createBubble("user", "You", noteToAttach);
        userTurn.text = text;
        await this.chat.paintTurn(userTurn);
        this.chat.scroll();
      } else {
        this.chat.scroll();
      }

      // Check preparation abort flag (CHAT-46)
      if (this.abortPreparation) {
        this.isPreparing = false;
        new Notice("Turn cancelled before preparation completed.");
        return;
      }

      // Now set busy and show thinking indicator strictly below user message
      this.chat.setBusy(true);

      if (mode === "remote") {
        if (client.connectionState !== "open") {
          client.connect();
          let wait = 0;
          while ((client.connectionState as string) === "connecting" && wait < 25) {
            if (this.abortPreparation) {
              this.isPreparing = false;
              this.chat.setBusy(false);
              return;
            }
            await new Promise((r) => window.setTimeout(r, 100));
            wait++;
          }
          if ((client.connectionState as string) !== "open") {
            this.chat.setBusy(false);
            this.isPreparing = false;
            if (client.connectionState === "unauthorized") {
              this.chat.onError("Authentication failed: token rejected by host (close 4401).");
            } else {
              this.chat.showRemoteOfflineCard(text);
            }
            return;
          }
        }
      } else if (client.connectionState !== "open") {
        client.connect();
      }

      if (this.abortPreparation) {
        this.isPreparing = false;
        this.chat.setBusy(false);
        new Notice("Turn cancelled.");
        return;
      }

      let prompt = text;

      // Resolve [[wikilinks]] and @note references in the prompt
      const wikilinkMatches = Array.from(text.matchAll(/\[\[(.*?)\]\]/g));
      const atMatches = Array.from(text.matchAll(/(?:^|\s)@([^\s]+\.md)/g));

      const referencedFiles = new Set<TFile>();
      for (const match of wikilinkMatches) {
        const linkTarget = match[1].split("|")[0].split("#")[0].trim();
        const dest = plugin.app.metadataCache.getFirstLinkpathDest(linkTarget, "");
        if (dest instanceof TFile) referencedFiles.add(dest);
      }
      for (const match of atMatches) {
        const linkTarget = match[1].trim();
        const dest =
          plugin.app.metadataCache.getFirstLinkpathDest(linkTarget, "") ||
          plugin.app.vault.getAbstractFileByPath(linkTarget);
        if (dest instanceof TFile) referencedFiles.add(dest);
      }

      if (referencedFiles.size > 0) {
        let injectedContext = "\n\n### Referenced Vault Notes:\n";
        for (const refFile of referencedFiles) {
          if (this.abortPreparation) {
            this.isPreparing = false;
            this.chat.setBusy(false);
            return;
          }
          try {
            const content = await plugin.app.vault.read(refFile);
            const limit = 16000;
            const snippet =
              content.length > limit
                ? `${content.slice(0, limit)}\n[... truncated ${content.length - limit} chars ...]`
                : content;
            injectedContext += `\n<vault_note path="${refFile.path}" name="${refFile.basename}">\n${snippet}\n</vault_note>\n`;
          } catch (err) {
            console.warn(`Could not read referenced note ${refFile.path}:`, err);
          }
        }
        prompt += injectedContext;
      }

      if (noteToAttach) {
        try {
          const { content } = await readContextNoteWithCap(plugin.app, noteToAttach, 32768);
          const header = `Active Note: ${noteToAttach.path}\n---\n`;
          prompt = `${header}${content}\n\n---\nUser Request: ${prompt}`;

          if (mode === "remote") {
            const pushRes = await pushFileWithGuard(
              plugin.app,
              noteToAttach,
              client,
              plugin.deviceStore
            );
            if (pushRes.conflict) {
              prompt += `\n\n[System Note: The host copy of "${noteToAttach.path}" was modified on the server. Agent is directed to refer to the host version.]`;
            } else if (!pushRes.ok && pushRes.error !== "binary_refused") {
              this.chat.systemNotice(
                `Could not push \`${noteToAttach.path}\` to the host, so the agent may be reading a stale copy.`
              );
            }
          }

          // Linked notes per ADR-14 (G-33, CHAT-22)
          const linked = getLinkedNotes(plugin.app, noteToAttach);
          if (linked.length > 0) {
            const linkedText = await formatLinkedNotesForRuntime(
              plugin.app,
              linked,
              mode === "direct-api",
              !!plugin.settings.includeLinkedNotes
            );
            if (linkedText) {
              prompt += `\n\n${linkedText}`;
            }
          }
        } catch (err) {
          console.warn(`Could not read active note ${noteToAttach.path}:`, err);
        }
      }

      if (this.abortPreparation) {
        this.isPreparing = false;
        this.chat.setBusy(false);
        new Notice("Turn cancelled.");
        return;
      }

      const settings = plugin.settings;
      const harness =
        mode === "direct-api"
          ? settings.directApiProvider === "openai-compatible"
            ? "deepseek"
            : settings.directApiProvider
          : settings.agent || "agy";
      const sanitizedModel = sanitizeModelForHarness(harness, settings.model);
      if (sanitizedModel !== settings.model) {
        settings.model = sanitizedModel;
        setModelForHarness(settings, harness, sanitizedModel);
        void plugin.saveSettings();
      }
      this.requestedModel = sanitizedModel;

      let localVaultPath = "";
      if (plugin.app.vault.adapter instanceof FileSystemAdapter) {
        localVaultPath = plugin.app.vault.adapter.getBasePath();
      }
      const targetCwd =
        mode === "remote" ? (settings.remoteCwd || undefined) : (localVaultPath || undefined);

      const activeFile = noteToAttach || plugin.app.workspace.getActiveFile();
      const vaultHarness = this.chat.getVaultHarness();
      vaultHarness.updateSettings(settings);
      const harnessResult = await vaultHarness.loadHarness(
        activeFile ? activeFile.path : undefined,
        mode === "direct-api"
      );
      const appendPrompt = harnessResult.systemPrompt;

      let effectivePermissionMode =
        modeOverride ?? this.chat.getModeOverride() ?? settings.permissionMode;

      const conversationId = this.chat.getActiveConversationId?.() || client.getSessionId?.();
      if (effectivePermissionMode === "bypassPermissions" && !isBypassConfirmedForConversation(conversationId)) {
        effectivePermissionMode = "plan";
      } else {
        const supported = getAgentPermissionModes(settings.agent);
        effectivePermissionMode = clampToSupported(effectivePermissionMode, supported);
      }

      // Check right before network dispatch (CHAT-46)
      if (this.abortPreparation) {
        this.isPreparing = false;
        this.chat.setBusy(false);
        new Notice("Turn cancelled before dispatch.");
        return;
      }
      this.isPreparing = false;

      const sent = await client.sendTurn({
        agent: settings.agent,
        prompt,
        model: sanitizedModel || undefined,
        fallback_model: settings.fallbackModel || undefined,
        effort: settings.effort || undefined,
        permission_mode: effectivePermissionMode,
        cwd: targetCwd,
        append_system_prompt: appendPrompt || undefined,
        partial_messages: settings.partialMessages,
      });

      this.chat.setModeOverride(null);
      if (sent) {
        this.chat.setBusy(true);
      } else {
        this.chat.setBusy(false);
        const offlineChecker = client as { isOffline?: () => boolean };
        const isOffline = typeof offlineChecker.isOffline === "function" ? offlineChecker.isOffline() : false;
        if (mode === "remote" && (client.connectionState !== "open" || isOffline)) {
          this.chat.showRemoteOfflineCard(text);
        }
      }
    } catch (err) {
      this.isPreparing = false;
      this.chat.setBusy(false);
      this.chat.setModeOverride(null);
      console.error("[Darjeeling] Turn execution error:", err);
      this.chat.errorNote(err instanceof Error ? err.message : String(err));
    }
  }

  checkModelSubstitution(asked: string, got?: string): void {
    if (
      asked &&
      got &&
      asked !== got &&
      !this.warnedSubstitutions.has(`${asked}->${got}`)
    ) {
      this.warnedSubstitutions.add(`${asked}->${got}`);
      this.chat.systemNotice(
        `**Model substituted.** You asked for \`${asked}\`; the host ran ` +
          `\`${got}\`. That model ID was mapped or fallen back to by the runner.\n\n` +
          `Run *Probe models* in settings to see which IDs are available.`
      );
    }
  }

  resetModelSubstitutions(): void {
    this.warnedSubstitutions.clear();
  }

  getRequestedModel(): string {
    return this.requestedModel;
  }
}

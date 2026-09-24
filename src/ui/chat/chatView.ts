import { Component, Notice, TFile, setIcon } from "obsidian";
import type DarjeelingPlugin from "../../main";
import type { ConversationMessage, SessionManager } from "../../net/sessionManager";
import type { DarjeelingView } from "../view";
import {
  AgentClient,
  ContentBlock,
  DjStatus,
  StreamInit,
  StreamResult,
} from "../../net/agentClient";
import { VaultHarness } from "../../vault/harness";
import { getContextNote } from "../../vault/context";
import {
  LiveTurn,
  createBubble,
  paintTurn,
  renderEmptyState,
  summariseInput,
  flattenToolResult,
  scheduleThrottledRender,
  flushPendingRender,
} from "./render";
import { buildComposer } from "./composer";
import { handleSlashCommand } from "./slashCommands";
import { showRemoteOfflineCard } from "./offlineCard";
import { exportConversationToMarkdown } from "./export";
import { TurnDispatcher } from "./send";
import { ToolDetailModal, ToolCallDetail } from "./toolSheet";
import {
  getModelForHarness,
  sanitizeModelForHarness,
} from "../../models/registry";
import { createSwirlingTeaCup } from "../illustrations";
import type { SessionTarget } from "../modals/newSessionModal";

export class DarjeelingChat extends Component {
  private plugin: DarjeelingPlugin;
  private sessions: SessionManager;
  private client: AgentClient;
  private hostEl: HTMLElement;
  private view?: DarjeelingView;

  private messagesEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private stopBtn: HTMLButtonElement | null = null;
  private attachEl: HTMLInputElement | null = null;
  private notePillEl: HTMLElement | null = null;
  private turn: LiveTurn | null = null;
  private allTurns: LiveTurn[] = [];
  private thinkingIndicatorEl: HTMLElement | null = null;
  private attachedNote: TFile | null = null;
  private jumpLatestBtn: HTMLElement | null = null;
  private lastReportedError: string | null = null;

  private isTurnActive = false;
  private modeOverride: string | null = null;
  private vaultHarness: VaultHarness;
  private dispatcher: TurnDispatcher;
  private activeTurnId: string | null = null;
  private lastProcessedSeq: number = -1;
  private conversationEpoch: number = 0;
  private activeEpoch: number = 0;
  private turnWatchdogTimer: number | null = null;

  constructor(
    plugin: DarjeelingPlugin,
    sessions: SessionManager,
    client: AgentClient,
    hostEl: HTMLElement,
    view?: DarjeelingView
  ) {
    super();
    this.plugin = plugin;
    this.sessions = sessions;
    this.client = client;
    this.hostEl = hostEl;
    this.view = view;
    this.vaultHarness = new VaultHarness(this.plugin.app, this.plugin.settings);
    this.dispatcher = new TurnDispatcher(this);
  }

  onload(): void {
    this.render();
    this.bindClient();
    this.renderEmptyState();
  }

  getPlugin(): DarjeelingPlugin {
    return this.plugin;
  }

  getSessions(): SessionManager {
    return this.sessions;
  }

  getClient(): AgentClient {
    return this.client;
  }

  getView(): DarjeelingView | undefined {
    return this.view;
  }

  getHostEl(): HTMLElement {
    return this.hostEl;
  }

  getMessagesEl(): HTMLElement | null {
    return this.messagesEl;
  }

  getInputEl(): HTMLTextAreaElement | null {
    return this.inputEl;
  }

  getVaultHarness(): VaultHarness {
    return this.vaultHarness;
  }

  getAttachedNote(): TFile | null {
    return getContextNote(this.plugin.app, this.attachedNote);
  }

  getAttachChecked(): boolean {
    return !!this.attachEl?.checked;
  }

  getModeOverride(): string | null {
    return this.modeOverride;
  }

  setModeOverride(mode: string | null): void {
    this.modeOverride = mode;
  }

  isBusy(): boolean {
    return this.isTurnActive;
  }

  setBusy(busy: boolean): void {
    this.isTurnActive = busy;
    if (this.sendBtn) this.sendBtn.disabled = busy;
    if (this.stopBtn) this.stopBtn.disabled = !busy;
    if (busy) {
      this.showThinkingIndicator();
    } else {
      this.removeThinkingIndicator();
      void this.dispatcher.drainNextQueuedTurn();
    }
  }

  public renderEmptyState(): void {
    if (this.messagesEl) {
      renderEmptyState(this, this.messagesEl);
    }
  }

  public createBubble(
    kind: "user" | "assistant" | "system" | "error",
    who: string,
    attachedNoteOverride?: TFile | null
  ): LiveTurn {
    const note = attachedNoteOverride !== undefined ? attachedNoteOverride : this.attachedNote;
    const turn = createBubble(
      this,
      this.messagesEl!,
      kind,
      who,
      note
    );
    this.allTurns.push(turn);
    return turn;
  }

  public async paintTurn(turn: LiveTurn): Promise<void> {
    await paintTurn(this, turn);
  }

  public scroll(force = false): void {
    if (!this.messagesEl) return;
    const threshold = 80;
    const isNearBottom =
      this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight <= threshold;

    if (force || isNearBottom) {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      this.hideJumpToLatest();
    } else {
      this.showJumpToLatest();
    }
  }

  private showJumpToLatest(): void {
    if (!this.hostEl) return;
    if (!this.jumpLatestBtn) {
      this.jumpLatestBtn = this.hostEl.createEl("button", {
        cls: "dj-jump-latest",
        attr: { "aria-label": "Jump to latest messages", title: "Jump to latest" },
      });
      const icon = this.jumpLatestBtn.createSpan({ cls: "dj-jump-icon" });
      setIcon(icon, "arrow-down");
      this.jumpLatestBtn.createSpan({ text: "Jump to latest" });
      this.jumpLatestBtn.addEventListener("click", () => {
        this.scroll(true);
      });
    }
    this.jumpLatestBtn.addClass("is-visible");
  }

  private hideJumpToLatest(): void {
    if (this.jumpLatestBtn) {
      this.jumpLatestBtn.removeClass("is-visible");
    }
  }

  public showRemoteOfflineCard(originalText: string): void {
    showRemoteOfflineCard(this, originalText);
  }

  public async exportConversationToMarkdown(): Promise<void> {
    await exportConversationToMarkdown(this, this.allTurns);
  }

  public showSessionStarting(target: SessionTarget): void {
    this.messagesEl?.empty();
    this.turn = null;
    this.allTurns = [];

    const hostLabel =
      target.mode === "local"
        ? `Local Machine (${target.agent || this.plugin.settings.agent || "agy"})`
        : target.mode === "remote"
        ? `Remote Host (${target.meshnetHost || this.plugin.settings.meshnetHost || "server"})`
        : `Direct API (${target.provider || this.plugin.settings.directApiProvider || "DeepSeek"})`;

    const harness =
      target.mode === "direct-api"
        ? target.provider || this.plugin.settings.directApiProvider || "deepseek"
        : target.agent || this.plugin.settings.agent || "agy";

    const modelLabel = sanitizeModelForHarness(
      harness,
      target.model || getModelForHarness(this.plugin.settings, harness)
    );

    const wrap = this.messagesEl?.createDiv({ cls: "dj-session-starting-card" });
    if (!wrap) return;

    const iconDiv = wrap.createDiv({ cls: "dj-starting-icon" });
    const cup = createSwirlingTeaCup(48);
    cup.setAttribute("aria-hidden", "true");
    iconDiv.appendChild(cup);

    wrap.createEl("h3", {
      cls: "dj-starting-title",
      text: `Initializing ${hostLabel}`,
    });

    wrap.createEl("p", {
      cls: "dj-starting-sub",
      text: `Connecting runtime, configuring model "${modelLabel}", and wiring vault context...`,
    });

    const progress = wrap.createDiv({ cls: "dj-starting-progress" });
    progress.createDiv({ cls: "dj-starting-bar" });
  }

  focus(): void {
    this.inputEl?.focus();
  }

  getActiveConversationId(): string | null {
    return this.plugin.settings.lastAgentSessionId || null;
  }

  public armTurnWatchdog(timeoutMs = 90000): void {
    this.clearTurnWatchdog();
    this.turnWatchdogTimer = window.setTimeout(() => {
      if (this.isBusy()) {
        console.warn("[Darjeeling] Turn watchdog timeout: 90s elapsed without response.");
        this.setBusy(false);
        this.errorNote("Execution timed out after 90 seconds with no response from the agent.");
        this.finishTurn();
        this.client.interrupt();
      }
    }, timeoutMs);
  }

  public clearTurnWatchdog(): void {
    if (this.turnWatchdogTimer !== null) {
      window.clearTimeout(this.turnWatchdogTimer);
      this.turnWatchdogTimer = null;
    }
  }

  newConversation(): void {
    this.clearTurnWatchdog();
    this.conversationEpoch++;
    if (this.isBusy()) {
      this.client.interrupt();
    }
    this.client.resetConversation();
    this.finishTurn();
    this.messagesEl?.empty();
    this.turn = null;
    this.allTurns = [];
    this.lastProcessedSeq = -1;
    this.lastReportedError = null;
    this.dispatcher.resetModelSubstitutions();
    this.dispatcher.clearQueue();
    this.renderEmptyState();
    this.focus();
  }

  growInput(): void {
    if (!this.inputEl) return;
    this.inputEl.setCssProps?.({ "--dj-input-height": "auto" });
    const next = Math.min(Math.max(this.inputEl.scrollHeight, 40), 160);
    this.inputEl.setCssProps?.({ "--dj-input-height": `${next}px` });
  }

  public prefill(text: string): void {
    if (this.inputEl) {
      this.inputEl.value = text;
      this.growInput();
      this.inputEl.focus();
    }
  }

  public getLastAssistantMessage(): string {
    for (let i = this.allTurns.length - 1; i >= 0; i--) {
      const turn = this.allTurns[i];
      if (turn.role === "assistant" && turn.text) {
        return turn.text;
      }
    }
    return "";
  }

  public getTranscriptMarkdown(): string {
    const lines: string[] = [];
    for (const turn of this.allTurns) {
      const speaker = turn.role === "user" ? "User" : "Assistant";
      lines.push(`### ${speaker}\n\n${turn.text || ""}\n`);
    }
    return lines.join("\n");
  }

  public async rehydrate(sessionId: string, messages: ConversationMessage[]): Promise<void> {
    this.plugin.settings.lastAgentSessionId = sessionId;
    await this.loadConversation(messages);
  }

  async loadConversation(messages: ConversationMessage[]): Promise<void> {
    this.conversationEpoch++;
    if (this.isBusy()) {
      this.client.interrupt();
    }
    this.finishTurn();
    this.messagesEl?.empty();
    this.turn = null;
    this.allTurns = [];
    this.lastProcessedSeq = -1;
    this.lastReportedError = null;
    this.dispatcher.clearQueue();

    if (!messages || messages.length === 0) {
      this.renderEmptyState();
      return;
    }

    const first = messages[0];
    if (first && first.session_id) {
      this.plugin.settings.lastAgentSessionId = first.session_id;
      void this.plugin.saveSettings();
    }

    const emptyHero = this.messagesEl?.querySelector(".dj-empty-hero");
    if (emptyHero) emptyHero.remove();

    for (const msg of messages) {
      if (msg.role === "user") {
        const userTurn = this.createBubble("user", "You");
        userTurn.text = msg.content || msg.text || "";
        await this.paintTurn(userTurn);
      } else if (msg.role === "assistant") {
        const asstTurn = this.createBubble(
          "assistant",
          this.plugin.agentLabel || "Assistant"
        );
        asstTurn.text = msg.content || msg.text || "";

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            this.turn = asstTurn;
            this.renderToolUse({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: tc.input,
            });
            if (tc.output !== undefined) {
              this.attachToolResult({
                type: "tool_result",
                tool_use_id: tc.id,
                content: tc.output,
                is_error: tc.is_error,
              });
            }
          }
          if (asstTurn.toolsGroupEl) {
            asstTurn.toolsGroupEl.open = false;
            const count = asstTurn.toolCallsCount || asstTurn.tools.size;
            const names = asstTurn.toolNames?.slice(0, 3).join(", ") || "tools";
            const more = (asstTurn.toolNames?.length || 0) > 3 ? "…" : "";
            const fails = asstTurn.failedToolCount ?? 0;

            if (asstTurn.toolsSummaryTitleEl) {
              asstTurn.toolsSummaryTitleEl.setText(
                `${count} tool operation${count === 1 ? "" : "s"} (${names}${more})`
              );
            }
            if (asstTurn.toolsStatusBadgeEl) {
              if (fails > 0) {
                asstTurn.toolsStatusBadgeEl.className = "dj-tools-group-badge is-fail";
                asstTurn.toolsStatusBadgeEl.setText(`${fails} failed`);
              } else {
                asstTurn.toolsStatusBadgeEl.className = "dj-tools-group-badge is-ok";
                asstTurn.toolsStatusBadgeEl.setText("Done");
              }
            }
          }
        }
        await this.paintTurn(asstTurn);
      }
    }
    this.turn = null;
    this.scroll(true);
    this.focus();
  }

  paintNotePill(): void {
    if (!this.notePillEl) return;
    this.notePillEl.empty();
    const target = this.getAttachChecked() ? this.getAttachedNote() : null;
    this.notePillEl.toggleClass("dj-pill-neutral", !target);
    const iconSpan = this.notePillEl.createSpan({ cls: "dj-pill-dot" });
    setIcon(iconSpan, target ? "file-text" : "file-question");
    this.notePillEl.createSpan({
      cls: "dj-pill-label",
      text: target ? target.basename : "No active note",
    });
  }

  showThinkingIndicator(label = "Thinking…", sub = "Preparing response…"): void {
    if (!this.messagesEl) return;
    if (this.thinkingIndicatorEl) {
      const lbl = this.thinkingIndicatorEl.querySelector<HTMLElement>(".dj-thinking-label");
      if (lbl) lbl.setText(label);
      const sb = this.thinkingIndicatorEl.querySelector<HTMLElement>(".dj-thinking-sub");
      if (sb) sb.setText(sub);
      return;
    }
    const wrap = this.messagesEl.createDiv({ cls: "dj-chat-thinking" });
    const cup = createSwirlingTeaCup(44);
    cup.setAttribute("aria-hidden", "true");
    wrap.appendChild(cup);
    const textWrap = wrap.createDiv({ cls: "dj-thinking-text" });
    textWrap.createSpan({ cls: "dj-thinking-label", text: label });
    textWrap.createSpan({ cls: "dj-thinking-sub", text: sub });
    this.thinkingIndicatorEl = wrap;
    this.scroll();
  }

  removeThinkingIndicator(): void {
    if (this.thinkingIndicatorEl) {
      this.thinkingIndicatorEl.remove();
      this.thinkingIndicatorEl = null;
    }
  }

  systemNotice(markdown: string): void {
    if (!this.messagesEl) return;
    const turn = this.createBubble("system", "Darjeeling");
    turn.text = markdown;
    void this.paintTurn(turn);
    this.scroll();
  }

  errorNote(message: string): void {
    if (!this.messagesEl) return;
    if (this.lastReportedError === message) return;
    this.lastReportedError = message;

    const turn = this.createBubble("error", "Error");
    if (message.includes("\n") || message.length > 120) {
      const summary = message.split("\n")[0].slice(0, 80);
      turn.text = `**Error:** ${summary}\n\n<details class="dj-error-details"><summary>Error details</summary>\n\n\`\`\`\n${message}\n\`\`\`\n</details>`;
    } else {
      turn.text = message;
    }
    void this.paintTurn(turn);
    this.scroll();
  }

  interrupt(): void {
    const abortedPrep = this.dispatcher.abortActivePreparation();
    this.dispatcher.pauseQueue();
    this.client.interrupt();
    this.finishTurn();
    if (abortedPrep) {
      new Notice("Turn preparation cancelled.");
    } else if (this.dispatcher.getQueuedCount() > 0) {
      new Notice(`Turn interrupted. Queue paused (${this.dispatcher.getQueuedCount()} pending).`);
    } else {
      new Notice("Interrupted.");
    }
  }

  public syncActiveEpoch(): void {
    this.activeEpoch = this.conversationEpoch;
    this.lastProcessedSeq = -1;
  }

  async send(): Promise<void> {
    if (!this.inputEl) return;
    const text = this.inputEl.value.trim();
    if (!text) return;

    this.inputEl.value = "";
    this.growInput();

    if (await handleSlashCommand(this, text)) {
      return;
    }

    if (this.isBusy()) {
      await this.dispatcher.enqueueTurn(text);
      return;
    }

    await this.executeTurn(text);
  }

  async executeTurn(text: string): Promise<void> {
    this.syncActiveEpoch();
    await this.dispatcher.executeTurn(text);
  }

  private render(): void {
    this.hostEl.empty();
    this.messagesEl = this.hostEl.createDiv({ cls: "dj-messages" });

    this.messagesEl.addEventListener("scroll", () => {
      const threshold = 80;
      const isNearBottom =
        this.messagesEl!.scrollHeight - this.messagesEl!.scrollTop - this.messagesEl!.clientHeight <= threshold;
      if (isNearBottom) {
        this.hideJumpToLatest();
      }
    });

    const composer = buildComposer(this, this.hostEl);
    this.notePillEl = composer.notePillEl;
    this.attachEl = composer.attachEl;
    this.inputEl = composer.inputEl;
    this.sendBtn = composer.sendBtn;
    this.stopBtn = composer.stopBtn;

    this.paintNotePill();

    this.registerEvent(
      this.plugin.app.workspace.on("file-open", () => this.paintNotePill())
    );
  }

  private bindClient(): void {
    const isFrameStale = (ev?: unknown) => {
      if (this.activeEpoch !== this.conversationEpoch) {
        return true;
      }
      if (ev && typeof ev === "object" && "dj_seq" in ev && typeof (ev).dj_seq === "number") {
        const seq = (ev as { dj_seq: number }).dj_seq;
        if (seq <= this.lastProcessedSeq) {
          return true; // deduplicate replayed frame
        }
        this.lastProcessedSeq = seq;
      }
      return false;
    };

    this.client.setHandlers({
      onInit: (event: StreamInit) => {
        try {
          if (isFrameStale(event)) return;
          this.onInit(event);
        } catch (err) {
          console.error("[Darjeeling] onInit error:", err);
        }
      },
      onAssistantText: (text, model) => {
        try {
          if (isFrameStale()) return;
          this.appendText(text, model);
        } catch (err) {
          console.error("[Darjeeling] onAssistantText error:", err);
        }
      },
      onThinking: (text) => {
        try {
          if (isFrameStale()) return;
          this.appendThinking(text);
        } catch (err) {
          console.error("[Darjeeling] onThinking error:", err);
        }
      },
      onToolUse: (block) => {
        try {
          if (isFrameStale()) return;
          this.renderToolUse(block);
        } catch (err) {
          console.error("[Darjeeling] onToolUse error:", err);
        }
      },
      onToolResult: (block) => {
        try {
          if (isFrameStale()) return;
          this.attachToolResult(block);
        } catch (err) {
          console.error("[Darjeeling] onToolResult error:", err);
        }
      },
      onStatus: (event: DjStatus) => {
        try {
          if (isFrameStale(event)) return;
          this.onStatus(event);
        } catch (err) {
          console.error("[Darjeeling] onStatus error:", err);
        }
      },
      onResult: (event: StreamResult) => {
        try {
          if (isFrameStale(event)) return;
          this.onResult(event);
        } catch (err) {
          console.error("[Darjeeling] onResult error:", err);
        }
      },
      onError: (message) => {
        try {
          if (isFrameStale()) return;
          this.onError(message);
        } catch (err) {
          console.error("[Darjeeling] onError error:", err);
        }
      },
      onConnectionError: (info) => {
        try {
          this.onError(info.message);
        } catch (err) {
          console.error("[Darjeeling] onConnectionError error:", err);
        }
      },
      onConnectionChange: (state) => {
        try {
          this.plugin.onConnectionState(state);
        } catch (err) {
          console.error("[Darjeeling] onConnectionChange error:", err);
        }
      },
    });
  }

  private onInit(event: StreamInit): void {
    if (event.session_id) {
      this.plugin.settings.lastAgentSessionId = event.session_id;
      void this.plugin.saveSettings();
    }
    this.plugin.setHeaderDetail(
      `${event.model ?? "model?"} · ${event.tools?.length ?? 0} tools`
    );
    this.dispatcher.checkModelSubstitution(
      this.dispatcher.getRequestedModel(),
      event.model
    );
  }

  private onStatus(event: DjStatus): void {
    if (event.state === "starting" || event.state === "running") {
      this.setBusy(true);
      return;
    }
    if (event.state === "exited") {
      this.setBusy(false);
      this.finishTurn();
      if (event.code && event.code !== 0) {
        this.errorNote(
          `Agent exited with code ${event.code}.` +
            (event.stderr ? `\n\n\`\`\`\n${event.stderr}\n\`\`\`` : "")
        );
      }
      return;
    }
    if (event.state === "interrupted") {
      this.setBusy(false);
      this.finishTurn();
    }
  }

  private onResult(event: StreamResult): void {
    if (event.session_id) {
      this.plugin.settings.lastAgentSessionId = event.session_id;
      void this.plugin.saveSettings();
    }
    if (!this.turn && event.result) {
      this.turn = this.createBubble("assistant", this.plugin.agentLabel);
      this.turn.text = event.result;
      void paintTurn(this, this.turn);
    }
    this.finishTurn();

    if (!this.turn) return;

    if (event.total_cost_usd !== undefined && event.total_cost_usd !== null) {
      this.plugin.settings.totalCostUsd =
        (this.plugin.settings.totalCostUsd || 0) + event.total_cost_usd;
      void this.plugin.saveSettings();
    }

    if (!this.turn.footerEl) return;
    this.turn.footerEl.empty();
    this.turn.footerEl.show();

    const stat = (label: string, val: string, isErr = false) => {
      const chip = this.turn!.footerEl!.createSpan({
        cls: `dj-stat-chip${isErr ? " is-error" : ""}`,
      });
      chip.createSpan({ cls: "dj-stat-chip-label", text: label });
      chip.createSpan({ cls: "dj-stat-chip-val", text: val });
    };

    const inTokens = typeof event.usage?.input_tokens === "number" ? event.usage.input_tokens : 0;
    const cachedRead = typeof event.usage?.cache_read_input_tokens === "number" ? event.usage.cache_read_input_tokens : 0;
    const cacheCreation = typeof event.usage?.cache_creation_input_tokens === "number" ? event.usage.cache_creation_input_tokens : 0;
    const totalIn = inTokens + cachedRead + cacheCreation;

    if (typeof event.duration_ms === "number" && !Number.isNaN(event.duration_ms) && event.duration_ms > 0) {
      stat("time", `${(event.duration_ms / 1000).toFixed(1)}s`);
    }
    if (totalIn > 0) {
      if (cachedRead > 0 || cacheCreation > 0) {
        stat("in", `${totalIn.toLocaleString()} (${inTokens.toLocaleString()} fresh)`);
      } else {
        stat("in", totalIn.toLocaleString());
      }
    }
    if (cachedRead > 0) {
      stat("cached", cachedRead.toLocaleString());
    }
    if (typeof event.usage?.output_tokens === "number" && event.usage.output_tokens > 0) {
      stat("out", event.usage.output_tokens.toLocaleString());
    }
    if (typeof event.total_cost_usd === "number" && !Number.isNaN(event.total_cost_usd)) {
      stat("cost", `$${event.total_cost_usd.toFixed(4)}`);
    }
    if (typeof event.num_turns === "number") {
      stat("turns", String(event.num_turns));
    }

    if (event.is_error) {
      this.turn.bubbleEl.addClass("is-error");
      if (!this.turn.text.trim()) {
        this.turn.text = "The agent encountered an error and could not complete the request.";
        void paintTurn(this, this.turn);
      } else {
        stat("status", "error", true);
      }
    }
  }

  private appendText(text: string, model?: string): void {
    if (!this.messagesEl) return;
    this.removeThinkingIndicator();
    if (!this.turn) {
      this.turn = this.createBubble("assistant", this.plugin.agentLabel);
      this.turn.caretEl = this.turn.bubbleEl.createSpan({ cls: "dj-caret" });
    }
    if (model && model !== this.turn.model) {
      this.turn.model = model;
      const slot = this.turn.bubbleEl.querySelector<HTMLElement>(".dj-msg-model");
      if (slot) {
        slot.setText(model);
        slot.show();
      }
    }
    this.turn.text += text;
    if (this.plugin.settings.streaming !== false) {
      scheduleThrottledRender(this, this.turn);
    }
    this.scroll();
  }

  private appendThinking(text: string): void {
    if (this.thinkingIndicatorEl && text.trim()) {
      const sb = this.thinkingIndicatorEl.querySelector<HTMLElement>(".dj-thinking-sub");
      if (sb) {
        sb.setText(text.trim().slice(0, 90) + (text.length > 90 ? "…" : ""));
      }
    }
    if (!text.trim()) return;

    if (!this.turn) {
      this.turn = this.createBubble("assistant", this.plugin.agentLabel);
      this.turn.caretEl = this.turn.bubbleEl.createSpan({ cls: "dj-caret" });
    }

    if (!this.turn.thinkingEl) {
      const details = this.turn.bubbleEl.createEl("details", { cls: "dj-tool is-thinking" });
      if (this.turn.bodyEl) {
        this.turn.bubbleEl.insertBefore(details, this.turn.bodyEl);
      }
      const summary = details.createEl("summary");
      const iconSpan = summary.createSpan({ cls: "dj-tool-icon" });
      setIcon(iconSpan, "sparkles");
      summary.createSpan({ cls: "dj-tool-name", text: "Thinking" });
      summary.createSpan({ cls: "dj-tool-arg" });
      const body = details.createDiv({ cls: "dj-tool-body dj-thinking-body" });
      this.turn.thinkingEl = details;
      this.turn.thinkingBodyEl = body;
    }
    const arg = this.turn.thinkingEl.querySelector<HTMLElement>(".dj-tool-arg");
    if (arg) {
      arg.setText(`${text.trim().slice(0, 80)}${text.length > 80 ? "…" : ""}`);
    }
    if (this.turn.thinkingBodyEl) {
      this.turn.thinkingBodyEl.setText(this.turn.thinkingBodyEl.getText() + text);
    }
  }

  private toolHost(): HTMLElement {
    if (!this.turn) {
      this.turn = this.createBubble("assistant", this.plugin.agentLabel);
    }
    if (!this.turn.toolsGroupEl) {
      const group = this.turn.bubbleEl.createEl("details", { cls: "dj-tools-group" });
      if (this.turn.bodyEl) {
        this.turn.bubbleEl.insertBefore(group, this.turn.bodyEl);
      }
      group.open = false;

      const summary = group.createEl("summary", { cls: "dj-tools-group-summary" });
      const iconSpan = summary.createSpan({ cls: "dj-tools-group-icon" });
      setIcon(iconSpan, "wrench");

      const title = summary.createSpan({ cls: "dj-tools-group-title", text: "Tool operations" });
      const badge = summary.createSpan({ cls: "dj-tools-group-badge is-running", text: "running" });

      const list = group.createDiv({ cls: "dj-tools-list" });

      this.turn.toolsGroupEl = group;
      this.turn.toolsSummaryTitleEl = title;
      this.turn.toolsStatusBadgeEl = badge;
      this.turn.toolsListEl = list;
      this.turn.toolsEl = list;
      this.turn.toolCallsCount = 0;
      this.turn.toolNames = [];
      this.turn.failedToolCount = 0;
    }
    return this.turn.toolsListEl!;
  }

  private renderToolUse(block: ContentBlock): void {
    if (!this.messagesEl) return;
    this.removeThinkingIndicator();
    const list = this.toolHost();

    this.turn!.toolCallsCount = (this.turn!.toolCallsCount ?? 0) + 1;
    const count = this.turn!.toolCallsCount;
    const name = block.name ?? "tool";
    if (!this.turn!.toolNames) this.turn!.toolNames = [];
    if (!this.turn!.toolNames.includes(name)) {
      this.turn!.toolNames.push(name);
    }

    const argSummary = summariseInput(block.input);

    if (this.turn!.toolsSummaryTitleEl) {
      const actionText = argSummary ? ` · ${argSummary}` : "";
      this.turn!.toolsSummaryTitleEl.setText(`Running ${name}${actionText} (${count})`);
    }
    if (this.turn!.toolsStatusBadgeEl) {
      this.turn!.toolsStatusBadgeEl.className = "dj-tools-group-badge is-running";
      this.turn!.toolsStatusBadgeEl.setText(`${count} running`);
    }

    const toolDetail: ToolCallDetail = {
      id: block.id,
      name,
      input: block.input,
      output: undefined,
      isError: false,
    };
    if (!this.turn!.toolDetails) {
      this.turn!.toolDetails = new Map();
    }
    if (block.id) {
      this.turn!.toolDetails.set(block.id, toolDetail);
    }

    const details = list.createEl("details", { cls: "dj-tool" });
    const summary = details.createEl("summary");
    summary.createSpan({ cls: "dj-tool-name", text: name });
    summary.createSpan({ cls: "dj-tool-arg", text: argSummary });
    const state = summary.createSpan({ cls: "dj-tool-state is-running", text: "running" });

    // Inspect action button opening full detail sheet (DM-24)
    const inspectBtn = summary.createEl("button", {
      cls: "dj-tool-inspect-btn dj-btn dj-btn-xs",
      attr: { "aria-label": "Inspect tool parameters and output in sheet", title: "Inspect details" },
    });
    const inspectIcon = inspectBtn.createSpan({ cls: "dj-action-icon" });
    setIcon(inspectIcon, "file-code");
    inspectBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      new ToolDetailModal(this.plugin.app, toolDetail).open();
    });

    const body = details.createDiv({ cls: "dj-tool-body" });
    const bodyActionRow = body.createDiv({ cls: "dj-tool-body-actions" });
    const modalBtn = bodyActionRow.createEl("button", {
      cls: "dj-btn dj-btn-xs dj-btn-accent",
      text: "Open parameter & output sheet",
    });
    modalBtn.addEventListener("click", () => {
      new ToolDetailModal(this.plugin.app, toolDetail).open();
    });

    const inputPreview = body.createEl("pre", { cls: "dj-tool-input-preview" });
    inputPreview.setText(JSON.stringify(block.input ?? {}, null, 2));

    if (block.id) this.turn!.tools.set(block.id, details);
    details.dataset.state = "running";
    void state;
    this.scroll();
  }

  private attachToolResult(block: ContentBlock): void {
    if (!this.turn || !block.tool_use_id) return;
    const details = this.turn.tools.get(block.tool_use_id);
    const detail = this.turn.toolDetails?.get(block.tool_use_id);

    if (block.is_error) {
      this.turn.failedToolCount = (this.turn.failedToolCount ?? 0) + 1;
    }

    const rendered = flattenToolResult(block.content);
    if (detail) {
      detail.output = rendered;
      detail.isError = Boolean(block.is_error);
    }

    if (details) {
      const state = details.querySelector<HTMLElement>(".dj-tool-state");
      if (state) {
        state.className = `dj-tool-state ${block.is_error ? "is-fail" : "is-ok"}`;
        state.setText(block.is_error ? "failed" : "done");
      }

      const body = details.querySelector<HTMLElement>(".dj-tool-body");
      if (body) {
        let outputPreview = body.querySelector<HTMLElement>(".dj-tool-output-preview");
        if (!outputPreview) {
          const outHeader = body.createEl("h5", {
            cls: "dj-tool-section-title",
            text: block.is_error ? "Error output:" : "Output:",
          });
          if (block.is_error) outHeader.addClass("is-error");
          outputPreview = body.createEl("pre", { cls: `dj-tool-output-preview ${block.is_error ? "is-error" : ""}` });
        }
        outputPreview.setText(rendered.slice(0, 10000));
      }
      if (block.is_error) (details as HTMLDetailsElement).open = true;
    }

    if (this.turn.toolsStatusBadgeEl && (this.turn.failedToolCount ?? 0) > 0) {
      this.turn.toolsStatusBadgeEl.className = "dj-tools-group-badge is-fail";
      this.turn.toolsStatusBadgeEl.setText(`${this.turn.failedToolCount} failed`);
    } else if (this.turn.toolsStatusBadgeEl && (this.turn.toolCallsCount ?? 0) > 0) {
      this.turn.toolsStatusBadgeEl.className = "dj-tools-group-badge is-done";
      this.turn.toolsStatusBadgeEl.setText(`${this.turn.toolCallsCount} completed`);
    }
  }

  public finishTurn(): void {
    this.clearTurnWatchdog();
    if (this.turn) {
      void flushPendingRender(this, this.turn);
    }
    this.removeThinkingIndicator();
    this.setBusy(false);
    this.checkBackgroundNotice();
    void this.dispatcher.drainNextQueuedTurn();

    if (!this.turn) return;
    this.turn.caretEl?.remove();
    this.turn.caretEl = null;

    if (this.turn.thinkingEl) {
      this.turn.thinkingEl.open = false;
    }

    if (this.turn.toolsGroupEl) {
      this.turn.toolsGroupEl.open = false;
      const count = this.turn.toolCallsCount || this.turn.tools.size;
      const names = this.turn.toolNames?.slice(0, 3).join(", ") || "tools";
      const more = (this.turn.toolNames?.length || 0) > 3 ? "…" : "";
      const fails = this.turn.failedToolCount ?? 0;

      if (this.turn.toolsSummaryTitleEl) {
        this.turn.toolsSummaryTitleEl.setText(
          `${count} tool operation${count === 1 ? "" : "s"} (${names}${more})`
        );
      }
      if (this.turn.toolsStatusBadgeEl) {
        if (fails > 0) {
          this.turn.toolsStatusBadgeEl.className = "dj-tools-group-badge is-fail";
          this.turn.toolsStatusBadgeEl.setText(`${fails} failed`);
        } else {
          this.turn.toolsStatusBadgeEl.className = "dj-tools-group-badge is-ok";
          this.turn.toolsStatusBadgeEl.setText("Done");
        }
      }
    }

    for (const details of this.turn.tools.values()) {
      const state = details.querySelector<HTMLElement>(".dj-tool-state");
      if (state && state.hasClass("is-running")) {
        state.className = "dj-tool-state";
        state.setText("—");
      }
    }
  }

  public onError(message: string, errorEvent?: { terminal?: boolean }): void {
    this.clearTurnWatchdog();
    const isTerminal = errorEvent?.terminal !== false;

    if (this.lastReportedError === message) {
      if (isTerminal) this.finishTurn();
      return;
    }
    if (this.turn && !this.turn.text.trim()) {
      this.lastReportedError = message;
      this.turn.bubbleEl.addClass("is-error");
      this.turn.text = message;
      void paintTurn(this, this.turn);
    } else {
      this.errorNote(message);
    }

    if (isTerminal) {
      this.finishTurn();
    }
  }

  private checkBackgroundNotice(): void {
    const isHidden =
      typeof document !== "undefined" && document.hidden
        ? true
        : !this.hostEl ||
          this.hostEl.offsetParent === null ||
          !this.hostEl.isConnected;
    if (isHidden) {
      new Notice("Darjeeling: synthesis complete");
    }
  }

  getActiveTurn(): LiveTurn | null {
    return this.turn;
  }

  resetActiveTurn(): void {
    this.turn = null;
  }

  getAllTurns(): LiveTurn[] {
    return this.allTurns;
  }

  onunload(): void {
    for (const turn of this.allTurns) {
      if (turn.renderComponent) {
        turn.renderComponent.unload();
        this.removeChild(turn.renderComponent);
        turn.renderComponent = null;
      }
      if (typeof turn.pendingRenderHandle === "number") {
        if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(turn.pendingRenderHandle);
        } else {
          window.clearTimeout(turn.pendingRenderHandle);
        }
        turn.pendingRenderHandle = null;
      }
    }
    super.onunload();
  }
}

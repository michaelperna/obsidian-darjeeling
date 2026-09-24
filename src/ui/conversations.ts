import { App, Modal, Notice, setIcon } from "obsidian";
import type { ConversationSummary } from "../net/sessionManager";
import type DarjeelingPlugin from "../main";

export class ConversationsSheetModal extends Modal {
  private searchQuery = "";
  private isLoading = true;
  private conversations: ConversationSummary[] = [];

  constructor(
    app: App,
    private plugin: DarjeelingPlugin,
    private onSelect: (summary: ConversationSummary) => void,
    private runningSessionIds: Set<string> = new Set()
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("darjeeling-root", "dj-conversations-sheet");

    // Obsidian owns modal sizing; pinned header and footer (DM-27)
    const header = contentEl.createDiv({ cls: "dj-sheet-header" });
    const titleRow = header.createDiv({ cls: "dj-sheet-title-row" });
    const iconSpan = titleRow.createSpan({ cls: "dj-sheet-icon" });
    setIcon(iconSpan, "history");
    titleRow.createEl("h2", { text: "Conversations" });

    // Search bar
    const searchRow = header.createDiv({ cls: "dj-search-row" });
    const searchInput = searchRow.createEl("input", {
      cls: "dj-input dj-search-input",
      type: "search",
      placeholder: "Search past conversations...",
    });
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value.toLowerCase().trim();
      this.renderList(listBody);
    });

    // Enter key scoped to search field (DM-27)
    searchInput.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        const first = this.getFilteredConversations()[0];
        if (first) {
          this.close();
          this.onSelect(first);
        }
      }
    });

    const listBody = contentEl.createDiv({ cls: "dj-sheet-body" });

    // Load conversations asynchronously
    this.renderSkeleton(listBody);
    void this.loadConversations(listBody);
  }

  private async loadConversations(container: HTMLElement): Promise<void> {
    try {
      this.isLoading = true;
      if (this.plugin.sessionManager) {
        const summaries = await this.plugin.sessionManager.listConversations();
        this.conversations = summaries || [];
      } else {
        this.conversations = [];
      }
    } catch {
      this.conversations = [];
    } finally {
      this.isLoading = false;
      this.renderList(container);
    }
  }

  private renderSkeleton(container: HTMLElement): void {
    container.empty();
    const skeletonWrap = container.createDiv({ cls: "dj-skeleton-wrap" });
    for (let i = 0; i < 4; i++) {
      const row = skeletonWrap.createDiv({ cls: "dj-skeleton-row" });
      row.createDiv({ cls: "dj-skeleton-title" });
      row.createDiv({ cls: "dj-skeleton-meta" });
    }
  }

  private getFilteredConversations(): ConversationSummary[] {
    if (!this.searchQuery) return this.conversations;
    return this.conversations.filter((c) => {
      const hay = `${c.title ?? ""} ${c.firstMessage ?? ""} ${c.lastMessage ?? ""} ${c.sessionId} ${
        c.model ?? ""
      }`.toLowerCase();
      return hay.includes(this.searchQuery);
    });
  }

  private renderList(container: HTMLElement): void {
    container.empty();
    const filtered = this.getFilteredConversations();

    if (filtered.length === 0) {
      const empty = container.createDiv({ cls: "dj-empty-state" });
      empty.createEl("p", {
        text: this.searchQuery ? "No matching conversations found." : "No previous conversations.",
      });
      return;
    }

    // Group conversations: Running now / Today / Earlier
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    const running: ConversationSummary[] = [];
    const today: ConversationSummary[] = [];
    const earlier: ConversationSummary[] = [];

    for (const c of filtered) {
      if (this.runningSessionIds.has(c.sessionId)) {
        running.push(c);
      } else {
        const itemTime = c.modified ? c.modified * 1000 : 0;
        if (itemTime >= startOfToday) {
          today.push(c);
        } else {
          earlier.push(c);
        }
      }
    }

    if (running.length > 0) {
      this.renderGroup(container, "Running now", running);
    }
    if (today.length > 0) {
      this.renderGroup(container, "Today", today);
    }
    if (earlier.length > 0) {
      this.renderGroup(container, "Earlier", earlier);
    }
  }

  private renderGroup(container: HTMLElement, label: string, items: ConversationSummary[]): void {
    const group = container.createDiv({ cls: "dj-conv-group" });
    group.createEl("h4", { cls: "dj-conv-group-header", text: label });

    for (const summary of items) {
      this.renderRow(group, summary);
    }
  }

  private renderRow(container: HTMLElement, summary: ConversationSummary): void {
    const row = container.createDiv({ cls: "dj-conv-item" });

    // Main content (clickable to resume)
    const content = row.createDiv({ cls: "dj-conv-item-content" });

    const titleEl = content.createDiv({ cls: "dj-conv-item-title" });
    // Titled rows, never bare hex IDs (DM-25)
    const displayTitle =
      summary.title ||
      summary.firstMessage?.slice(0, 60) ||
      `(Untitled conversation) ${summary.sessionId.slice(0, 8)}`;
    titleEl.createSpan({ text: displayTitle });

    if (this.runningSessionIds.has(summary.sessionId)) {
      titleEl.createSpan({ cls: "dj-conv-badge is-running", text: "Running" });
    }

    // Meta details
    const when = new Date(summary.modified * 1000);
    const timeStr = when.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const metaParts = [
      timeStr,
      `${summary.turns} turn${summary.turns === 1 ? "" : "s"}`,
      summary.toolCalls ? `${summary.toolCalls} tools` : null,
      summary.model ? summary.model.replace(/^claude-/, "") : null,
      summary.sessionId.slice(0, 8),
    ].filter(Boolean);

    content.createDiv({ cls: "dj-conv-item-meta", text: metaParts.join(" · ") });

    content.addEventListener("click", () => {
      this.close();
      this.onSelect(summary);
    });

    // Action buttons: Rename / Copy resume command / Copy ID (DM-25, VTH-37)
    const actions = row.createDiv({ cls: "dj-conv-item-actions" });

    // Rename button
    const renameBtn = actions.createEl("button", {
      cls: "dj-btn-icon",
      title: "Rename",
      attr: { "aria-label": "Rename" },
    });
    setIcon(renameBtn, "pencil");
    renameBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      const newTitle = window.prompt("New conversation title:", displayTitle);
      if (newTitle && newTitle.trim()) {
        summary.title = newTitle.trim();
        this.renderList(container.parentElement || container);
      }
    });

    // Copy resume command button (VTH-37)
    const resumeBtn = actions.createEl("button", {
      cls: "dj-btn-icon",
      title: "Copy resume command",
      attr: { "aria-label": "Copy resume command" },
    });
    setIcon(resumeBtn, "terminal");
    resumeBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      const agentType = (summary.model || this.plugin.settings.agent || "").toLowerCase();
      let cmd = "";
      if (agentType.includes("claude")) {
        cmd = `claude --resume ${summary.sessionId}`;
      } else if (agentType.includes("agy")) {
        cmd = `agy --resume ${summary.sessionId}`;
      } else {
        cmd = summary.sessionId;
      }
      void navigator.clipboard.writeText(cmd);
      new Notice(`Copied resume command: ${cmd}`);
    });

    // Copy ID button
    const copyIdBtn = actions.createEl("button", {
      cls: "dj-btn-icon",
      title: "Copy ID",
      attr: { "aria-label": "Copy ID" },
    });
    setIcon(copyIdBtn, "copy");
    copyIdBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      void navigator.clipboard.writeText(summary.sessionId);
      new Notice(`Copied conversation ID: ${summary.sessionId}`);
    });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}

import { App, Modal, Notice, setIcon } from "obsidian";
import { escapeHtml, sanitizeUntrustedMarkdown, setupRemoteMediaHandlers } from "./render";
import { writeClipboard } from "../terminal/clipboard";

export interface ToolCallDetail {
  id?: string;
  name: string;
  input: unknown;
  output?: unknown;
  isError?: boolean;
}

/**
 * Full-height sheet / modal for inspecting tool execution details (DM-24).
 * Displays distinct Input and Output tabs, preserves both arguments and results,
 * provides one-click copy, and prevents nested scrolling traps.
 */
export class ToolDetailModal extends Modal {
  private activeTab: "input" | "output" = "input";
  private tabButtons: Map<string, HTMLButtonElement> = new Map();
  private paneContentEl: HTMLElement | null = null;

  constructor(
    app: App,
    private detail: ToolCallDetail
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("dj-tool-sheet-modal");
    contentEl.empty();
    contentEl.addClass("dj-tool-sheet-content");

    // Header with tool verb, target, and status badge
    const headerEl = contentEl.createDiv({ cls: "dj-tool-sheet-header" });
    const titleWrap = headerEl.createDiv({ cls: "dj-tool-sheet-title-wrap" });
    const iconSpan = titleWrap.createSpan({ cls: "dj-tool-sheet-icon" });
    setIcon(iconSpan, "wrench");

    const titleEl = titleWrap.createEl("h3", {
      cls: "dj-tool-sheet-title",
      text: this.detail.name || "Tool Operation",
    });
    void titleEl;

    const statusBadge = headerEl.createSpan({
      cls: `dj-tool-sheet-status ${this.detail.isError ? "is-error" : "is-ok"}`,
      text: this.detail.isError ? "failed" : "completed",
    });
    void statusBadge;

    // Tabs row
    const tabsRow = contentEl.createDiv({ cls: "dj-tool-sheet-tabs" });

    const inputTabBtn = tabsRow.createEl("button", {
      cls: "dj-tool-tab-btn is-active",
      text: "Input",
    });
    this.tabButtons.set("input", inputTabBtn);
    inputTabBtn.addEventListener("click", () => this.switchTab("input"));

    const outputTabBtn = tabsRow.createEl("button", {
      cls: "dj-tool-tab-btn",
      text: "Output",
    });
    this.tabButtons.set("output", outputTabBtn);
    outputTabBtn.addEventListener("click", () => this.switchTab("output"));

    // Copy action for current tab
    const copyBtn = tabsRow.createEl("button", {
      cls: "dj-tool-sheet-copy-btn dj-btn dj-btn-xs",
    });
    const copyIcon = copyBtn.createSpan({ cls: "dj-btn-icon-prefix" });
    setIcon(copyIcon, "copy");
    const copyLabel = copyBtn.createSpan({ text: "Copy" });

    copyBtn.addEventListener("click", () => {
      void (async () => {
        const textToCopy =
          this.activeTab === "input"
            ? this.formatPayload(this.detail.input)
            : this.formatPayload(this.detail.output);

        if (!textToCopy.trim()) {
          new Notice(`No ${this.activeTab} content to copy.`);
          return;
        }

        const ok = await writeClipboard(textToCopy);
        if (ok) {
          copyLabel.setText("Copied");
          setIcon(copyIcon, "check");
          window.setTimeout(() => {
            copyLabel.setText("Copy");
            setIcon(copyIcon, "copy");
          }, 1500);
        }
      })();
    });

    // Content container (single natural scrolling pane, no nested scroll trap)
    this.paneContentEl = contentEl.createDiv({ cls: "dj-tool-sheet-body" });
    this.renderActiveTab();
  }

  private switchTab(tab: "input" | "output"): void {
    if (this.activeTab === tab) return;
    this.activeTab = tab;

    for (const [name, btn] of this.tabButtons.entries()) {
      btn.toggleClass("is-active", name === tab);
    }
    this.renderActiveTab();
  }

  private formatPayload(payload: unknown): string {
    if (payload === undefined || payload === null) return "";
    if (typeof payload === "string") return payload;
    try {
      return JSON.stringify(payload, null, 2);
    } catch {
      return typeof payload === "string" || typeof payload === "number" || typeof payload === "boolean"
        ? String(payload)
        : "[object]";
    }
  }

  private renderActiveTab(): void {
    if (!this.paneContentEl) return;
    this.paneContentEl.empty();

    const data = this.activeTab === "input" ? this.detail.input : this.detail.output;
    const formatted = this.formatPayload(data);

    if (!formatted.trim()) {
      const emptyNotice = this.paneContentEl.createDiv({ cls: "dj-tool-empty-pane" });
      emptyNotice.createSpan({
        text: this.activeTab === "input" ? "No input parameters provided." : "No output received yet.",
      });
      return;
    }

    // Render inside a clean, pre-formatted, restricted block
    const pre = this.paneContentEl.createEl("pre", {
      cls: "dj-code-block dj-restricted-fence dj-tool-sheet-code",
    });
    const code = pre.createEl("code");
    code.setText(formatted);

    setupRemoteMediaHandlers(this.paneContentEl);
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}

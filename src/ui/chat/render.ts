import { Component, MarkdownRenderer, Notice, TFile, setIcon } from "obsidian";
import { writeClipboard } from "../terminal/clipboard";
import { DARJEELING_ICON } from "../icons";
import type { DarjeelingChat } from "./chatView";
import { exportConversationToMarkdown } from "./export";
import type { ToolCallDetail } from "./toolSheet";
import { openDarjeelingSettings } from "../../settings/openSettings";
import { setDeviceRuntime } from "../../runtime/router";

/**
 * Whitelist of safe programming languages for syntax highlighting.
 * Code blocks with any language NOT in this list (e.g. dataviewjs, dataview, tasks)
 * are converted to plain <pre> blocks so no external plugin processor runs (ADR-17).
 */
export const SAFE_HIGHLIGHT_LANGUAGES = new Set([
  "javascript", "js", "mjs", "cjs", "jsx",
  "typescript", "ts", "tsx",
  "html", "htm", "xml", "svg",
  "css", "scss", "sass", "less",
  "json", "jsonc", "json5",
  "yaml", "yml", "toml", "ini",
  "markdown", "md", "mdx",
  "python", "py",
  "bash", "sh", "zsh", "shell",
  "sql", "pgsql", "mysql", "sqlite",
  "rust", "rs",
  "go", "golang",
  "c", "h", "cpp", "hpp", "cc", "cxx",
  "csharp", "cs",
  "java", "kotlin", "kt", "scala",
  "swift",
  "ruby", "rb",
  "php",
  "diff", "patch",
  "dockerfile", "docker",
  "graphql", "gql",
  "text", "txt", "plain", "plaintext",
]);

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * ADR-17 Restricted Markdown Sanitizer for agent output.
 * 1. Non-highlighting fences (e.g. dataviewjs) -> plain <pre class="dj-code-block dj-restricted-fence">
 * 2. Remote media -> click-to-load placeholders (remote images not fetched automatically)
 * 3. Malicious HTML (<script>, <iframe>, <object>, <embed>, inline handlers) -> stripped
 */
export function sanitizeUntrustedMarkdown(markdown: string): string {
  if (!markdown) return "";

  // 1. Convert non-highlighting fences to plain <pre class="dj-code-block dj-restricted-fence"><code>...</code></pre>
  let sanitized = markdown.replace(
    /(^|\n)( {0,3})(`{3,}|~{3,})([^\r\n`]*)\r?\n([\s\S]*?)\r?\n\2\3\s*(?=\n|$)/g,
    (match: string, prefix: string, _indent: string, _fence: string, langRaw: string, code: string): string => {
      const lang = (langRaw || "").trim().toLowerCase().split(/\s+/)[0];
      if (SAFE_HIGHLIGHT_LANGUAGES.has(lang)) {
        return match;
      }
      const safeLang = lang ? `language-${escapeHtml(lang)}` : "";
      return `${prefix}<pre class="dj-code-block dj-restricted-fence"><code${safeLang ? ` class="${safeLang}"` : ""}>${escapeHtml(code)}</code></pre>`;
    }
  );

  // 2. Click-to-load for remote markdown images: ![alt](https://... or http://...)
  sanitized = sanitized.replace(
    /!\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m: string, alt: string, url: string): string => {
      let host = "remote";
      try {
        host = new URL(url).hostname;
      } catch {
        host = "remote";
      }
      return `<div class="dj-remote-media" data-src="${escapeHtml(url)}" data-alt="${escapeHtml(alt)}"><span class="dj-remote-media-label">Remote image (${escapeHtml(host)})</span><button type="button" class="dj-btn dj-btn-xs dj-remote-media-btn">Click to load</button></div>`;
    }
  );

  // 3. Click-to-load for HTML <img src="https://...">
  sanitized = sanitized.replace(
    /<img\s+[^>]*src=["'](https?:\/\/[^"']+)["'][^>]*>/gi,
    (_m: string, url: string): string => {
      let host = "remote";
      try {
        host = new URL(url).hostname;
      } catch {
        host = "remote";
      }
      return `<div class="dj-remote-media" data-src="${escapeHtml(url)}" data-alt=""><span class="dj-remote-media-label">Remote image (${escapeHtml(host)})</span><button type="button" class="dj-btn dj-btn-xs dj-remote-media-btn">Click to load</button></div>`;
    }
  );

  // 4. Strip dangerous HTML: scripts, iframes, objects, embeds
  sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  sanitized = sanitized.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "");
  sanitized = sanitized.replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, "");
  sanitized = sanitized.replace(/<embed\b[^>]*>/gi, "");

  // 5. Strip inline event handlers: onclick, onload, onerror, etc.
  sanitized = sanitized.replace(/\s+on[a-z]+\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+)/gi, "");

  // 6. Strip javascript: URLs
  sanitized = sanitized.replace(/href\s*=\s*(['"])javascript:[^'"]*\1/gi, 'href="#"');

  return sanitized;
}

/**
 * Attaches click-to-load listeners on all pending remote media elements within a container.
 */
export function setupRemoteMediaHandlers(rootEl: HTMLElement): void {
  const containers = rootEl.querySelectorAll?.<HTMLElement>(".dj-remote-media") ?? [];
  containers.forEach((container) => {
    if (container.dataset?.bound === "true") return;
    if (container.dataset) container.dataset.bound = "true";
    const btn = container.querySelector?.<HTMLButtonElement>(".dj-remote-media-btn");
    if (!btn) return;

    btn.addEventListener("click", (evt: MouseEvent) => {
      evt?.preventDefault?.();
      evt?.stopPropagation?.();
      const src = container.dataset?.src;
      const alt = container.dataset?.alt || "";
      if (!src) return;

      container.empty();
      const img = container.createEl("img", {
        cls: "dj-loaded-media",
        attr: { src, alt },
      });
      img.addEventListener("error", () => {
        container.empty();
        container.createSpan({
          cls: "dj-remote-media-error",
          text: `Failed to load image from ${src}`,
        });
      });
    });
  });
}

/** One rendered turn, with handles for streaming updates into it. */
export interface LiveTurn {
  turnId?: string;
  role?: "user" | "assistant" | "system" | "error";
  bubbleEl: HTMLElement;
  headEl?: HTMLElement;
  bodyEl: HTMLElement;
  footerEl?: HTMLElement;
  text: string;
  caretEl: HTMLElement | null;
  toolsGroupEl?: HTMLDetailsElement | null;
  toolsSummaryTitleEl?: HTMLElement | null;
  toolsStatusBadgeEl?: HTMLElement | null;
  toolsListEl?: HTMLElement | null;
  toolsEl: HTMLElement | null;
  usageEl: HTMLElement | null;
  tools: Map<string, HTMLElement>;
  toolCallsCount?: number;
  toolNames?: string[];
  failedToolCount?: number;
  toolDetails?: Map<string, ToolCallDetail>;
  model?: string;
  thinkingEl?: HTMLDetailsElement | null;
  thinkingBodyEl?: HTMLElement | null;
  renderComponent?: Component | null;
  pendingRenderHandle?: number | null;
  renderCallCount?: number;
  lastRenderedText?: string;
  filesChanged?: number;
}

/** One-line preview of a tool's arguments for the collapsed card. */
export function summariseInput(input: Record<string, unknown> | undefined): string {
  if (!input || typeof input !== "object") return "";

  const humanAction = (input.toolAction || input.toolSummary || input.description || input.Description) as string | undefined;

  const cmd = (input.CommandLine || input.command || input.cmd) as string | undefined;
  if (typeof cmd === "string" && cmd.trim()) {
    const flatCmd = cmd.replace(/\s+/g, " ").trim();
    return flatCmd.length > 70 ? `${flatCmd.slice(0, 70)}…` : flatCmd;
  }

  const pathVal = (input.AbsolutePath || input.TargetFile || input.file_path || input.path || input.target_file || input.filePath) as string | undefined;
  if (typeof pathVal === "string" && pathVal.trim()) {
    const shortPath = pathVal.split("/").slice(-2).join("/");
    return humanAction ? `${humanAction} · ${shortPath}` : shortPath;
  }

  const query = (input.query || input.search || input.pattern) as string | undefined;
  if (typeof query === "string" && query.trim()) {
    return humanAction ? `${humanAction} · "${query}"` : `search: "${query}"`;
  }

  if (humanAction && typeof humanAction === "string") {
    return humanAction;
  }

  try {
    const raw = JSON.stringify(input);
    return raw.length > 70 ? `${raw.slice(0, 70)}…` : raw;
  } catch {
    return "";
  }
}

/** Tool results arrive as a string, or as an array of content blocks. */
export function flattenToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const block = part as { type?: string; text?: string };
          if (block.type === "text" && typeof block.text === "string") return block.text;
          if (block.type === "image") return "[image]";
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  if (content === undefined || content === null) return "";
  return JSON.stringify(content, null, 2);
}

/**
 * State-aware empty state renderer (DM-31, DM-39).
 * Shows distinct cards for: Not configured, Offline/Unreachable, and Ready.
 */
export function renderEmptyState(chat: DarjeelingChat, messagesEl: HTMLElement): void {
  messagesEl.empty();
  const plugin = chat.getPlugin();
  const client = chat.getClient();
  const mode = client?.getEffectiveRuntimeMode?.() || plugin.settings.runtimeMode || "remote";

  // 1. Not configured state
  if (mode === "remote" && !plugin.settings.meshnetHost?.trim()) {
    const hero = messagesEl.createDiv({ cls: "dj-empty-hero is-not-configured" });
    const emblem = hero.createDiv({ cls: "dj-hero-emblem" });
    setIcon(emblem, "settings");

    hero.createEl("h3", { cls: "dj-empty-title", text: "Connect Darjeeling to start" });
    hero.createEl("p", {
      cls: "dj-empty-subtitle",
      text: "No remote server is configured. Provide a server host in settings, or switch to direct API mode.",
    });

    const actions = hero.createDiv({ cls: "dj-empty-state-actions" });
    const settingsBtn = actions.createEl("button", {
      cls: "dj-btn dj-btn-sm dj-btn-accent",
      text: "Open settings",
    });
    settingsBtn.addEventListener("click", () => {
      openDarjeelingSettings(plugin.app);
    });

    const directApiBtn = actions.createEl("button", {
      cls: "dj-btn dj-btn-sm",
      text: "Use direct API",
    });
    directApiBtn.addEventListener("click", () => {
      void (async () => {
        setDeviceRuntime(plugin.app, plugin.settings, "direct-api");
        await plugin.saveSettings();
        renderEmptyState(chat, messagesEl);
      })();
    });
    return;
  }

  if (mode === "direct-api" && !plugin.settings.directApiKey?.trim()) {
    const hero = messagesEl.createDiv({ cls: "dj-empty-hero is-not-configured" });
    const emblem = hero.createDiv({ cls: "dj-hero-emblem" });
    setIcon(emblem, "key");

    hero.createEl("h3", { cls: "dj-empty-title", text: "Direct API key required" });
    hero.createEl("p", {
      cls: "dj-empty-subtitle",
      text: "Enter your API key in settings to run Darjeeling models directly inside Obsidian.",
    });

    const actions = hero.createDiv({ cls: "dj-empty-state-actions" });
    const settingsBtn = actions.createEl("button", {
      cls: "dj-btn dj-btn-sm dj-btn-accent",
      text: "Open settings",
    });
    settingsBtn.addEventListener("click", () => {
      openDarjeelingSettings(plugin.app);
    });
    return;
  }

  // 2. Offline state
  if (mode === "remote" && client?.connectionState === "closed") {
    const host = plugin.settings.meshnetHost || "Server";
    const hero = messagesEl.createDiv({ cls: "dj-empty-hero is-offline" });
    const emblem = hero.createDiv({ cls: "dj-hero-emblem is-error" });
    setIcon(emblem, "wifi-off");

    hero.createEl("h3", { cls: "dj-empty-title", text: `Can't reach ${host}` });
    hero.createEl("p", {
      cls: "dj-empty-subtitle",
      text: "The remote Darjeeling server is offline or unreachable. Check your network or daemon status.",
    });

    const actions = hero.createDiv({ cls: "dj-empty-state-actions" });
    const retryBtn = actions.createEl("button", {
      cls: "dj-btn dj-btn-sm dj-btn-accent",
      text: "Retry connection",
    });
    retryBtn.addEventListener("click", () => {
      client.connect();
      new Notice("Reconnecting to server…");
    });

    const settingsBtn = actions.createEl("button", {
      cls: "dj-btn dj-btn-sm",
      text: "Settings",
    });
    settingsBtn.addEventListener("click", () => {
      openDarjeelingSettings(plugin.app);
    });
    return;
  }

  // 3. Ready state with plain modern labels (DM-31)
  const hero = messagesEl.createDiv({ cls: "dj-empty-hero" });
  const emblem = hero.createDiv({ cls: "dj-hero-emblem" });
  setIcon(emblem, DARJEELING_ICON);

  hero.createEl("h3", { cls: "dj-empty-title", text: "Project Darjeeling" });
  hero.createEl("p", {
    cls: "dj-empty-subtitle",
    text: "AI assistant for your vault notes, plans, and terminal workflows.",
  });

  const flight = hero.createDiv({ cls: "dj-tasting-flight" });
  const suggestions = [
    {
      icon: "file-text",
      title: "Review active note",
      desc: "Identify unclear claims, missing edge cases, and potential objections",
      prompt: "Read the active note and review it: identify unclear claims, missing edge cases, and what a reader would push back on. Be specific and quote the note.",
    },
    {
      icon: "list",
      title: "Summarise active note",
      desc: "Extract decisions made, action items with owners, and open questions",
      prompt: "Summarise the attached note: extract key decisions, action items with owners, and open questions. Keep it tight.",
    },
    {
      icon: "git-pull-request",
      title: "Plan changes",
      desc: "Outline a phased implementation plan for your project",
      prompt: "Outline a step-by-step implementation plan for: ",
    },
  ];

  for (const sug of suggestions) {
    const card = flight.createDiv({ cls: "dj-tasting-card" });
    const iconBox = card.createDiv({ cls: "dj-tasting-icon-box" });
    setIcon(iconBox, sug.icon);
    const info = card.createDiv({ cls: "dj-tasting-info" });
    info.createEl("h4", { cls: "dj-tasting-title", text: sug.title });
    info.createEl("p", { cls: "dj-tasting-desc", text: sug.desc });
    const arrow = card.createDiv({ cls: "dj-tasting-arrow" });
    setIcon(arrow, "arrow-right");
    card.addEventListener("click", () => {
      const inputEl = chat.getInputEl();
      if (!inputEl) return;
      inputEl.value = sug.prompt;
      inputEl.focus();
      chat.growInput();
    });
  }
}

/**
 * Creates a message bubble with streamlined chrome (DM-40),
 * plain labels (DM-31), attached note guard (CHAT-42), and accessible elements (DM-45, DOC-39).
 */
export function createBubble(
  chat: DarjeelingChat,
  messagesEl: HTMLElement,
  kind: "user" | "assistant" | "system" | "error",
  who: string,
  attachedNote?: TFile | null
): LiveTurn {
  const bubbleEl = messagesEl.createDiv({
    cls: `dj-msg is-${kind === "error" ? "error" : kind}`,
  });
  const head = bubbleEl.createDiv({ cls: "dj-msg-head" });

  if (kind === "assistant") {
    const avatarEl = head.createDiv({ cls: "dj-msg-avatar" });
    setIcon(avatarEl, DARJEELING_ICON);
    head.createSpan({ cls: "dj-msg-who", text: who || "Darjeeling" });

    const runtimeMode = chat.getClient?.()?.getEffectiveRuntimeMode?.() || "remote";
    if (runtimeMode === "direct-api") {
      const syncBadge = head.createSpan({
        cls: "dj-conv-badge is-direct-api",
        text: "Direct API",
      });
      syncBadge.title = "Running directly in Obsidian; conversation not synced between devices";
    } else if (runtimeMode === "local") {
      const syncBadge = head.createSpan({
        cls: "dj-conv-badge is-local",
        text: "Local",
      });
      syncBadge.title = "Running on local machine CLI";
    }
  } else if (kind === "user") {
    head.createSpan({ cls: "dj-msg-who", text: "You" });
    // CHAT-42: Attached tag only when note is actually attached and attach checkbox is true
    const attachChecked = Boolean(chat.getAttachChecked?.());
    if (attachChecked && attachedNote) {
      const noteTag = head.createSpan({ cls: "dj-msg-note-tag" });
      const tagIcon = noteTag.createSpan({ cls: "dj-msg-note-icon" });
      setIcon(tagIcon, "paperclip");
      noteTag.createSpan({ text: attachedNote.basename });
      noteTag.title = `Attached context: ${attachedNote.path}`;
    }
  } else if (kind === "error") {
    const iconWrap = head.createSpan({ cls: "dj-msg-icon is-error" });
    setIcon(iconWrap, "alert-triangle");
    head.createSpan({ cls: "dj-msg-who", text: "Error" });
  } else {
    head.createSpan({ cls: "dj-msg-who", text: who });
  }

  const modelSlot = head.createSpan({ cls: "dj-msg-model" });
  modelSlot.hide();
  head.createSpan({
    cls: "dj-msg-time",
    text: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  });

  const actionsWrap = head.createDiv({ cls: "dj-msg-head-actions" });

  const copyBtn = actionsWrap.createEl("button", {
    cls: "dj-msg-action-btn",
    attr: { "aria-label": "Copy message as markdown", title: "Copy message as markdown" },
  });
  const copyIcon = copyBtn.createSpan({ cls: "dj-action-icon" });
  setIcon(copyIcon, "copy");

  const bodyEl = bubbleEl.createDiv({ cls: "dj-msg-body" });
  const footerEl = bubbleEl.createDiv({ cls: "dj-msg-footer" });
  footerEl.hide();

  const turn: LiveTurn = {
    role: kind,
    bubbleEl,
    headEl: head,
    bodyEl,
    footerEl,
    text: "",
    caretEl: null,
    toolsEl: null,
    usageEl: null,
    tools: new Map(),
    toolDetails: new Map(),
    renderComponent: null,
    pendingRenderHandle: null,
    renderCallCount: 0,
  };

  copyBtn.addEventListener("click", () => {
    const text = turn.text ?? "";
    if (!text.trim()) {
      new Notice("Nothing to copy yet.");
      return;
    }
    void writeClipboard(text).then((ok) => {
      setIcon(copyIcon, ok ? "check" : "x");
      window.setTimeout(() => setIcon(copyIcon, "copy"), 1400);
    });
  });

  if (kind === "assistant") {
    const runtimeMode = chat.getClient?.()?.getEffectiveRuntimeMode?.() || "remote";
    if (runtimeMode === "direct-api") {
      const saveBtn = actionsWrap.createEl("button", {
        cls: "dj-msg-action-btn",
        attr: { "aria-label": "Save conversation to note", title: "Save conversation to note" },
      });
      const saveIcon = saveBtn.createSpan({ cls: "dj-action-icon" });
      setIcon(saveIcon, "bookmark");
      saveBtn.addEventListener("click", () => {
        void (async () => {
          const allTurns = typeof chat.getAllTurns === "function" ? chat.getAllTurns() : [turn];
          await exportConversationToMarkdown(chat, allTurns);
        })();
      });
    }

    const insertBtn = actionsWrap.createEl("button", {
      cls: "dj-msg-action-btn",
      attr: { "aria-label": "Insert into note", title: "Insert into note" },
    });
    const insertIcon = insertBtn.createSpan({ cls: "dj-action-icon" });
    setIcon(insertIcon, "file-plus-2");
    const targetNote = chat.getAttachedNote();
    insertBtn.title = targetNote
      ? `Insert into [[${targetNote.basename}]]`
      : "Insert into active note";
    insertBtn.addEventListener("click", () => {
      void (async () => {
        const text = turn.text ?? "";
        if (!text.trim()) {
          new Notice("Nothing to insert yet.");
          return;
        }
        const note = chat.getAttachedNote();
        const plugin = chat.getPlugin();
        const ok = await plugin.insertTextIntoActiveNote(text, note);
        if (ok) {
          setIcon(insertIcon, "check");
          window.setTimeout(() => setIcon(insertIcon, "file-plus-2"), 1500);
        }
      })();
    });
  }

  return turn;
}

/**
 * Paints a LiveTurn's text using child Component isolation and ADR-17 restricted markdown rendering.
 */
export async function paintTurn(chat: DarjeelingChat, turn: LiveTurn): Promise<void> {
  turn.renderCallCount = (turn.renderCallCount ?? 0) + 1;

  // Unload previous child Component to prevent listener/post-processor leak
  if (turn.renderComponent) {
    turn.renderComponent.unload();
    chat.removeChild(turn.renderComponent);
    turn.renderComponent = null;
  }

  // Create fresh child Component and register with chat
  const child = new Component();
  chat.addChild(child);
  child.load();
  turn.renderComponent = child;
  turn.lastRenderedText = turn.text;

  if (typeof turn.bodyEl.empty === "function") {
    turn.bodyEl.empty();
  } else {
    turn.bodyEl.innerHTML = "";
  }

  const plugin = chat.getPlugin();
  const safeMarkdown = sanitizeUntrustedMarkdown(turn.text);

  await MarkdownRenderer.render(
    plugin.app,
    safeMarkdown,
    turn.bodyEl,
    plugin.app.workspace?.getActiveFile?.()?.path ?? "",
    child
  );

  setupRemoteMediaHandlers(turn.bodyEl);
}

/**
 * Throttles live streaming text updates to prevent UI stutter (CHAT-32, QA-21).
 */
export function scheduleThrottledRender(
  chat: DarjeelingChat,
  turn: LiveTurn,
  onComplete?: () => void
): void {
  if (turn.pendingRenderHandle != null) {
    return;
  }

  const schedule =
    typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
      ? (cb: () => void) => window.requestAnimationFrame(cb)
      : (cb: () => void) => window.setTimeout(cb, 50);

  turn.pendingRenderHandle = schedule(() => {
    void (async () => {
      turn.pendingRenderHandle = null;
      await paintTurn(chat, turn);
      chat.scroll?.();
      onComplete?.();
    })();
  });
}

/**
 * Cancels any pending throttled render and immediately updates the DOM if needed.
 */
export async function flushPendingRender(chat: DarjeelingChat, turn: LiveTurn): Promise<void> {
  if (turn.pendingRenderHandle != null) {
    if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function" && typeof turn.pendingRenderHandle === "number") {
      window.cancelAnimationFrame(turn.pendingRenderHandle);
    } else {
      window.clearTimeout(turn.pendingRenderHandle);
    }
    turn.pendingRenderHandle = null;
  }
  if (turn.lastRenderedText !== turn.text) {
    await paintTurn(chat, turn);
    chat.scroll?.();
  }
}

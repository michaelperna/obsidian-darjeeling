import { Notice, TFolder, normalizePath } from "obsidian";
import type { DarjeelingChat } from "./chatView";
import type { LiveTurn } from "./render";

/**
 * Export active conversation to a durable Markdown note with Dataview metadata (CHAT-48).
 * Filters out cancelled and queued turns, and uses collision-resistant timestamped filenames.
 */
export async function exportConversationToMarkdown(
  chat: DarjeelingChat,
  allTurns: LiveTurn[]
): Promise<void> {
  const validTurns = (allTurns || []).filter((turn) => {
    if (!turn || !turn.bubbleEl) return false;
    const hasCls = (cls: string) =>
      typeof turn.bubbleEl.hasClass === "function"
        ? turn.bubbleEl.hasClass(cls)
        : turn.bubbleEl.classList?.contains?.(cls);

    if (hasCls("is-queued") || hasCls("is-cancelled")) return false;
    return Boolean(turn.text && turn.text.trim().length > 0);
  });

  if (validTurns.length === 0) {
    new Notice("No completed messages in the current conversation to export.");
    return;
  }

  const plugin = chat.getPlugin();
  const sessionId = plugin.settings.lastAgentSessionId || `session-${Date.now()}`;
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const folder = plugin.settings.artifactFolder || "Darjeeling Conversations";
  const { vault } = plugin.app;

  let filePath = normalizePath(`${folder}/Session-${timestamp}.md`);
  let counter = 1;
  while (vault.getAbstractFileByPath(filePath)) {
    filePath = normalizePath(`${folder}/Session-${timestamp}-${counter}.md`);
    counter++;
  }

  const lines: string[] = [
    "---",
    "type: darjeeling-conversation",
    `session-id: "${sessionId}"`,
    `created: ${now.toISOString()}`,
    `model: "${plugin.settings.model || "default"}"`,
    "tags:",
    "  - darjeeling/session",
    "  - ai/conversation",
    "---",
    "",
    `# Darjeeling Conversation (${now.toLocaleDateString()})`,
    "",
  ];

  for (const turn of validTurns) {
    const isUser =
      typeof turn.bubbleEl.hasClass === "function"
        ? turn.bubbleEl.hasClass("is-user")
        : turn.bubbleEl.classList?.contains?.("is-user");
    const isSystem =
      typeof turn.bubbleEl.hasClass === "function"
        ? turn.bubbleEl.hasClass("is-system")
        : turn.bubbleEl.classList?.contains?.("is-system");

    const author = isUser ? "You" : isSystem ? "System" : (plugin.agentLabel || "Assistant");

    lines.push(`### ${author}`, "");
    lines.push(turn.text.trim(), "");
  }

  try {
    const parent = filePath.split("/").slice(0, -1).join("/");
    if (parent && !(vault.getAbstractFileByPath(parent) instanceof TFolder)) {
      await vault.createFolder(parent).catch(() => undefined);
    }
    const file = await vault.create(filePath, lines.join("\n"));
    new Notice(`Conversation exported to ${filePath}`);

    const leaf = plugin.app.workspace.getLeaf(true);
    await leaf.openFile(file);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    new Notice(`Could not export conversation: ${msg}`);
  }
}

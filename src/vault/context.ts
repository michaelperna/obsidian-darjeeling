import { App, MarkdownView, TFile } from "obsidian";

export const MAX_INLINE_NOTE_BYTES = 32768; // 32 KB inline cap (G-33, CORE-25)
export const TRUNCATED_MARKER = "\n\n... [Active note truncated at 32 KB] ...\n";

/**
 * Returns the active markdown note to use for context (used by both the pill and send path).
 * Text markdown TFiles only; non-markdown files return null (CORE-25).
 */
export function getContextNote(app: App, explicitNote?: TFile | null): TFile | null {
  if (explicitNote) {
    if (explicitNote instanceof TFile && explicitNote.extension === "md") {
      return explicitNote;
    }
    return null;
  }

  const activeFile = app.workspace?.getActiveFile?.();
  if (activeFile && activeFile instanceof TFile && activeFile.extension === "md") {
    return activeFile;
  }

  const activeView = app.workspace?.getActiveViewOfType?.(MarkdownView);
  if (activeView?.file && activeView.file instanceof TFile && activeView.file.extension === "md") {
    return activeView.file;
  }

  return null;
}

/**
 * Reads a markdown note with an inline 32 KB cap and visible truncation marker (G-33, CORE-25).
 */
export async function readContextNoteWithCap(
  app: App,
  file: TFile,
  maxBytes = MAX_INLINE_NOTE_BYTES
): Promise<{ content: string; truncated: boolean }> {
  if (!file || file.extension !== "md") {
    return { content: "", truncated: false };
  }

  let text = "";
  try {
    text = await app.vault.read(file);
  } catch (err) {
    console.warn(`[Darjeeling] Could not read context note ${file.path}:`, err);
    return { content: "", truncated: false };
  }

  if (text.length > maxBytes) {
    return {
      content: text.slice(0, maxBytes) + TRUNCATED_MARKER,
      truncated: true,
    };
  }

  return {
    content: text,
    truncated: false,
  };
}

/**
 * Resolves markdown notes linked from the current note (ADR-14, G-33).
 */
export function getLinkedNotes(app: App, file: TFile, maxCount = 10): TFile[] {
  if (!file || !app.metadataCache) return [];

  const cache = app.metadataCache.getFileCache?.(file);
  if (!cache?.links || !Array.isArray(cache.links)) return [];

  const seenPaths = new Set<string>();
  seenPaths.add(file.path);
  const result: TFile[] = [];

  for (const link of cache.links) {
    if (!link?.link) continue;
    const dest = app.metadataCache.getFirstLinkpathDest?.(link.link, file.path);
    if (dest instanceof TFile && dest.extension === "md" && !seenPaths.has(dest.path)) {
      seenPaths.add(dest.path);
      result.push(dest);
      if (result.length >= maxCount) break;
    }
  }

  return result;
}

/**
 * Format linked notes for CLI runtimes (paths only) or direct providers (content only if opted in).
 * (ADR-14, G-33, CHAT-22)
 */
export async function formatLinkedNotesForRuntime(
  app: App,
  linkedFiles: TFile[],
  isDirectApi: boolean,
  includeLinkedNotes: boolean
): Promise<string> {
  if (!linkedFiles || linkedFiles.length === 0) return "";

  // CLI runtimes: send paths only (the agent CLI reads what it needs)
  if (!isDirectApi) {
    const lines = linkedFiles.map((f) => `- ${f.path}`);
    return `Linked Notes:\n${lines.join("\n")}`;
  }

  // Direct API: send full text ONLY IF user opted in via includeLinkedNotes
  if (!includeLinkedNotes) {
    return "";
  }

  const sections: string[] = [];
  for (const file of linkedFiles) {
    const { content } = await readContextNoteWithCap(app, file);
    sections.push(`### Linked Note: ${file.path}\n${content}`);
  }

  return `Linked Notes Content:\n\n${sections.join("\n\n")}`;
}

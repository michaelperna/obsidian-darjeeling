/**
 * Terminal clipboard support.
 *
 * Obsidian's renderer is Chromium, so navigator.clipboard is available, but
 * xterm.js deliberately ships no copy/paste bindings -- the host app is
 * expected to supply them. On mobile there is no Cmd key at all, so the key
 * bar carries buttons for the same operations.
 */

import { Notice } from "obsidian";
import type { Terminal } from "@xterm/xterm";

/** Read the clipboard, falling back to the deprecated exec path if blocked. */
export async function readClipboard(): Promise<string> {
  try {
    if (navigator.clipboard?.readText) {
      return await navigator.clipboard.readText();
    }
  } catch (err) {
    console.warn("[Darjeeling] clipboard read denied:", err);
  }
  return "";
}

export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    console.warn("[Darjeeling] clipboard write denied:", err);
  }
  // Last resort for webviews that refuse the async API.
  try {
    const scratch = createEl("textarea");
    scratch.value = text;
    scratch.addClass("dj-terminal-scratch");
    document.body.appendChild(scratch);
    scratch.select();
    const doc = document as unknown as Record<string, ((cmd: string) => boolean) | undefined>;
    const ok = typeof doc["execCommand"] === "function" ? Boolean(doc["execCommand"]("copy")) : false;
    scratch.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Wrap pasted text in bracketed-paste markers when the running program has
 * asked for them, stripping any existing bracketed-paste markers to prevent breakout.
 *
 * Without this, pasting anything multi-line into a TUI submits on the first
 * newline and the rest lands as separate prompts. Claude Code enables
 * bracketed paste, so a pasted plan arrives as one block.
 */
export function framePaste(terminal: Terminal, text: string): string {
  // Strip bracketed-paste end/start markers to prevent injection breakout (VTH-32)
  // eslint-disable-next-line no-control-regex -- ANSI bracketed paste escape sequences contain ESC character \x1b
  const clean = text.replace(/\x1b\[20[01]~/g, "");

  // Normalise CRLF and lone CR; terminals want \r for Enter, and a stray \n
  // inside a paste is what triggers premature submission.
  const normalised = clean.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
  const bracketed = (terminal.modes as { bracketedPasteMode?: boolean })
    ?.bracketedPasteMode;
  return bracketed ? `\x1b[200~${normalised}\x1b[201~` : normalised;
}

/**
 * Rebuild the terminal's logical lines from its buffer.
 *
 * xterm marks soft-wrapped continuations with `isWrapped`, so those rejoin
 * cleanly. Programs that wrap text themselves (Claude Code's login screen
 * being the case that matters) emit real newlines instead, which is handled
 * separately by `extractUrls`.
 */
export function readBufferLines(terminal: Terminal, maxLines = 2000): string[] {
  const buffer = terminal.buffer.active;
  const total = Math.min(buffer.length, maxLines);
  const start = Math.max(0, buffer.length - total);

  const logical: string[] = [];
  for (let i = start; i < buffer.length; i += 1) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && logical.length) {
      logical[logical.length - 1] += text;
    } else {
      logical.push(text);
    }
  }
  return logical;
}

const URL_RE = /https?:\/\/[^\s"'<>`]+/g;

/**
 * Pull URLs out of the terminal, reassembling ones the program hard-wrapped.
 *
 * A long OAuth URL arrives broken across four lines at the pane width. Each
 * fragment is a real line, so no addon will linkify it and selecting it by
 * hand gives you a URL with newlines in the middle. The heuristic: after a
 * line containing a URL that extends to the terminal margin, keep absorbing
 * following lines that have no whitespace and do not look like shell prompts.
 */
export function extractUrls(terminal: Terminal): string[] {
  const lines = readBufferLines(terminal);
  const found: string[] = [];
  const termCols = terminal.cols || 80;

  for (let i = 0; i < lines.length; i += 1) {
    const matches = lines[i].match(URL_RE);
    if (!matches) continue;

    for (const match of matches) {
      let url = match.replace(/[.,;:!?)'"\]]+$/, "");

      // Only a line that reaches near the terminal edge (hard wrap) and ends with the URL match
      // can have been split mid-URL (VTH-16)
      if (lines[i].length >= termCols - 1 && lines[i].trimEnd().endsWith(match)) {
        for (let j = i + 1; j < lines.length; j += 1) {
          const nextRaw = lines[j];
          const next = nextRaw.trim();
          if (!next || /\s/.test(next)) break;
          // Stop at prompts like user@host:~$ or escape sequences (VTH-16)
          if (/[$#>%]$/.test(next) || /^[+[(]|^Esc\b/.test(next)) break;
          url += next;
          if (url.length > 4000) break;
          // If continuation line doesn't reach the edge, the wrapped URL ended
          if (nextRaw.length < termCols - 1) break;
        }
        url = url.replace(/[.,;:!?)'"\]]+$/, "");
      }
      if (!found.includes(url)) found.push(url);
    }
  }
  return found;
}

/**
 * Bind Cmd/Ctrl+C.
 *
 * Ctrl+C only copies when there is a selection; with none it must still reach
 * the program as SIGINT, which is the whole reason xterm leaves this to the
 * host rather than guessing.
 *
 * Note: Cmd/Ctrl+V is deliberately omitted here (VTH-04) to allow xterm's
 * native paste handling (including bracketed paste) to operate without double-pasting.
 */
export function attachClipboardKeys(
  terminal: Terminal,
  _send: (data: string) => void
): void {
  terminal.attachCustomKeyEventHandler((event: KeyboardEvent): boolean => {
    if (event.type !== "keydown") return true;

    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return true;

    const key = event.key.toLowerCase();

    if (key === "c") {
      const selection = terminal.getSelection();
      if (!selection) return true; // no selection: let ^C through as SIGINT
      void writeClipboard(selection).then((ok) => {
        if (ok) new Notice(`Copied ${selection.length} characters`);
      });
      terminal.clearSelection();
      return false;
    }

    if (key === "a" && event.shiftKey) {
      terminal.selectAll();
      return false;
    }

    return true;
  });
}

import { App, MarkdownView, Notice, normalizePath, TFile } from "obsidian";

export interface InsertOptions {
  targetFile?: TFile | null;
  isPlan?: boolean;
  baseTitle?: string;
}

export interface InsertResult {
  file: TFile;
  mode: "appended" | "created";
}

/**
 * Inserts or appends text into a target markdown note (CORE-02, F-09, PD-18).
 * - Explicit target or active MarkdownView ONLY.
 * - If no note is open or specified: creates a NEW note in fileManager.getNewFileParent().
 * - Never implicitly replaces selection (no implicit replaceSelection).
 * - Uses vault.process for atomic updates.
 * - Plan inserts are body-only (strips frontmatter).
 */
export async function insertTextSafe(
  app: App,
  text: string,
  options?: InsertOptions | TFile | null
): Promise<InsertResult | null> {
  const opts: InsertOptions =
    options instanceof TFile
      ? { targetFile: options }
      : (options ?? {});

  let formatted = text.trim();
  if (!formatted) {
    new Notice("No content to insert.");
    return null;
  }

  // Plan inserts are body-only (CORE-02, F-09, PD-18)
  if (opts.isPlan) {
    formatted = formatted.replace(/^---[\s\S]*?---\n*/, "").trim();
  }

  // 1. Determine target file: explicit target OR active MarkdownView only
  let targetFile: TFile | null = null;
  if (opts.targetFile && opts.targetFile instanceof TFile && opts.targetFile.extension === "md") {
    targetFile = opts.targetFile;
  } else {
    const activeView = app.workspace?.getActiveViewOfType?.(MarkdownView);
    if (activeView?.file && activeView.file instanceof TFile && activeView.file.extension === "md") {
      targetFile = activeView.file;
    }
  }

  // 2. If target note exists, append safely via vault.process without replacing selection
  if (targetFile) {
    await app.vault.process(targetFile, (current: string) => {
      if (!current || !current.trim()) {
        return formatted + "\n";
      }
      if (current.endsWith("\n\n")) {
        return current + formatted + "\n";
      }
      if (current.endsWith("\n")) {
        return current + "\n" + formatted + "\n";
      }
      return current + "\n\n" + formatted + "\n";
    });
    new Notice(`Appended to [[${targetFile.basename}]].`);
    return { file: targetFile, mode: "appended" };
  }

  // 3. No open note: create a new note in fileManager.getNewFileParent() (CORE-02)
  const parentFolder = app.fileManager?.getNewFileParent?.("")?.path || "";
  const baseName = opts.baseTitle ? opts.baseTitle.trim() : "Untitled";

  let candidate = parentFolder ? `${parentFolder}/${baseName}.md` : `${baseName}.md`;
  candidate = normalizePath(candidate);

  let counter = 1;
  while (app.vault.getAbstractFileByPath(candidate) || app.vault.getFileByPath?.(candidate)) {
    candidate = parentFolder
      ? `${parentFolder}/${baseName} ${counter}.md`
      : `${baseName} ${counter}.md`;
    candidate = normalizePath(candidate);
    counter++;
  }

  const initialContent = formatted + "\n";
  const newFile = await app.vault.create(candidate, initialContent);
  newNoticeOrLog(`Created new note [[${newFile.basename}]].`);
  return { file: newFile, mode: "created" };
}

function newNoticeOrLog(msg: string): void {
  try {
    new Notice(msg);
  } catch {
    // Notice constructor fallback in test envs
  }
}

/**
 * Backward-compatible helper returning boolean.
 */
export async function insertTextIntoActiveNote(
  app: App,
  text: string,
  attachedFile?: TFile | null | InsertOptions
): Promise<boolean> {
  const res = await insertTextSafe(app, text, attachedFile);
  return res !== null;
}

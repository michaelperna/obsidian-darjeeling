import { App, Notice, Platform, TFile } from "obsidian";

export const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svgz", "ico",
  "zip", "tar", "gz", "bz2", "xz", "7z",
  "pdf", "epub", "docx", "xlsx", "pptx",
  "exe", "dll", "so", "dylib", "bin",
  "mp3", "mp4", "mov", "avi", "mkv", "wav",
  "pyc", "wasm",
]);

export function isBinaryFile(file: TFile | string): boolean {
  const ext = (typeof file === "string" ? file.split(".").pop() : file.extension)?.toLowerCase() ?? "";
  return BINARY_EXTENSIONS.has(ext);
}

export async function computeSha256(text: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(text);
  if (typeof crypto !== "undefined" && crypto.subtle?.digest) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  if (Platform.isDesktop) {
    const nodeCrypto = await import("crypto");
    return nodeCrypto.createHash("sha256").update(text).digest("hex");
  }
  throw new Error("No crypto API available for sha256");
}

export interface PushResult {
  ok: boolean;
  conflict?: boolean;
  serverSha?: string;
  serverContent?: string;
  sha256?: string;
  error?: string;
  reason?: string;
}

export interface PushClient {
  pushFile: (
    path: string,
    baseSha256?: string,
    content?: string
  ) => Promise<{ ok: boolean; conflict?: boolean; current_sha256?: string; server_content?: string }>;
}

/**
 * Hash-guarded conditional push through pushFile() per ADR-13 & G-52.
 * Never binaries, last-synced hash per path in the device store;
 * On 409 the prompt points the agent at the server copy and a notice explains why.
 */
export async function pushFileWithGuard(
  app: App,
  file: TFile,
  client: PushClient,
  deviceStore?: Record<string, string>
): Promise<PushResult> {
  if (isBinaryFile(file)) {
    return {
      ok: false,
      error: "binary_refused",
      reason: "Never push binary files into remote vault",
    };
  }

  const content = await app.vault.read(file);
  if (content.includes("\x00")) {
    return {
      ok: false,
      error: "binary_refused",
      reason: "Refusing to push content containing null bytes",
    };
  }

  const sha = await computeSha256(content);
  const baseSha = deviceStore ? deviceStore[file.path] : undefined;

  const res = await client.pushFile(file.path, baseSha, content);

  if (res.conflict) {
    try {
      new Notice(`Host copy of "${file.name}" was modified. Remote agent will use the host copy.`);
    } catch {
      // ignore notice failures in test envs
    }
    return {
      ok: false,
      conflict: true,
      serverSha: res.current_sha256,
      serverContent: res.server_content,
      reason: "Host copy differs or is newer (409 Conflict)",
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: "push_failed",
      reason: "Failed to push file to remote host",
    };
  }

  if (deviceStore) {
    deviceStore[file.path] = sha;
  }

  return {
    ok: true,
    sha256: sha,
  };
}

export interface ChangedEntry {
  path: string;
  modified: number;
}

export interface SyncSession {
  changedSince: (since: number) => Promise<ChangedEntry[]>;
}

/**
 * Returns changed files between server-reported turn start and turn end (G-49, F-10).
 */
export async function listChangedSince(
  session: SyncSession,
  turnStartSec: number,
  turnEndSec?: number
): Promise<ChangedEntry[]> {
  const entries = await session.changedSince(turnStartSec);
  if (!turnEndSec) return entries;
  return entries.filter((e) => e.modified >= turnStartSec && e.modified <= turnEndSec + 2);
}

export interface PullClient {
  pullFile: (path: string) => Promise<string | null>;
}

export interface PullResult {
  ok: boolean;
  conflict?: boolean;
  reason?: string;
  error?: string;
}

/**
 * Explicit, conflict-checked pull of a file from host to client vault (G-49, F-10).
 */
export async function pullFileWithConflictCheck(
  app: App,
  client: PullClient,
  remotePath: string,
  deviceStore?: Record<string, string>,
  confirmOverride = false
): Promise<PullResult> {
  const remoteContent = await client.pullFile(remotePath);
  if (remoteContent === null) {
    return { ok: false, error: "not_found", reason: `Remote file ${remotePath} not found` };
  }

  const existing =
    app.vault.getAbstractFileByPath(remotePath) ?? app.vault.getFileByPath?.(remotePath);

  if (existing instanceof TFile) {
    const localContent = await app.vault.read(existing);
    const localSha = await computeSha256(localContent);
    const lastSyncedSha = deviceStore?.[remotePath];
    const remoteSha = await computeSha256(remoteContent);

    if (lastSyncedSha && localSha !== lastSyncedSha && localSha !== remoteSha && !confirmOverride) {
      return {
        ok: false,
        conflict: true,
        reason: "Local file has unsaved changes that would be overwritten",
      };
    }

    await app.vault.process(existing, () => remoteContent);
  } else {
    await app.vault.create(remotePath, remoteContent);
  }

  if (deviceStore) {
    deviceStore[remotePath] = await computeSha256(remoteContent);
  }

  return { ok: true };
}

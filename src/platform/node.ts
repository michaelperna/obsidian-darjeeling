import { Platform } from "obsidian";

export interface NodeProcess {
  platform: string;
  env: Record<string, string | undefined>;
  cwd?(): string;
}

export interface ChildProcessLike {
  pid?: number;
  killed?: boolean;
  stdout?: {
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    pipe?(dest: unknown): unknown;
    setEncoding(encoding: string): unknown;
  } | null;
  stderr?: {
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    setEncoding(encoding: string): unknown;
  } | null;
  stdin?: {
    write(chunk: unknown, encoding?: string): boolean;
    end(): unknown;
    destroyed?: boolean;
  } | null;
  stdio?: unknown[];
  kill(signal?: string | number): boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface NodeChildProcessModule {
  spawn(command: string, args?: readonly string[], options?: unknown): ChildProcessLike;
  exec(
    command: string,
    options: unknown,
    callback?: (error: Error | null, stdout: string, stderr?: string) => void
  ): unknown;
}

export interface NodeFsModule {
  existsSync(path: string): boolean;
  realpathSync(path: string): string;
  accessSync(path: string, mode?: number): void;
  constants: {
    X_OK: number;
    [key: string]: number;
  };
}

export interface NodePathModule {
  join(...paths: string[]): string;
  resolve(...paths: string[]): string;
  isAbsolute(path: string): boolean;
  dirname(path: string): string;
  basename(path: string): string;
  delimiter: string;
}

declare const require: ((id: string) => unknown) | undefined;

function getRequire(): ((id: string) => unknown) | null {
  if (typeof require === "function") return require;
  if (typeof window !== "undefined" && typeof (window as unknown as { require?: (id: string) => unknown }).require === "function") {
    return (window as unknown as { require: (id: string) => unknown }).require;
  }
  return null;
}

export function getNodeProcess(): NodeProcess | undefined {
  if (!Platform.isDesktopApp) return undefined;
  const req = getRequire();
  if (req) {
    try {
      const p = req("process") as NodeProcess;
      if (p && p.env) return p;
    } catch {
      /* ignore */
    }
  }
  const globalProcess = (globalThis as { process?: NodeProcess }).process;
  if (globalProcess?.env) {
    return globalProcess;
  }
  if (typeof window !== "undefined") {
    const win = window as unknown as { process?: NodeProcess };
    if (typeof win.process !== "undefined" && win.process?.env) return win.process;
  }
  return undefined;
}

export function getUserHome(): string {
  if (!Platform.isDesktopApp) return "";
  const req = getRequire();
  if (req) {
    try {
      const os = req("os") as { homedir?(): string };
      if (typeof os?.homedir === "function") {
        const h = os.homedir();
        if (h) return h;
      }
    } catch {
      /* ignore */
    }
  }
  const proc = getNodeProcess();
  return proc?.env?.HOME || proc?.env?.USERPROFILE || "";
}

export function getNodeChildProcess(): NodeChildProcessModule | null {
  if (!Platform.isDesktopApp) return null;
  const req = getRequire();
  if (req) {
    try {
      return req("child_process") as NodeChildProcessModule;
    } catch {
      return null;
    }
  }
  return null;
}

export function getNodeFs(): NodeFsModule | null {
  if (!Platform.isDesktopApp) return null;
  const req = getRequire();
  if (req) {
    try {
      return req("fs") as NodeFsModule;
    } catch {
      return null;
    }
  }
  return null;
}

export function getNodePath(): NodePathModule | null {
  if (!Platform.isDesktopApp) return null;
  const req = getRequire();
  if (req) {
    try {
      return req("path") as NodePathModule;
    } catch {
      return null;
    }
  }
  return null;
}

let cachedResolvedPath: string | null = null;
let pathResolutionPromise: Promise<string> | null = null;

/**
 * Checks if the local runtime is supported on the current platform.
 * Local CLI execution is supported on macOS and Linux desktop apps only.
 */
export function isLocalRuntimeSupported(): { supported: boolean; reason?: string } {
  if (!Platform.isDesktopApp) {
    return {
      supported: false,
      reason: "Local agent execution is only available in Obsidian Desktop.",
    };
  }
  if (Platform.isWin) {
    return {
      supported: false,
      reason: "Local agent execution is supported on macOS and Linux. On Windows, connect to a remote host.",
    };
  }
  return { supported: true };
}

/**
 * Returns common developer directories to prepend/append to PATH.
 */
export function getStaticDevDirs(): string[] {
  const home = getUserHome();
  const dirs = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
  ];
  if (home) {
    dirs.push(
      `${home}/.local/bin`,
      `${home}/.bun/bin`,
      `${home}/.cargo/bin`,
      `${home}/go/bin`,
      `${home}/.gemini/antigravity-cli/bin`
    );
  }
  dirs.push(
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  );
  return dirs.filter(Boolean);
}

/**
 * Merge an existing PATH string with standard developer tool directories.
 */
export function mergeStaticDirs(existingPath: string): string {
  const parts = existingPath ? existingPath.split(":").filter(Boolean) : [];
  const staticDirs = getStaticDevDirs();
  for (const dir of staticDirs) {
    if (!parts.includes(dir)) {
      parts.push(dir);
    }
  }
  return parts.join(":");
}

/**
 * Asynchronously resolves the full login shell PATH without blocking the UI thread.
 * Supports bash, zsh, and fish shells.
 */
export async function resolvePathAsync(): Promise<string> {
  if (!Platform.isDesktopApp || Platform.isWin) {
    const p = getNodeProcess()?.env?.PATH || "";
    cachedResolvedPath = p;
    return p;
  }

  if (cachedResolvedPath) {
    return cachedResolvedPath;
  }

  if (pathResolutionPromise) {
    return pathResolutionPromise;
  }

  pathResolutionPromise = new Promise<string>((resolve) => {
    try {
      const cp = getNodeChildProcess();
      if (!cp) {
        const fallback = mergeStaticDirs(getNodeProcess()?.env?.PATH || "");
        cachedResolvedPath = fallback;
        resolve(fallback);
        return;
      }

      const shell = getNodeProcess()?.env?.SHELL || (Platform.isMacOS ? "/bin/zsh" : "/bin/bash");
      const isFish = shell.endsWith("fish");

      const cmd = isFish
        ? `${shell} -l -c 'string join ":" $PATH'`
        : `${shell} -l -c 'echo "__DARJEELING_PATH__:$PATH"'`;

      cp.exec(
        cmd,
        {
          encoding: "utf8",
          timeout: 2500,
        },
        (err: Error | null, stdout: string) => {
          if (err || !stdout) {
            console.warn("[Darjeeling] Could not resolve login shell PATH:", err);
            const fallback = mergeStaticDirs(getNodeProcess()?.env?.PATH || "");
            cachedResolvedPath = fallback;
            resolve(fallback);
            return;
          }

          let resolvedPath = "";
          if (isFish) {
            resolvedPath = stdout.trim();
          } else {
            const match = stdout.match(/__DARJEELING_PATH__:(.*)/);
            if (match && match[1]) {
              resolvedPath = match[1].trim();
            }
          }

          if (!resolvedPath) {
            resolvedPath = getNodeProcess()?.env?.PATH || "";
          }

          cachedResolvedPath = mergeStaticDirs(resolvedPath);
          resolve(cachedResolvedPath);
        }
      );
    } catch (err) {
      console.warn("[Darjeeling] Error initiating PATH resolution:", err);
      const fallback = mergeStaticDirs(getNodeProcess()?.env?.PATH || "");
      cachedResolvedPath = fallback;
      resolve(fallback);
    }
  });

  return pathResolutionPromise;
}

/**
 * Returns the currently cached PATH, or an immediately available static-merged PATH.
 * Hot paths call this synchronously without blocking via execSync.
 */
export function getResolvedPath(): string {
  if (cachedResolvedPath) return cachedResolvedPath;
  const existing = getNodeProcess()?.env?.PATH || "";
  return mergeStaticDirs(existing);
}

/**
 * Checks whether Python 3 is available on the host for local PTY operations.
 */
export async function checkPython3Available(): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!Platform.isDesktopApp) {
    return { ok: false, error: "Desktop platform required" };
  }
  return new Promise((resolve) => {
    try {
      const cp = getNodeChildProcess();
      if (!cp) {
        resolve({ ok: false, error: "Node child_process module not available" });
        return;
      }
      const env = { ...(getNodeProcess()?.env || {}), PATH: getResolvedPath() };
      cp.exec("which python3", { env, timeout: 2000 }, (err: Error | null, stdout: string) => {
        if (!err && stdout.trim()) {
          resolve({ ok: true, path: stdout.trim() });
        } else {
          resolve({
            ok: false,
            error: "Python 3 is required for local terminal operations but was not found in PATH.",
          });
        }
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      resolve({ ok: false, error: msg });
    }
  });
}

/**
 * Safely checks if a file is executable.
 */
export function isExecutable(filePath: string): boolean {
  if (!Platform.isDesktopApp) return false;
  try {
    const fs = getNodeFs();
    if (!fs) return false;
    const real = fs.realpathSync(filePath);
    fs.accessSync(real, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a default executable shell on Desktop.
 */
export function resolveShell(preferredShell?: string): string {
  if (!Platform.isDesktopApp) return "sh";
  if (preferredShell && isExecutable(preferredShell)) return preferredShell;
  if (isExecutable("/bin/zsh")) return "/bin/zsh";
  if (isExecutable("/bin/bash")) return "/bin/bash";
  const envShell = getNodeProcess()?.env?.SHELL;
  if (envShell && isExecutable(envShell)) return envShell;
  return Platform.isWin ? "powershell.exe" : "sh";
}



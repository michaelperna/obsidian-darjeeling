import { Platform } from "obsidian";

// Python PTY bridge script for POSIX platforms (macOS / Linux)
// This creates a genuine Unix pseudo-terminal (pty) so interactive shells,
// ANSI colors, cursor positioning, and tools like agy, claude, fzf, vim work flawlessly.
const POSIX_PTY_SCRIPT = `
import sys, os, struct, selectors
from os import execvp, read, write, waitpid
from fcntl import ioctl
from pty import fork
from termios import TIOCSWINSZ

def write_all(fd, data):
    while data:
        n = write(fd, data)
        data = data[n:]

pid, pty_fd = fork()
if pid == 0:
    try:
        execvp(sys.argv[1], sys.argv[1:])
    except Exception as e:
        sys.stderr.write(f"Failed to exec {sys.argv[1]}: {e}\\n")
        sys.exit(127)

sel = selectors.DefaultSelector()

def pty_read():
    try:
        d = read(pty_fd, 4096)
        if d:
            write_all(1, d)
        else:
            sel.unregister(pty_fd)
    except:
        sel.unregister(pty_fd)

def stdin_read():
    try:
        d = read(0, 4096)
        if d:
            write_all(pty_fd, d)
        else:
            sel.unregister(0)
    except:
        sel.unregister(0)

def cmd_read():
    try:
        d = read(3, 4096)
        if d:
            for line in d.decode("utf-8", "ignore").splitlines():
                if "x" in line:
                    c, r = line.split("x", 1)
                    ioctl(pty_fd, TIOCSWINSZ, struct.pack("HHHH", int(r), int(c), 0, 0))
        else:
            sel.unregister(3)
    except:
        sel.unregister(3)

sel.register(pty_fd, selectors.EVENT_READ, pty_read)
sel.register(0, selectors.EVENT_READ, stdin_read)
sel.register(3, selectors.EVENT_READ, cmd_read)

while pty_fd in sel.get_map():
    for k, _ in sel.select():
        k.data()

try:
    _, status = waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
except:
    sys.exit(0)
`.trim();

export interface LocalProcessOptions {
  executable: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

import {
  getNodeChildProcess,
  getNodeFs,
  getNodeProcess,
  getResolvedPath,
  isExecutable,
  resolvePathAsync,
} from "./node";
export { isExecutable, resolvePathAsync };

export function getLoginShellPath(): string {
  return getResolvedPath();
}

/**
 * Enhanced PATH for Desktop Electron apps.
 * Electron launches from macOS Finder / Dock with a restricted PATH (/usr/bin:/bin:/usr/sbin:/sbin),
 * so user-installed CLI binaries in Homebrew, ~/.local/bin, bun, cargo, etc. are otherwise missing.
 */
export function getEnhancedEnv(customEnv?: Record<string, string>): Record<string, string> {
  if (!Platform.isDesktop) return customEnv ?? {};

  const resolvedPath = getLoginShellPath();
  const procEnv = (getNodeProcess()?.env ?? {}) as Record<string, string>;

  return {
    ...procEnv,
    PATH: resolvedPath,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    ...(customEnv ?? {}),
  };
}

/**
 * Returns default system shell for the platform.
 */
export function getDefaultShell(): string {
  if (!Platform.isDesktop) return "";
  const shell = getNodeProcess()?.env?.SHELL;
  if (shell) {
    return shell;
  }
  if (Platform.isMacOS) return "/bin/zsh";
  if (Platform.isLinux) return "/bin/bash";
  return "powershell.exe";
}

type LocalChildProcess = ReturnType<NonNullable<ReturnType<typeof getNodeChildProcess>>["spawn"]>;

/**
 * Cross-platform local terminal process runner.
 * Spawns child processes using Node child_process, wrapping POSIX with Python PTY bridge.
 */
export class LocalTerminalProcess {
  private proc: LocalChildProcess | null = null;
  private dataListeners: ((data: string) => void)[] = [];
  private exitListeners: ((code: number, signal?: string) => void)[] = [];
  private _isRunning = false;
  private _pid: number | undefined = undefined;

  constructor(private options: LocalProcessOptions) {
    if (!Platform.isDesktop) {
      throw new Error("Local terminal processes can only run on Obsidian Desktop.");
    }
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  get pid(): number | undefined {
    return this._pid;
  }

  async start(): Promise<void> {
    if (this._isRunning) return;

    const cp = getNodeChildProcess();
    if (!cp) {
      throw new Error("Local terminal processes require Node child_process.");
    }

    const fs = getNodeFs();
    const env = getEnhancedEnv(this.options.env);
    let cwd = this.options.cwd && fs?.existsSync(this.options.cwd) ? this.options.cwd : undefined;
    const procCwd = getNodeProcess()?.cwd?.();
    if (!cwd && procCwd && fs?.existsSync(procCwd)) {
      cwd = procCwd;
    }
    const cols = this.options.cols || 80;
    const rows = this.options.rows || 24;

    const executable = this.options.executable;
    const args = this.options.args || [];

    if (!Platform.isWin) {
      // Use Python PTY on macOS and Linux for full pseudo-terminal capabilities
      const pythonExe = "python3";
      const spawnArgs = ["-c", POSIX_PTY_SCRIPT, executable, ...args];

      try {
        this.proc = cp.spawn(pythonExe, spawnArgs, {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe", "pipe"], // fd 0, 1, 2, 3 (resize cmd)
          windowsHide: true,
        });
      } catch {
        // Fallback to direct spawn if python3 isn't available
        this.proc = cp.spawn(executable, args, {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      }
    } else {
      // Windows direct spawn
      this.proc = cp.spawn(executable, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: true,
      });
    }

    if (!this.proc) {
      throw new Error(`Failed to spawn process: ${executable}`);
    }

    this._isRunning = true;
    this._pid = this.proc.pid;

    // Set initial window size
    this.resize(cols, rows);

    this.proc.stdout?.on("data", (chunk: { toString(): string }) => {
      const text = chunk.toString();
      for (const listener of this.dataListeners) {
        listener(text);
      }
    });

    this.proc.stderr?.on("data", (chunk: { toString(): string }) => {
      const text = chunk.toString();
      for (const listener of this.dataListeners) {
        listener(text);
      }
    });

    this.proc.on("error", (err: Error) => {
      const msg = `\r\n\x1b[31m[Process Error: ${err.message}]\x1b[0m\r\n`;
      for (const listener of this.dataListeners) {
        listener(msg);
      }
    });

    this.proc.on("exit", (code: number | null, signal: string | null) => {
      this._isRunning = false;
      const exitCode = code ?? (signal ? 1 : 0);
      for (const listener of this.exitListeners) {
        listener(exitCode, signal ?? undefined);
      }
    });
  }

  onData(cb: (data: string) => void): void {
    this.dataListeners.push(cb);
  }

  onExit(cb: (code: number, signal?: string) => void): void {
    this.exitListeners.push(cb);
  }

  write(data: string): void {
    if (!this._isRunning || !this.proc?.stdin || this.proc.stdin.destroyed) return;
    try {
      this.proc.stdin.write(data);
    } catch (err) {
      console.warn("LocalTerminalProcess write error:", err);
    }
  }

  resize(cols: number, rows: number): void {
    if (!this._isRunning || !this.proc) return;
    // If we have fd 3 (python pty bridge), send cols x rows
    const cmdPipe = this.proc.stdio?.[3] as { write?(data: string): boolean; destroyed?: boolean } | null | undefined;
    if (cmdPipe && typeof cmdPipe.write === "function" && !cmdPipe.destroyed) {
      try {
        cmdPipe.write(`${cols}x${rows}\n`);
      } catch {
        /* ignore */
      }
    }
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): void {
    if (!this._isRunning || !this.proc) return;
    try {
      this.proc.kill(signal);
    } catch (err) {
      console.warn("LocalTerminalProcess kill error:", err);
    }
    this._isRunning = false;
  }
}

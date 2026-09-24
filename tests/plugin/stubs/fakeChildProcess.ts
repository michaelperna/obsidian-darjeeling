/**
 * Fake `child_process` for the local runtime (local agent CLI, terminal bridge).
 *
 *   const cp = installFakeChildProcess();
 *   cp.execSyncResult = "__DARJEELING_PATH__:/fake/bin\n";
 *   ... code under test calls require("child_process").spawn(...) ...
 *   const child = cp.lastChild!;
 *   child.stdout.write('{"type":"result"}\n');
 *   child.exit(0);
 *   cp.restore();
 *
 * Every spawn is recorded with its argv and options. A spawned child does
 * nothing on its own: the test writes its output and decides when it exits.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { overrideRequire } from "./nodeRequire";

export interface SpawnCall {
  command: string;
  args: string[];
  options: Record<string, unknown>;
  child: FakeChildProcess;
}

let nextPid = 42000;

export class FakeChildProcess extends EventEmitter {
  readonly pid = nextPid++;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** fd 0-2, plus one extra pipe per additional "pipe" entry in options.stdio. */
  readonly stdio: PassThrough[];
  /** Signals passed to kill(), in order. */
  readonly signals: (string | number)[] = [];
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  private stdinChunks: string[] = [];

  constructor(stdioSpec?: unknown) {
    super();
    const extra = Array.isArray(stdioSpec) ? Math.max(0, stdioSpec.length - 3) : 0;
    this.stdio = [this.stdin, this.stdout, this.stderr];
    for (let i = 0; i < extra; i++) this.stdio.push(new PassThrough());
    this.stdin.on("data", (chunk: Buffer | string) => this.stdinChunks.push(chunk.toString()));
  }

  /** Everything written to the child's stdin so far. */
  stdinText(): string {
    return this.stdinChunks.join("");
  }

  /** Everything written to an extra pipe (fd >= 3) so far. */
  pipeText(fd: number): string {
    const stream = this.stdio[fd];
    return stream ? (stream.read() ?? "").toString() : "";
  }

  kill(signal: string | number = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.killed = true;
    return true;
  }

  /** End the process the way Node reports it: "exit", then "close". */
  exit(code: number | null, signal: string | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }

  /** Emit a spawn failure, e.g. ENOENT for a missing binary. */
  fail(error: Error): void {
    this.emit("error", error);
  }
}

export interface FakeChildProcessControl {
  readonly spawns: SpawnCall[];
  readonly execSyncCalls: { command: string; options: unknown }[];
  readonly lastChild: FakeChildProcess | null;
  /** Returned by execSync; an Error instance is thrown instead. */
  execSyncResult: string | Error;
  /** Called for each spawn, e.g. to script output or throw. */
  onSpawn: ((call: SpawnCall) => void) | null;
  restore(): void;
}

export function installFakeChildProcess(): FakeChildProcessControl {
  const control: FakeChildProcessControl = {
    spawns: [],
    execSyncCalls: [],
    get lastChild() {
      return control.spawns.length ? control.spawns[control.spawns.length - 1].child : null;
    },
    execSyncResult: "",
    onSpawn: null,
    restore: () => undefined,
  };

  const spawn = (command: string, args: string[] = [], options: Record<string, unknown> = {}) => {
    const child = new FakeChildProcess(options.stdio);
    const call: SpawnCall = { command, args: [...args], options, child };
    control.spawns.push(call);
    control.onSpawn?.(call);
    return child;
  };

  const execSync = (command: string, options?: unknown) => {
    control.execSyncCalls.push({ command, options });
    if (control.execSyncResult instanceof Error) throw control.execSyncResult;
    return control.execSyncResult;
  };

  const unsupported = (name: string) => () => {
    throw new Error(`fake child_process: ${name} is not faked; add it to tests/plugin/stubs/fakeChildProcess.ts`);
  };

  control.restore = overrideRequire("child_process", {
    spawn,
    execSync,
    exec: unsupported("exec"),
    execFile: unsupported("execFile"),
    execFileSync: unsupported("execFileSync"),
    fork: unsupported("fork"),
  });
  return control;
}

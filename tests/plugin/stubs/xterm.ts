/**
 * Inert stand-ins for @xterm/xterm, @xterm/addon-fit and @xterm/addon-web-links.
 *
 * scripts/test.mjs aliases all three packages here: the real xterm needs a DOM
 * and a canvas. The Terminal records what the code under test writes and lets
 * the test feed keystrokes back through onData.
 */

type Disposable = { dispose(): void };

export class Terminal {
  cols = 80;
  rows = 24;
  options: Record<string, unknown>;
  modes = { bracketedPasteMode: false };
  /** Everything written with write()/writeln(), in order. */
  readonly written: string[] = [];
  buffer = { active: { length: 0, cursorY: 0, viewportY: 0, getLine: (_i: number) => undefined as any } };
  private dataListeners: ((data: string) => void)[] = [];
  private selection = "";

  constructor(options: Record<string, unknown> = {}) {
    this.options = { ...options };
  }

  open(_el: unknown): void {}
  loadAddon(_addon: unknown): void {}
  focus(): void {}
  blur(): void {}
  clear(): void {}
  reset(): void {}
  dispose(): void {}
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
  write(data: string): void {
    this.written.push(data);
  }
  writeln(data: string): void {
    this.written.push(`${data}\r\n`);
  }
  onData(listener: (data: string) => void): Disposable {
    this.dataListeners.push(listener);
    return { dispose: () => (this.dataListeners = this.dataListeners.filter((l) => l !== listener)) };
  }
  onResize(_listener: unknown): Disposable {
    return { dispose() {} };
  }
  attachCustomKeyEventHandler(_handler: unknown): void {}
  getSelection(): string {
    return this.selection;
  }
  hasSelection(): boolean {
    return this.selection.length > 0;
  }
  clearSelection(): void {
    this.selection = "";
  }
  selectAll(): void {}
  paste(data: string): void {
    this.type(data);
  }

  // --- test helpers ---------------------------------------------------------

  /** Deliver input as if the user typed it. */
  type(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
  setSelection(text: string): void {
    this.selection = text;
  }
}

export class FitAddon {
  fit(): void {}
  proposeDimensions(): { cols: number; rows: number } | undefined {
    return undefined;
  }
  activate(_terminal: unknown): void {}
  dispose(): void {}
}

export class WebLinksAddon {
  constructor(_handler?: unknown, _options?: unknown) {}
  activate(_terminal: unknown): void {}
  dispose(): void {}
}

/**
 * Commit a text field's value once the user is done typing, not per
 * keystroke: after `delayMs` of quiet, or immediately on flush() (wired to the
 * input's change / blur). The same value is never committed twice in a row,
 * so a blur after the debounce already fired does not reconnect again.
 */
export interface DeferredCommit {
  /** Record the latest value and (re)start the quiet timer. */
  input(value: string): void;
  /** Commit the pending value now, if any. */
  flush(): void;
  /** Drop the pending value without committing it. */
  cancel(): void;
}

export function deferredCommit(
  commit: (value: string) => void | Promise<void>,
  delayMs = 600
): DeferredCommit {
  let pending: string | null = null;
  let last: string | null = null;
  let timer: number | null = null;

  const clear = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const flush = () => {
    clear();
    if (pending === null) return;
    const value = pending;
    pending = null;
    if (value === last) return;
    last = value;
    void Promise.resolve()
      .then(() => commit(value))
      .catch(() => {
        // Let a retry of the same value go through.
        if (last === value) last = null;
      });
  };

  return {
    input(value: string) {
      pending = value;
      clear();
      timer = window.setTimeout(flush, delayMs);
    },
    flush,
    cancel() {
      clear();
      pending = null;
    },
  };
}

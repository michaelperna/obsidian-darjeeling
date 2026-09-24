/**
 * Swap a Node builtin that src/ loads with a lazy `require()`.
 *
 * src/ never imports Node modules at module scope (that would break plugin
 * load on mobile, ADR-22); it calls `require("child_process")` and friends
 * inside functions. scripts/test.mjs gives every test bundle a `require` that
 * checks these overrides first, so a test can hand src/ a fake module.
 *
 *   const restore = overrideRequire("fs", { ...fs, existsSync: () => true });
 *   try { ... } finally { restore(); }
 */
type Overrides = Record<string, unknown>;

function table(): Overrides {
  const g = globalThis as { __djRequireOverrides?: Overrides };
  g.__djRequireOverrides ??= {};
  return g.__djRequireOverrides;
}

/** `id` may carry the `node:` prefix; both spellings resolve to the fake. */
export function overrideRequire(id: string, fake: unknown): () => void {
  const key = id.replace(/^node:/, "");
  const overrides = table();
  const had = Object.prototype.hasOwnProperty.call(overrides, key);
  const previous = overrides[key];
  overrides[key] = fake;
  return () => {
    if (had) overrides[key] = previous;
    else delete overrides[key];
  };
}

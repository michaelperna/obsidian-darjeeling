import type { App } from "obsidian";
import type { DarjeelingSettings } from "./schema";

export interface SecretStorageApi {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

export interface AppWithSecrets {
  secretStorage?: SecretStorageApi;
  loadLocalStorage?(key: string): string | null;
  saveLocalStorage?(key: string, value: string | null): void;
}

/**
 * Secret storage abstraction (ADR-05).
 * Uses app.secretStorage when available and working, falling back to per-device
 * local storage (Obsidian's loadLocalStorage / window.localStorage) or in-memory.
 */
export class SecretStorage {
  private typedApp: AppWithSecrets;
  private memoryFallback = new Map<string, string>();
  /** Ids whose value lives only in memoryFallback (lost on restart). */
  private memoryOnly = new Set<string>();
  /**
   * Synchronous read-through cache of values this instance has read or
   * written, so sync callers (socket snapshots, "has key" UI) never need the
   * plaintext copy in settings.
   */
  private cache = new Map<string, string>();

  constructor(private app: App) {
    this.typedApp = app as unknown as AppWithSecrets;
  }

  generateSecretId(prefix = "dj_sec"): string {
    const rand = Math.random().toString(36).slice(2, 10);
    const ts = Date.now().toString(36);
    return `${prefix}_${rand}_${ts}`;
  }

  async getSecret(key: string): Promise<string | null> {
    if (!key) return null;

    if (this.memoryFallback.has(key)) {
      return this.memoryFallback.get(key) ?? null;
    }

    try {
      const storage = this.typedApp.secretStorage;
      if (storage?.getSecret) {
        const val = await storage.getSecret(key);
        if (typeof val === "string" && val.length > 0) return val;
      }
    } catch {
      /* fallback to local storage */
    }

    try {
      if (this.typedApp.loadLocalStorage) {
        const val = this.typedApp.loadLocalStorage(`dj_secret_${key}`);
        if (typeof val === "string" && val.length > 0) return val;
      }
    } catch {
      /* ignore */
    }

    try {
      if (typeof window !== "undefined" && window.localStorage) {
        const val = window.localStorage.getItem(`dj_secret_${key}`);
        if (typeof val === "string" && val.length > 0) return val;
      }
    } catch {
      /* ignore */
    }

    return null;
  }

  async setSecret(key: string, value: string): Promise<void> {
    if (!key) return;
    this.memoryOnly.delete(key);
    this.memoryFallback.delete(key);
    let stored = false;
    let lastError: Error | null = null;

    // Try app.secretStorage first, verifying it actually persisted
    try {
      const storage = this.typedApp.secretStorage;
      if (storage?.setSecret && storage?.getSecret) {
        await storage.setSecret(key, value);
        const check = await storage.getSecret(key);
        if (check === value) {
          return;
        }
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    // Fall back to Obsidian's app.saveLocalStorage
    try {
      if (this.typedApp.saveLocalStorage) {
        this.typedApp.saveLocalStorage(`dj_secret_${key}`, value);
        stored = true;
        return;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    // Fall back to browser localStorage
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem(`dj_secret_${key}`, value);
        stored = true;
        return;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    // Final fallback to in-memory map (not durable: callers holding the only
    // other copy must not delete it; see isDurable()).
    this.memoryFallback.set(key, value);
    this.memoryOnly.add(key);
    stored = true;

    if (!stored && lastError) {
      throw lastError;
    }
  }

  async deleteSecret(key: string): Promise<void> {
    if (!key) return;
    this.memoryFallback.delete(key);
    this.memoryOnly.delete(key);

    try {
      const storage = this.typedApp.secretStorage;
      if (storage?.deleteSecret) {
        await storage.deleteSecret(key);
      }
    } catch {
      /* fallback */
    }

    try {
      if (this.typedApp.saveLocalStorage) {
        this.typedApp.saveLocalStorage(`dj_secret_${key}`, null);
      }
    } catch {
      /* ignore */
    }

    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.removeItem(`dj_secret_${key}`);
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Copy -> verify pattern per ADR-04 / ADR-05.
   * Stores the secret value with a unique id, verifies read-back.
   * If keychain verification fails, preserves value in memory so the plugin never crashes.
   */
  async storeSecretWithVerification(value: string, prefix = "dj_sec"): Promise<string> {
    if (!value) return "";
    const id = this.generateSecretId(prefix);
    await this.setSecret(id, value);
    const read = await this.getSecret(id);
    if (read !== value) {
      this.memoryFallback.set(id, value);
      this.memoryOnly.add(id);
    }
    this.cache.set(id, value);
    return id;
  }

  /** True when the value for `key` survives a restart (not memory-only). */
  isDurable(key: string): boolean {
    return !!key && !this.memoryOnly.has(key);
  }

  /** Synchronous view of a value this instance has already read or written. */
  peek(key: string): string {
    return (key && this.cache.get(key)) || "";
  }

  /** Read a secret and remember it for synchronous peek(). */
  async load(key: string): Promise<string> {
    if (!key) return "";
    const val = (await this.getSecret(key)) || "";
    if (val) this.cache.set(key, val);
    else this.cache.delete(key);
    return val;
  }

  /** Store (or, for an empty value, delete) a secret and update the cache. */
  async save(key: string, value: string): Promise<void> {
    if (!key) return;
    if (!value) {
      this.cache.delete(key);
      await this.deleteSecret(key);
      return;
    }
    this.cache.set(key, value);
    await this.setSecret(key, value);
  }

  /** Update the synchronous cache immediately; persist in the background. */
  remember(key: string, value: string): void {
    if (!key) return;
    if (value) this.cache.set(key, value);
    else this.cache.delete(key);
  }

  /** Warm the cache for every secret id the settings reference. */
  async prime(settings: DarjeelingSettings): Promise<void> {
    const ids = new Set<string>();
    for (const slot of PROVIDER_SECRET_SLOTS) {
      const id = settings.providers?.[slot]?.apiKeySecretId;
      if (id) ids.add(id);
    }
    for (const h of settings.hosts ?? []) if (h.tokenSecretId) ids.add(h.tokenSecretId);
    for (const h of settings.remoteHosts ?? []) if (h.tokenSecretId) ids.add(h.tokenSecretId);
    ids.add(DEFAULT_TOKEN_SECRET_ID);
    await Promise.all([...ids].map((id) => this.load(id).catch(() => "")));
  }
}

// ---------------------------------------------------------------- helpers

export const DEFAULT_TOKEN_SECRET_ID = "dj_token";

/** providers[...] slots that hold an API key. */
export const PROVIDER_SECRET_SLOTS = ["gemini", "anthropic", "deepseek", "openaiCompatible"] as const;
export type ProviderSecretSlot = (typeof PROVIDER_SECRET_SLOTS)[number];

/** Which providers[...] entry stores the key for a direct provider (null: keyless). */
export function providerSecretSlot(provider: string): ProviderSecretSlot | null {
  switch (provider) {
    case "gemini":
    case "anthropic":
    case "deepseek":
      return provider;
    case "openai-compatible":
    case "openaiCompatible":
      return "openaiCompatible";
    default:
      return null;
  }
}

/** Secret id of the active host's token (hosts first, then legacy remoteHosts). */
export function activeTokenSecretId(settings: DarjeelingSettings): string {
  const activeHost = settings.hosts?.find((h) => h.id === settings.activeHostId);
  if (activeHost?.tokenSecretId) return activeHost.tokenSecretId;
  const remoteHost = settings.remoteHosts?.find(
    (h) => h.id === (settings.activeRemoteHostId || settings.activeHostId)
  );
  return remoteHost?.tokenSecretId || DEFAULT_TOKEN_SECRET_ID;
}

/** Read the API key for a direct provider from secret storage. */
export async function readProviderApiKey(
  secrets: SecretStorage | null | undefined,
  settings: DarjeelingSettings,
  provider: string
): Promise<string> {
  const slot = providerSecretSlot(provider);
  if (!slot || !secrets) return "";
  const id = settings.providers?.[slot]?.apiKeySecretId;
  if (!id) return "";
  return (await secrets.load(id)).trim();
}

/**
 * Save (or clear, when empty) the API key for a direct provider. Only the
 * secret id is kept in settings; the caller persists settings afterwards.
 */
export async function writeProviderApiKey(
  secrets: SecretStorage,
  settings: DarjeelingSettings,
  provider: string,
  value: string
): Promise<void> {
  const slot = providerSecretSlot(provider);
  if (!slot) return;
  const cfg = settings.providers[slot];
  const trimmed = value.trim();
  if (!trimmed) {
    if (cfg.apiKeySecretId) await secrets.save(cfg.apiKeySecretId, "");
    cfg.apiKeySecretId = "";
    return;
  }
  if (!cfg.apiKeySecretId) cfg.apiKeySecretId = secrets.generateSecretId(`dj_${slot}`);
  await secrets.save(cfg.apiKeySecretId, trimmed);
}

/** Synchronous "has key" check for UI state (cache primed at load). */
export function hasProviderApiKey(
  secrets: SecretStorage | null | undefined,
  settings: DarjeelingSettings,
  provider: string
): boolean {
  const slot = providerSecretSlot(provider);
  if (!slot) return false;
  const id = settings.providers?.[slot]?.apiKeySecretId;
  if (!id) return false;
  return secrets ? Boolean(secrets.peek(id)) : true;
}

/** Top-level legacy plaintext fields that must never reach data.json. */
export const PLAINTEXT_SECRET_FIELDS = [
  "authToken",
  "geminiApiKey",
  "anthropicApiKey",
  "deepseekApiKey",
  "openaiApiKey",
  "directApiKey",
] as const;

function isSecretField(key: string): boolean {
  return key === "authToken" || key === "token" || /apikey$/i.test(key);
}

function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretField(k)) continue;
      out[k] = stripSecrets(v);
    }
    return out;
  }
  return value;
}

/**
 * Legacy plaintext values that could not be stored durably (memory-only
 * fallback). They stay in data.json until a later load can move them, so a
 * restart never loses the only copy (copy -> verify -> delete).
 */
export interface RetainedPlaintext {
  top: Partial<Record<(typeof PLAINTEXT_SECRET_FIELDS)[number], string>>;
  hosts: Record<string, string>;
  remoteHosts: Record<string, string>;
}

export function emptyRetained(): RetainedPlaintext {
  return { top: {}, hosts: {}, remoteHosts: {} };
}

export function hasRetained(r: RetainedPlaintext): boolean {
  return (
    Object.values(r.top).some(Boolean) ||
    Object.keys(r.hosts).length > 0 ||
    Object.keys(r.remoteHosts).length > 0
  );
}

/** True if a raw data.json object still carries any plaintext secret. */
export function containsPlaintextSecrets(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPlaintextSecrets);
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretField(k) && typeof v === "string" && v.trim()) return true;
      if (containsPlaintextSecrets(v)) return true;
    }
  }
  return false;
}

/**
 * The object written to data.json: a copy of settings with every *ApiKey /
 * authToken field removed at any depth (hosts[], remoteHosts[] included).
 */
export function serializeSettings(
  settings: DarjeelingSettings,
  retained?: RetainedPlaintext
): Record<string, unknown> {
  const out = stripSecrets(settings) as Record<string, unknown>;
  delete out._readOnly;
  if (retained) {
    for (const [k, v] of Object.entries(retained.top)) if (v) out[k] = v;
    for (const [field, map] of [
      ["hosts", retained.hosts],
      ["remoteHosts", retained.remoteHosts],
    ] as const) {
      const list = out[field];
      if (!Array.isArray(list)) continue;
      for (const h of list as Array<Record<string, unknown>>) {
        const tok = typeof h.id === "string" ? map[h.id] : undefined;
        if (tok) h.authToken = tok;
      }
    }
  }
  return out;
}

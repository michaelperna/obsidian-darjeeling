import type { App } from "obsidian";

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

    // Final fallback to in-memory map
    this.memoryFallback.set(key, value);
    stored = true;

    if (!stored && lastError) {
      throw lastError;
    }
  }

  async deleteSecret(key: string): Promise<void> {
    if (!key) return;
    this.memoryFallback.delete(key);

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
    }
    return id;
  }
}

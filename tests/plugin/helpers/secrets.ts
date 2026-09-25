import { SecretStorage, writeProviderApiKey } from "../../../src/settings/secrets";
import type { DarjeelingSettings } from "../../../src/settings/schema";

/** Obsidian's rule for secretStorage ids (setSecret throws otherwise). */
function checkId(k: string): void {
  if (!/^[a-z0-9-]+$/.test(k)) throw new Error(`invalid secret id ${JSON.stringify(k)}`);
}

/**
 * An app whose secretStorage is a plain Map (durable for the test's lifetime).
 * Ids are validated like Obsidian's. `obsidian: true` mirrors the real 1.11.4
 * API exactly: synchronous methods and no deleteSecret.
 */
export function createSecretApp(opts: { obsidian?: boolean } = {}): {
  app: any;
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  const secretStorage: any = opts.obsidian
    ? {
        getSecret: (k: string) => store.get(k) ?? null,
        setSecret: (k: string, v: string) => {
          checkId(k);
          store.set(k, v);
        },
        listSecrets: () => [...store.keys()],
      }
    : {
        getSecret: async (k: string) => store.get(k) ?? null,
        setSecret: async (k: string, v: string) => {
          checkId(k);
          store.set(k, v);
        },
        deleteSecret: async (k: string) => {
          store.delete(k);
        },
      };
  return { app: { secretStorage }, store };
}

/** SecretStorage holding the given provider keys; settings get the secret ids. */
export async function secretsWithKeys(
  settings: DarjeelingSettings,
  keys: Record<string, string>
): Promise<SecretStorage> {
  const { app } = createSecretApp();
  const secrets = new SecretStorage(app);
  for (const [provider, key] of Object.entries(keys)) {
    await writeProviderApiKey(secrets, settings, provider, key);
  }
  return secrets;
}

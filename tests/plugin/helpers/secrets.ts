import { SecretStorage, writeProviderApiKey } from "../../../src/settings/secrets";
import type { DarjeelingSettings } from "../../../src/settings/schema";

/** An app whose secretStorage is a plain Map (durable for the test's lifetime). */
export function createSecretApp(): { app: any; store: Map<string, string> } {
  const store = new Map<string, string>();
  const app = {
    secretStorage: {
      getSecret: async (k: string) => store.get(k) ?? null,
      setSecret: async (k: string, v: string) => {
        store.set(k, v);
      },
      deleteSecret: async (k: string) => {
        store.delete(k);
      },
    },
  };
  return { app, store };
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

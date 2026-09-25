import { Notice, type App } from "obsidian";
import {
  createDefaultSettings,
  validateSettings,
  type DarjeelingSettings,
  type HostConfig,
  type RemoteHostConfig,
  type TerminalProfile,
} from "./schema";
import {
  DEFAULT_TOKEN_SECRET_ID,
  PLAINTEXT_SECRET_FIELDS,
  hostSecretId,
  providerSecretId,
  providerSecretSlot,
  type ProviderSecretSlot,
  type RetainedPlaintext,
  type SecretStorage,
} from "./secrets";
import { loadDeviceSettings, saveDeviceSettings } from "./device";

export const CURRENT_SETTINGS_VERSION = 1;

export interface MigrationResult {
  settings: DarjeelingSettings;
  isReadOnly: boolean;
  notices: string[];
}

/**
 * Pure settings migration step.
 * Migrates v0 or partial settings to v1 per ADR-04 / ADR-05.
 * Enforces the 5 sync safety rules.
 */
/**
 * Store `value` under the deterministic `id` and read it back.
 * Returns the id and whether the value is durably stored. A value that only
 * made it into the in-memory fallback is NOT durable: the caller must keep
 * its plaintext source (copy -> verify -> delete, Sync Rule 3).
 *
 * Ids are deterministic (providerSecretId / hostSecretId) so a second device
 * migrating the same data.json independently picks the same id.
 */
async function storeVerified(
  secrets: SecretStorage,
  id: string,
  value: string
): Promise<{ id: string; durable: boolean }> {
  let verified = false;
  try {
    await secrets.setSecret(id, value);
    verified = (await secrets.getSecret(id)) === value;
  } catch {
    verified = false;
  }
  secrets.remember(id, value);
  return { id, durable: verified && secrets.isDurable(id) };
}

const SLOT_FIELD: Record<ProviderSecretSlot, (typeof PLAINTEXT_SECRET_FIELDS)[number]> = {
  gemini: "geminiApiKey",
  anthropic: "anthropicApiKey",
  deepseek: "deepseekApiKey",
  openaiCompatible: "openaiApiKey",
};

/** Move plaintext provider keys from `stored` into secret storage. */
async function moveProviderKeys(
  stored: Record<string, unknown>,
  target: DarjeelingSettings,
  secrets: SecretStorage,
  retained: RetainedPlaintext | undefined,
  isV0: boolean
): Promise<void> {
  const str = (k: string): string => {
    const v = stored[k];
    return typeof v === "string" ? v.trim() : "";
  };
  const provider = str("directApiProvider") || target.directApiProvider;
  const deepseekApiKey = str("deepseekApiKey");
  const plan: Array<[(typeof PLAINTEXT_SECRET_FIELDS)[number], ProviderSecretSlot]> = [
    ["geminiApiKey", "gemini"],
    ["anthropicApiKey", "anthropic"],
    ["deepseekApiKey", "deepseek"],
    [
      "openaiApiKey",
      // v0 kept the DeepSeek key in openaiApiKey (the provider was OpenAI-shaped)
      isV0 && provider === "deepseek" && !deepseekApiKey ? "deepseek" : "openaiCompatible",
    ],
  ];
  const directSlot = providerSecretSlot(provider);
  if (directSlot && !plan.some(([f, slot]) => slot === directSlot && str(f))) {
    plan.push(["directApiKey", directSlot]);
  }

  for (const [field, slot] of plan) {
    const value = str(field);
    if (!value) continue;
    const cfg = target.providers[slot];
    const res = await storeVerified(secrets, providerSecretId(slot), value);
    cfg.apiKeySecretId = res.id;
    // Retain under the slot's own field so a later (v1) load maps it back
    // to the same provider.
    if (!res.durable && retained) retained.top[SLOT_FIELD[slot]] = value;
  }
}

/** Blank every plaintext secret field on the in-memory settings object. */
function blankPlaintextSecrets(target: DarjeelingSettings): void {
  for (const f of PLAINTEXT_SECRET_FIELDS) {
    (target as unknown as Record<string, unknown>)[f] = "";
  }
  for (const h of target.hosts ?? []) delete h.authToken;
  for (const h of target.remoteHosts ?? []) delete h.authToken;
}

/** v1 data written by <= 1.0.3 can still carry plaintext keys and tokens. */
async function moveV1Secrets(
  stored: Record<string, unknown>,
  target: DarjeelingSettings,
  secrets: SecretStorage,
  retained: RetainedPlaintext | undefined
): Promise<void> {
  await moveProviderKeys(stored, target, secrets, retained, false);

  for (const [list, bucket] of [
    [target.hosts ?? [], retained?.hosts],
    [target.remoteHosts ?? [], retained?.remoteHosts],
  ] as const) {
    for (const h of list as Array<HostConfig | RemoteHostConfig>) {
      const tok = typeof h.authToken === "string" ? h.authToken.trim() : "";
      if (!tok) continue;
      const res = await storeVerified(secrets, hostSecretId(h.id), tok);
      h.tokenSecretId = res.id;
      if (!res.durable && bucket) bucket[h.id] = tok;
    }
  }

  const topToken =
    (typeof stored.authToken === "string" && stored.authToken.trim()) ||
    (typeof stored.token === "string" && stored.token.trim()) ||
    "";
  if (topToken) {
    // The legacy top-level token belongs to the active host (hosts first,
    // then legacy remoteHosts), or to the host-less default slot.
    const owner: HostConfig | RemoteHostConfig | undefined =
      target.hosts?.find((h) => h.id === target.activeHostId) ??
      target.remoteHosts?.find(
        (h) => h.id === (target.activeRemoteHostId || target.activeHostId)
      );
    const res = await storeVerified(
      secrets,
      owner ? hostSecretId(owner.id) : DEFAULT_TOKEN_SECRET_ID,
      topToken
    );
    if (owner) owner.tokenSecretId = res.id;
    if (!res.durable && retained) retained.top.authToken = topToken;
  }

  blankPlaintextSecrets(target);
}

export async function migrateSettings(
  stored: Record<string, unknown>,
  secrets?: SecretStorage,
  app?: App,
  existingSettings?: DarjeelingSettings,
  retained?: RetainedPlaintext
): Promise<DarjeelingSettings> {
  // Sync Rule 1: Newer settings version than this client understands
  if (
    typeof stored.settingsVersion === "number" &&
    stored.settingsVersion > CURRENT_SETTINGS_VERSION
  ) {
    const msg = `Darjeeling: Settings file is from a newer version (v${stored.settingsVersion}). Running in read-only mode.`;
    new Notice(msg);
    const validated = validateSettings(stored);
    validated._readOnly = true;
    return validated;
  }

  // If already v1 and not re-migrating a v0 format
  if (stored.settingsVersion === CURRENT_SETTINGS_VERSION && stored.hosts) {
    const validated = validateSettings(structuredClone(stored));
    if (secrets) await moveV1Secrets(stored, validated, secrets, retained);
    return validated;
  }

  // v0 -> v1 Migration
  const base = existingSettings
    ? structuredClone(existingSettings)
    : createDefaultSettings();
  const notices: string[] = [];

  // Compatibility key aliases
  const meshnetHost =
    (stored.meshnetHost as string) ||
    (stored.host as string) ||
    base.meshnetHost ||
    "";
  const port =
    typeof stored.port === "number"
      ? stored.port
      : typeof stored.port === "string"
      ? parseInt(stored.port, 10) || 8765
      : base.port || 8765;
  const rawAuthToken =
    (stored.authToken as string) || (stored.token as string) || "";
  const remoteCwd =
    (stored.remoteCwd as string) || base.remoteCwd || "";

  // 1. Move secrets with Copy -> Verify -> Delete (Sync Rule 3)
  let tokenSecretId = base.hosts[0]?.tokenSecretId || "";
  if (rawAuthToken && secrets) {
    // With a host address the token belongs to the "primary" host built below.
    const res = await storeVerified(
      secrets,
      meshnetHost ? hostSecretId("primary") : DEFAULT_TOKEN_SECRET_ID,
      rawAuthToken
    );
    tokenSecretId = res.id;
    if (!res.durable && retained) retained.top.authToken = rawAuthToken;
  }

  if (secrets) {
    await moveProviderKeys(stored, base, secrets, retained, true);
  }

  const directApiProvider = (stored.directApiProvider as string) || base.activeProvider;
  if (typeof stored.openaiBaseUrl === "string") {
    const url = stored.openaiBaseUrl;
    if (directApiProvider === "deepseek") {
      base.providers.deepseek.baseUrl = url;
    } else {
      base.providers.openaiCompatible.baseUrl = url;
    }
  }
  if (typeof stored.openaiModel === "string") {
    const mdl = stored.openaiModel;
    if (directApiProvider === "deepseek") {
      base.providers.deepseek.model = mdl;
    } else {
      base.providers.openaiCompatible.model = mdl;
    }
  }

  // Setup hosts
  const hosts: HostConfig[] = [...base.hosts];
  if (meshnetHost) {
    const existingIndex = hosts.findIndex(
      (h) => h.baseUrl.includes(meshnetHost) || h.id === "primary"
    );
    const hostEntry: HostConfig = {
      id: "primary",
      name: "Primary Host",
      baseUrl: `http://${meshnetHost}:${port}`,
      tokenSecretId: tokenSecretId || (hosts[0]?.tokenSecretId ?? ""),
      cwd: remoteCwd,
    };
    if (existingIndex >= 0) {
      hosts[existingIndex] = hostEntry;
    } else {
      hosts.unshift(hostEntry);
    }
    base.activeHostId = "primary";
  }
  base.hosts = hosts;

  // Setup remoteHosts for backwards compatibility without plaintext tokens
  if (Array.isArray(stored.remoteHosts) && stored.remoteHosts.length > 0) {
    const cleanedRemoteHosts: RemoteHostConfig[] = [];
    for (const rh of stored.remoteHosts as RemoteHostConfig[]) {
      let rhTokenId = rh.tokenSecretId || "";
      if (rh.authToken && secrets) {
        const res = await storeVerified(secrets, hostSecretId(rh.id || "remote-host"), rh.authToken);
        rhTokenId = res.id;
        if (!res.durable && retained) retained.remoteHosts[rh.id || "remote-host"] = rh.authToken;
      }
      cleanedRemoteHosts.push({
        id: rh.id || "remote-host",
        name: rh.name || "Remote Host",
        host: rh.host || "",
        port: rh.port || 8765,
        tokenSecretId: rhTokenId,
        remoteCwd: rh.remoteCwd || "",
      });
    }
    base.remoteHosts = cleanedRemoteHosts;
  } else if (meshnetHost) {
    base.remoteHosts = [
      {
        id: "primary",
        name: "Primary Remote Host",
        host: meshnetHost,
        port,
        tokenSecretId,
        remoteCwd,
      },
    ];
    base.activeRemoteHostId = "primary";
  }

  // 2. Permission safety: reset bypassPermissions / acceptAll to "plan"
  const rawPerm =
    (stored.defaultPermissionMode as string) ||
    (stored.permissionMode as string) ||
    base.defaultPermissionMode;
  if (rawPerm === "bypassPermissions" || rawPerm === "acceptAll") {
    base.defaultPermissionMode = "plan";
    base.permissionMode = "plan";
    const msg = "Darjeeling: Permission mode has been reset to 'plan' for safety.";
    notices.push(msg);
    new Notice(msg);
  } else if (rawPerm === "acceptEdits") {
    base.defaultPermissionMode = "acceptEdits";
    base.permissionMode = "acceptEdits";
  } else {
    base.defaultPermissionMode = "plan";
    base.permissionMode = "plan";
  }

  // 3. Preserve Model IDs without silent remapping (ADR-08)
  const rawModel = stored.model as string | undefined;
  if (typeof rawModel === "string") {
    base.model = rawModel;
  }

  if (stored.harnessModels && typeof stored.harnessModels === "object") {
    const hm = stored.harnessModels as Record<string, string>;
    base.harnessModels = { ...base.harnessModels, ...hm };
  }

  // 4. Preserve user preferences
  if (typeof stored.artifactFolder === "string" && stored.artifactFolder.trim()) {
    base.artifactFolder = stored.artifactFolder.trim();
  }
  if (typeof stored.savePlansToVault === "boolean") {
    base.savePlansToVault = stored.savePlansToVault;
  }
  if (typeof stored.attachActiveNote === "boolean") {
    base.attachActiveNote = stored.attachActiveNote;
  } else if (typeof stored.autoSyncActiveNote === "boolean") {
    base.attachActiveNote = stored.autoSyncActiveNote;
  }
  if (typeof stored.agent === "string" && stored.agent) {
    base.agent = stored.agent;
  }
  if (typeof stored.fontSize === "number") {
    base.fontSize = stored.fontSize;
  }
  if (typeof stored.fontFamily === "string" && stored.fontFamily) {
    base.fontFamily = stored.fontFamily;
  }
  if (typeof stored.cursorBlink === "boolean") {
    base.cursorBlink = stored.cursorBlink;
  }
  if (typeof stored.activeTerminalProfileId === "string") {
    base.activeTerminalProfileId = stored.activeTerminalProfileId;
  }
  if (Array.isArray(stored.terminalProfiles) && stored.terminalProfiles.length > 0) {
    base.terminalProfiles = stored.terminalProfiles as TerminalProfile[];
  }
  if (typeof stored.hasCompletedOnboarding === "boolean") {
    base.hasCompletedOnboarding = stored.hasCompletedOnboarding;
    base.onboardingDone = stored.hasCompletedOnboarding;
  }
  if (typeof stored.onboardingDone === "boolean") {
    base.onboardingDone = stored.onboardingDone;
    base.hasCompletedOnboarding = stored.onboardingDone;
  }
  if (
    typeof stored.directApiProvider === "string" &&
    ["gemini", "anthropic", "openai-compatible", "openaiCompatible", "deepseek", "ollama"].includes(
      stored.directApiProvider
    )
  ) {
    base.directApiProvider = stored.directApiProvider as DarjeelingSettings["directApiProvider"];
  }
  if (
    typeof stored.runtimeMode === "string" &&
    (stored.runtimeMode === "remote" ||
      stored.runtimeMode === "direct-api" ||
      stored.runtimeMode === "local")
  ) {
    base.runtimeMode = stored.runtimeMode;
    if (app) {
      const dev = loadDeviceSettings(app);
      saveDeviceSettings(app, { ...dev, runtimeMode: stored.runtimeMode });
    }
  }

  // 5. Delete plaintext secrets from the settings object (ADR-05). Values
  // that could not be stored durably survive in `retained`, which
  // saveSettings writes back until a later load can move them.
  if (secrets) {
    blankPlaintextSecrets(base);
  }
  base.meshnetHost = meshnetHost;
  base.port = port;
  base.remoteCwd = remoteCwd;

  base.settingsVersion = CURRENT_SETTINGS_VERSION;
  return validateSettings(base);
}

/**
 * Sync Rule 4: A device that finds hosts but no local secret shows "Pair this device".
 */
export async function isHostPaired(
  host: HostConfig,
  secrets: SecretStorage
): Promise<boolean> {
  if (!host.tokenSecretId) {
    return false;
  }
  const secret = await secrets.getSecret(host.tokenSecretId);
  return Boolean(secret && secret.trim());
}

/**
 * Sync Rule 5: An unset per-device runtime shows runtime choice even when onboardingDone is synced.
 */
export function shouldPromptRuntimeChoice(
  _settings: DarjeelingSettings,
  app: App
): boolean {
  const device = loadDeviceSettings(app);
  return !device.runtimeMode;
}

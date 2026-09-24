import { Notice, type App } from "obsidian";
import {
  createDefaultSettings,
  validateSettings,
  type DarjeelingSettings,
  type HostConfig,
  type RemoteHostConfig,
  type TerminalProfile,
} from "./schema";
import type { SecretStorage } from "./secrets";
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
export async function migrateSettings(
  stored: Record<string, unknown>,
  secrets?: SecretStorage,
  app?: App,
  existingSettings?: DarjeelingSettings
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
    return validateSettings(stored);
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
    tokenSecretId = await secrets.storeSecretWithVerification(
      rawAuthToken,
      "dj_token"
    );
  }

  // Gemini API Key
  const geminiApiKey = (stored.geminiApiKey as string) || "";
  if (geminiApiKey && secrets) {
    const keyId = await secrets.storeSecretWithVerification(
      geminiApiKey,
      "dj_gemini"
    );
    base.providers.gemini.apiKeySecretId = keyId;
  }

  // Anthropic API Key
  const anthropicApiKey = (stored.anthropicApiKey as string) || "";
  if (anthropicApiKey && secrets) {
    const keyId = await secrets.storeSecretWithVerification(
      anthropicApiKey,
      "dj_anthropic"
    );
    base.providers.anthropic.apiKeySecretId = keyId;
  }

  // OpenAI / DeepSeek Key splitting
  const openaiApiKey = (stored.openaiApiKey as string) || "";
  const directApiProvider = (stored.directApiProvider as string) || base.activeProvider;
  if (openaiApiKey && secrets) {
    if (directApiProvider === "deepseek") {
      const keyId = await secrets.storeSecretWithVerification(
        openaiApiKey,
        "dj_deepseek"
      );
      base.providers.deepseek.apiKeySecretId = keyId;
    } else {
      const keyId = await secrets.storeSecretWithVerification(
        openaiApiKey,
        "dj_openai"
      );
      base.providers.openaiCompatible.apiKeySecretId = keyId;
    }
  }

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
        rhTokenId = await secrets.storeSecretWithVerification(
          rh.authToken,
          "dj_token"
        );
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

  // 5. Delete plaintext secrets from data.json (ADR-05)
  base.authToken = "";
  base.geminiApiKey = "";
  base.anthropicApiKey = "";
  base.openaiApiKey = "";
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

import type { DarjeelingPlan } from "../ui/plan/planTypes";
import type { ModelProbe } from "../net/agentClient";

export type ViewMode = "chat" | "plan" | "terminal" | "host";
export type RuntimeMode = "local" | "direct-api" | "remote";
export type DirectApiProvider =
  | "gemini"
  | "anthropic"
  | "openaiCompatible"
  | "openai-compatible"
  | "deepseek"
  | "ollama";
export type PermissionMode = "plan" | "acceptEdits";

export interface HostConfig {
  id: string;
  name: string;
  baseUrl: string;
  tokenSecretId: string;
  deviceId?: string;
  cwd?: string;
  authToken?: string;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKeySecretId: string;
  model: string;
}

export interface TerminalProfile {
  id: string;
  name: string;
  type: "local" | "remote";
  executable?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  sessionName?: string;
}

export interface RemoteHostConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  authToken?: string;
  tokenSecretId?: string;
  remoteCwd?: string;
}

export const DEFAULT_PROFILES: TerminalProfile[] = [
  {
    id: "local-shell",
    name: "Local shell",
    type: "local",
    executable: "",
    args: [],
  },
  {
    id: "remote-tmux",
    name: "Remote tmux",
    type: "remote",
    sessionName: "darjeeling",
  },
];

export interface DarjeelingSettings {
  settingsVersion: number;

  // Hosts & Connections (ADR-04)
  hosts: HostConfig[];
  activeHostId: string;

  // Direct Providers (ADR-04)
  providers: Record<DirectApiProvider, ProviderConfig>;
  activeProvider: DirectApiProvider;

  // Agent defaults
  agent: string;
  models: Record<string, string>;
  effort: string;
  agentEffort?: Record<string, string>;

  // Permissions (ADR-03)
  defaultPermissionMode: "plan" | "acceptEdits";

  // Context & Privacy (ADR-14)
  attachActiveNote: boolean;
  includeLinkedNotes?: boolean;
  /**
   * DARJEELING.md for direct (cloud) provider APIs. Opt-in: "none" by
   * default. CLI runtimes (local/remote) always get the vault instructions.
   */
  vaultContext: "none" | "instructions";
  sendNoteListing: boolean;
  instructionsFile: string;
  appendSystemPrompt: string;

  // Chat & UI
  enterToSend: boolean;
  streaming: boolean;
  artifactFolder: string;
  savePlansToVault: boolean;

  // Terminal & Shell
  terminalProfiles: TerminalProfile[];
  activeTerminalProfileId: string;
  fontSize: number;
  fontFamily: string;
  cursorBlink: boolean;
  macOptionIsMeta: boolean;
  prefixKey: string;
  palette: "theme";

  // Onboarding
  onboardingDone: boolean;

  // Backwards compatibility fields for existing UI components
  defaultMode: ViewMode;
  sessionName: string;
  autoPullArtifacts: boolean;
  lastAgentSessionId: string;
  previousAgentSessionId?: string;
  currentPlan?: DarjeelingPlan;
  modelProbes?: ModelProbe[];
  runtimeMode: RuntimeMode;
  directApiProvider: DirectApiProvider;
  hasCompletedOnboarding: boolean;
  meshnetHost: string;
  port: number;
  authToken: string;
  remoteHosts: RemoteHostConfig[];
  activeRemoteHostId: string;
  remoteCwd: string;
  model: string;
  fallbackModel: string;
  permissionMode: string;
  partialMessages: boolean;
  geminiApiKey: string;
  anthropicApiKey: string;
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  askHostOnNewSession?: boolean;
  mobileViewPlacement?: "main" | "sidebar";
  harnessModels?: Record<string, string>;
  sendWithCmdEnter?: boolean;
  totalCostUsd?: number;
  directApiKey?: string;
  _readOnly?: boolean;
}

export function createDefaultSettings(): DarjeelingSettings {
  const defaults: DarjeelingSettings = {
    settingsVersion: 1,
    hosts: [],
    activeHostId: "",
    providers: {
      gemini: {
        baseUrl: "https://generativelanguage.googleapis.com",
        apiKeySecretId: "",
        model: "gemini-3.8-flash",
      },
      anthropic: {
        baseUrl: "https://api.anthropic.com",
        apiKeySecretId: "",
        model: "claude-sonnet-5",
      },
      openaiCompatible: {
        baseUrl: "https://api.openai.com/v1",
        apiKeySecretId: "",
        model: "gpt-4o",
      },
      "openai-compatible": {
        baseUrl: "https://api.openai.com/v1",
        apiKeySecretId: "",
        model: "gpt-4o",
      },
      deepseek: {
        baseUrl: "https://api.deepseek.com",
        apiKeySecretId: "",
        model: "deepseek-chat",
      },
      ollama: {
        baseUrl: "http://localhost:11434",
        apiKeySecretId: "",
        model: "llama3.2",
      },
    },
    activeProvider: "gemini",
    agent: "claude",
    models: {
      claude: "",
      agy: "",
    },
    effort: "medium",
    agentEffort: {
      claude: "medium",
      agy: "medium",
    },
    defaultPermissionMode: "plan",
    attachActiveNote: true,
    includeLinkedNotes: false,
    vaultContext: "none",
    sendNoteListing: false,
    instructionsFile: "DARJEELING.md",
    appendSystemPrompt: "",
    enterToSend: true,
    streaming: true,
    artifactFolder: "Darjeeling",
    savePlansToVault: true,
    terminalProfiles: [
      {
        id: "local-shell",
        name: "Local shell",
        type: "local",
        executable: "",
        args: [],
      },
      {
        id: "remote-tmux",
        name: "Remote tmux",
        type: "remote",
        sessionName: "darjeeling",
      },
    ],
    activeTerminalProfileId: "local-shell",
    fontSize: 14,
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    cursorBlink: true,
    macOptionIsMeta: false,
    prefixKey: "C-b",
    palette: "theme",
    onboardingDone: false,

    // Compatibility fields
    defaultMode: "chat",
    sessionName: "darjeeling",
    autoPullArtifacts: true,
    lastAgentSessionId: "",
    runtimeMode: "local",
    directApiProvider: "gemini",
    hasCompletedOnboarding: false,
    meshnetHost: "",
    port: 8765,
    authToken: "",
    remoteHosts: [],
    activeRemoteHostId: "",
    remoteCwd: "",
    model: "",
    fallbackModel: "",
    permissionMode: "plan",
    partialMessages: false,
    geminiApiKey: "",
    anthropicApiKey: "",
    deepseekApiKey: "",
    deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-chat",
    ollamaBaseUrl: "http://localhost:11434",
    ollamaModel: "llama3.2",
    openaiApiKey: "",
    openaiBaseUrl: "https://api.openai.com/v1",
    openaiModel: "gpt-4o",
    askHostOnNewSession: true,
    mobileViewPlacement: "main",
    harnessModels: {
      agy: "gemini-3.8-flash-high",
      claude: "claude-opus-5",
      deepseek: "deepseek-chat",
      gemini: "gemini-3.8-flash",
      anthropic: "claude-sonnet-5",
      ollama: "llama3.2",
      openaiCompatible: "gpt-4o",
    },
  };

  return structuredClone(defaults);
}

export const DEFAULT_SETTINGS: DarjeelingSettings = createDefaultSettings();

const VALID_PROVIDERS: readonly DirectApiProvider[] = [
  "gemini",
  "anthropic",
  "openaiCompatible",
  "openai-compatible",
  "deepseek",
  "ollama",
];

export function validateSettings(settings: unknown): DarjeelingSettings {
  const defaults = createDefaultSettings();
  if (!settings || typeof settings !== "object") {
    return defaults;
  }
  const s = settings as Partial<DarjeelingSettings>;

  const validated: DarjeelingSettings = {
    ...defaults,
    ...s,
    settingsVersion: 1,
    hosts: Array.isArray(s.hosts) ? s.hosts : defaults.hosts,
    providers: s.providers
      ? { ...defaults.providers, ...s.providers }
      : defaults.providers,
    models: s.models ? { ...defaults.models, ...s.models } : defaults.models,
    effort: typeof s.effort === "string" ? s.effort : defaults.effort,
    agentEffort: s.agentEffort
      ? { ...defaults.agentEffort, ...s.agentEffort }
      : defaults.agentEffort,
    terminalProfiles: Array.isArray(s.terminalProfiles) && s.terminalProfiles.length > 0
      ? s.terminalProfiles
      : defaults.terminalProfiles,
  };

  // Enum validation
  if (
    validated.defaultPermissionMode !== "plan" &&
    validated.defaultPermissionMode !== "acceptEdits"
  ) {
    validated.defaultPermissionMode = "plan";
  }
  validated.permissionMode = validated.defaultPermissionMode;

  if (!VALID_PROVIDERS.includes(validated.activeProvider)) {
    validated.activeProvider = "gemini";
  }

  if (
    validated.vaultContext !== "none" &&
    validated.vaultContext !== "instructions"
  ) {
    validated.vaultContext = "none";
  }

  if (!validated.artifactFolder || !validated.artifactFolder.trim()) {
    validated.artifactFolder = "Darjeeling";
  }

  return validated;
}

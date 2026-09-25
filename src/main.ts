import {
  FileSystemAdapter,
  Notice,
  Platform,
  Plugin,
  type TFile,
  type WorkspaceLeaf,
} from "obsidian";
import {
  DARJEELING_VIEW_TYPE,
  DarjeelingView,
} from "./ui/view";
import {
  DEFAULT_SETTINGS,
  type DarjeelingSettings,
  type HostConfig,
  type ViewMode,
} from "./settings/schema";
import { migrateSettings } from "./settings/migrate";
import {
  MISSING_SECRET_MESSAGE,
  SecretStorage,
  activeTokenSecretId,
  containsPlaintextSecrets,
  emptyRetained,
  findMissingSecrets,
  hasRetained,
  resolveSecretIds,
  serializeSettings,
  type MissingSecret,
  type RetainedPlaintext,
} from "./settings/secrets";
import { loadDeviceSettings, saveDeviceSettings } from "./settings/device";
import { DarjeelingSettingTab } from "./settings/tab";
import { VaultHarness } from "./vault/harness";
import { SessionManager } from "./net/sessionManager";
import {
  AgentClient,
  type AgentDescriptor,
  type AgentEvent,
  type ConnectionState,
  type TurnOptions,
} from "./net/agentClient";
import type { DarjeelingChat } from "./ui/chat/chatView";
import type { DarjeelingPlanPanel } from "./ui/plan/planView";
import { PlanStore } from "./ui/plan/planStore";
import { planToMarkdown, type DarjeelingPlan } from "./ui/plan/planTypes";
import { generatePlanCanvas } from "./ui/plan/planCanvas";
import { registerIcons, DARJEELING_ICON } from "./ui/icons";
import { registerCommands } from "./commands";
import { refreshAgents } from "./runtime/agents";
import { runBufferedTurn } from "./runtime/bufferedTurn";
import { insertTextIntoActiveNote } from "./vault/insert";

import { getProviderClient } from "./runtime/providers";

export default class DarjeelingPlugin extends Plugin {
  settings: DarjeelingSettings = DEFAULT_SETTINGS;
  secretStorage!: SecretStorage;
  vaultHarness!: VaultHarness;
  sessionManager!: SessionManager;
  agentClient!: AgentClient;
  planStore!: PlanStore;

  chat: DarjeelingChat | null = null;
  plan: DarjeelingPlanPanel | null = null;

  availableAgents: AgentDescriptor[] = [];
  /** Legacy plaintext that could not be stored durably yet (never deleted early). */
  private retainedPlaintext: RetainedPlaintext = emptyRetained();
  deviceStore: Record<string, string> = {};

  get modelRegistry() {
    return {
      getProvider: (name: string) => {
        const client = getProviderClient(name);
        if (!client) return null;
        return {
          ...client,
          completeChat: async (
            config: import("./runtime/providers/types").ProviderConfig,
            messages: import("./runtime/providers/types").DirectChatMessage[],
            options?: Partial<import("./runtime/providers/types").ProviderTurnOptions>
          ) => {
            if (typeof client.completeChat === "function") {
              return await client.completeChat(config, messages, options);
            }
            const prompt = messages[messages.length - 1]?.content || "";
            return await client.call({ prompt, messages, ...options }, config);
          },
        };
      },
    };
  }

  get planEngine() {
    return {
      createPlan: (
        title: string,
        phases: Array<{
          id: string;
          title?: string;
          name?: string;
          intent?: string;
          tasks?: Array<{
            id: string;
            title?: string;
            text?: string;
            completed?: boolean;
            done?: boolean;
            files?: string[];
          }>;
        }>
      ): DarjeelingPlan => {
        const now = new Date().toISOString();
        return {
          id: `plan-${Date.now()}`,
          title,
          intent: "",
          createdAt: now,
          updatedAt: now,
          phases: phases.map((p, idx) => ({
            id: p.id || `p${idx + 1}`,
            name: p.title || p.name || `Phase ${idx + 1}`,
            intent: p.intent || "",
            status: "active",
            tasks: (p.tasks || []).map((t, tIdx) => ({
              id: t.id || `t${tIdx + 1}`,
              text: t.title || t.text || `Task ${tIdx + 1}`,
              done: t.completed ?? t.done ?? false,
              files: t.files || [],
            })),
          })),
          findings: [],
        };
      },
      exportToMarkdown: (plan: DarjeelingPlan): string => {
        return planToMarkdown(plan);
      },
      exportToCanvas: (plan: DarjeelingPlan) => {
        return generatePlanCanvas(plan, this.app);
      },
    };
  }

  async onload(): Promise<void> {
    await this.loadSettings();

    registerIcons();

    this.planStore = new PlanStore(this);
    this.vaultHarness = new VaultHarness(this.app, this.settings);
    this.sessionManager = new SessionManager(
      this.settings,
      () => this.agentClient?.getAuthToken() ?? ""
    );

    let vaultPath = "";
    if (this.app.vault.adapter instanceof FileSystemAdapter) {
      vaultPath = this.app.vault.adapter.getBasePath();
    }
    this.agentClient = new AgentClient(this.settings, vaultPath, this.app, this.secretStorage);

    // Secrets were primed in loadSettings; hand the host token to the client
    // (memory only, never mirrored into settings).
    const tok = this.secretStorage.peek(activeTokenSecretId(this.settings));
    if (tok) this.agentClient.adoptAuthToken(tok);

    this.registerView(
      DARJEELING_VIEW_TYPE,
      (leaf) => new DarjeelingView(leaf, this)
    );

    this.addRibbonIcon(DARJEELING_ICON, "Darjeeling: open", () => {
      void this.activate();
    });

    registerCommands(this);

    this.addSettingTab(new DarjeelingSettingTab(this.app, this));
  }

  onunload(): void {
    this.agentClient?.disconnect();
    this.agentClient?.destroy();
  }

  async addHost(host: HostConfig): Promise<void> {
    if (!this.settings.hosts) {
      this.settings.hosts = [];
    }
    const idx = this.settings.hosts.findIndex((h) => h.id === host.id);
    if (idx >= 0) {
      this.settings.hosts[idx] = host;
    } else {
      this.settings.hosts.push(host);
    }
    this.settings.activeHostId = host.id;
    if (host.baseUrl) {
      try {
        const u = new URL(host.baseUrl);
        this.settings.meshnetHost = u.hostname;
        if (u.port) this.settings.port = parseInt(u.port, 10);
      } catch {
        /* ignore invalid URL parse */
      }
    }
    await this.saveSettings();
    this.agentClient?.updateSettings(this.settings);
  }

  addListener(listener: (event: AgentEvent) => void): () => void {
    return this.agentClient.addListener(listener);
  }

  // ------------------------------------------------------------ view lifecycle

  public getViews(): DarjeelingView[] {
    return this.app.workspace
      .getLeavesOfType(DARJEELING_VIEW_TYPE)
      .map((l) => l.view)
      .filter((v): v is DarjeelingView => v instanceof DarjeelingView);
  }

  public get views(): Set<DarjeelingView> {
    return new Set(this.getViews());
  }

  /**
   * Reveal an existing Darjeeling leaf or create one.
   * If mobile, defaults to the placement configured in settings (main or sidebar).
   */
  async activate(mode?: ViewMode, preferSidebar = false): Promise<void> {
    const isMobile = Platform.isMobile;
    const placement = this.settings.mobileViewPlacement || "main";

    if (isMobile && placement === "main" && !preferSidebar) {
      return this.openInMainPanel(mode);
    }

    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const existing = workspace.getLeavesOfType(DARJEELING_VIEW_TYPE);

    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getRightLeaf(false) || workspace.getLeaf(true);
      if (leaf) {
        await leaf.setViewState({
          type: DARJEELING_VIEW_TYPE,
          active: true,
        });
      }
    }

    if (leaf) {
      void workspace.revealLeaf(leaf);
      if (mode && leaf.view instanceof DarjeelingView) {
        leaf.view.setMode(mode);
      }
    }
  }

  /**
   * Opens Darjeeling as a standard document tab in the main editor area.
   */
  async openInMainPanel(mode?: ViewMode): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(DARJEELING_VIEW_TYPE);

    // Look for an existing leaf in the root / main editor split
    for (const l of existing) {
      if (l.getRoot() === workspace.rootSplit) {
        void workspace.revealLeaf(l);
        if (mode && l.view instanceof DarjeelingView) {
          l.view.setMode(mode);
        }
        return;
      }
    }

    // Otherwise create a new tab in the active or main split
    const leaf = workspace.getLeaf("tab");
    if (leaf) {
      await leaf.setViewState({
        type: DARJEELING_VIEW_TYPE,
        active: true,
      });
      void workspace.revealLeaf(leaf);
      if (mode && leaf.view instanceof DarjeelingView) {
        leaf.view.setMode(mode);
      }
    }
  }

  /**
   * Explicitly opens or reveals Darjeeling in the right sidebar.
   */
  async openInRightSidebar(mode?: ViewMode): Promise<void> {
    return this.activate(mode, false);
  }

  attachView(_view: DarjeelingView): void {
    // Managed via workspace.getLeavesOfType
  }

  detachView(_view: DarjeelingView): void {
    if (this.getViews().length === 0) {
      this.chat = null;
      this.plan = null;
    }
  }

  registerChat(chat: DarjeelingChat): void {
    this.chat = chat;
  }

  registerPlan(plan: DarjeelingPlanPanel): void {
    this.plan = plan;
  }

  // ------------------------------------------------------------ UI bridging

  get agentLabel(): string {
    return (
      this.availableAgents.find((a) => a.key === this.settings.agent)?.label ??
      this.settings.agent
    );
  }

  onConnectionState(state: ConnectionState): void {
    for (const view of this.getViews()) view.setConnectionState(state);
    if (state === "open") void this.refreshAgents().then(() => this.refreshModelControls());
  }

  setBusy(busy: boolean, label?: string): void {
    for (const view of this.getViews()) view.setBusy(busy, label);
  }

  setHeaderDetail(text: string): void {
    for (const view of this.getViews()) view.setDetail(text);
  }

  setMode(mode: ViewMode): void {
    for (const view of this.getViews()) view.setMode(mode);
  }

  prefillChat(text: string): void {
    for (const view of this.getViews()) view.prefillChat(text);
  }

  noteInChat(markdown: string): void {
    for (const view of this.getViews()) view.noteInChat(markdown);
  }

  refreshTerminals(): void {
    for (const view of this.getViews()) view.refreshTerminalSettings();
  }

  refreshModelControls(): void {
    for (const view of this.getViews()) void view.refreshAgents();
  }

  // ----------------------------------------------------------------- agents

  async refreshAgents(): Promise<AgentDescriptor[]> {
    return refreshAgents(this);
  }

  async runBufferedTurn(options: TurnOptions): Promise<AgentEvent[] | null> {
    return runBufferedTurn(this, options);
  }

  async insertTextIntoActiveNote(text: string, attachedFile?: TFile | null): Promise<boolean> {
    return insertTextIntoActiveNote(this.app, text, attachedFile);
  }

  // --------------------------------------------------------------- settings

  async loadSettings(): Promise<void> {
    this.secretStorage = new SecretStorage(this.app);
    const stored = ((await this.loadData()) ?? {}) as Record<string, unknown>;
    this.retainedPlaintext = emptyRetained();
    this.settings = await migrateSettings(
      stored,
      this.secretStorage,
      this.app,
      this.settings,
      this.retainedPlaintext
    );
    // Old random secret ids -> deterministic ids, so devices sharing this
    // data.json agree on where each secret lives.
    const idsChanged =
      !this.settings._readOnly && (await resolveSecretIds(this.secretStorage, this.settings));
    await this.secretStorage.prime(this.settings);
    // Copy -> verify -> delete: once secrets are verified in secret storage,
    // rewrite data.json without the plaintext copies.
    if ((containsPlaintextSecrets(stored) || idsChanged) && !this.settings._readOnly) {
      await this.saveData(serializeSettings(this.settings, this.retainedPlaintext));
    }
    this.notifyMissingSecrets();
  }

  /**
   * Hosts / providers configured in synced settings whose secret is absent
   * on this device (another device migrated data.json, which no longer
   * carries plaintext secrets).
   */
  missingSecrets(): MissingSecret[] {
    return findMissingSecrets(this.secretStorage, this.settings);
  }

  /** One Notice per device for each newly missing secret (remembered locally). */
  private notifyMissingSecrets(): void {
    const missing = this.missingSecrets();
    const ids = missing.map((m) => `${m.kind}:${m.ref}`).sort();
    const device = loadDeviceSettings(this.app);
    const seen = new Set(device.missingSecretsNotified ?? []);
    if (missing.length && ids.some((id) => !seen.has(id))) {
      const labels = missing.map((m) => m.label).join(", ");
      new Notice(`Darjeeling: ${MISSING_SECRET_MESSAGE} Missing here: ${labels}.`, 15000);
    }
    if (ids.join("|") !== [...seen].sort().join("|")) {
      saveDeviceSettings(this.app, { ...device, missingSecretsNotified: ids });
    }
  }

  /** What saveSettings writes to data.json: settings minus every secret. */
  serializeForDisk(): Record<string, unknown> {
    return serializeSettings(
      this.settings,
      hasRetained(this.retainedPlaintext) ? this.retainedPlaintext : undefined
    );
  }

  async saveSettings(): Promise<void> {
    if (this.settings._readOnly) {
      return;
    }
    await this.saveData(this.serializeForDisk());
    this.vaultHarness?.updateSettings(this.settings);
    this.sessionManager?.updateSettings(this.settings);
    this.agentClient?.updateSettings(this.settings);
  }
}

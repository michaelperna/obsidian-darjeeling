import type DarjeelingPlugin from "../../main";
import { DarjeelingPlan, validatePlan } from "./planTypes";

export type PlanStoreListener = () => void;

/**
 * Shared in-memory and persisted state store for Darjeeling planning (PD-35, PD-33, PD-23).
 * Synchronizes multiple views and leaves without state divergence.
 */
export class PlanStore {
  private plugin: DarjeelingPlugin;
  private currentPlan: DarjeelingPlan | null = null;
  private activeTurnId: string | null = null;
  private busy = false;
  private busyLabel = "";
  private busyStartTime: number | null = null;
  private listeners: Set<PlanStoreListener> = new Set();

  constructor(plugin: DarjeelingPlugin) {
    this.plugin = plugin;
    this.currentPlan = validatePlan(plugin.settings.currentPlan);
    this.activeTurnId = this.currentPlan?.activeTurnId ?? null;
  }

  get plan(): DarjeelingPlan | null {
    return this.currentPlan;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  get label(): string {
    return this.busyLabel;
  }

  get startTime(): number | null {
    return this.busyStartTime;
  }

  get turnId(): string | null {
    return this.activeTurnId;
  }

  setTurnId(turnId: string | null): void {
    this.activeTurnId = turnId;
    if (this.currentPlan) {
      this.currentPlan.activeTurnId = turnId ?? undefined;
      void this.persist();
    }
    this.notify();
  }

  setBusy(busy: boolean, label = ""): void {
    this.busy = busy;
    this.busyLabel = label;
    this.busyStartTime = busy ? Date.now() : null;
    this.notify();
  }

  cancel(): void {
    this.busy = false;
    this.busyLabel = "";
    this.busyStartTime = null;
    this.activeTurnId = null;
    this.notify();
  }

  async setPlan(plan: DarjeelingPlan | null): Promise<void> {
    this.currentPlan = plan ? validatePlan(plan) : null;
    this.activeTurnId = this.currentPlan?.activeTurnId ?? null;
    await this.persist();
    this.notify();
  }

  async updatePlan(mutator: (plan: DarjeelingPlan) => void): Promise<void> {
    if (!this.currentPlan) return;
    mutator(this.currentPlan);
    this.currentPlan.updatedAt = new Date().toISOString();
    await this.persist();
    this.notify();
  }

  subscribe(listener: PlanStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error("[Darjeeling] PlanStore listener threw:", err);
      }
    }
  }

  private async persist(): Promise<void> {
    this.plugin.settings.currentPlan = this.currentPlan ?? undefined;
    await this.plugin.saveSettings();
  }
}

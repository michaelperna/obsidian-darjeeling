import type { App } from "obsidian";

interface AppWithSetting {
  setting?: {
    open?(): void;
    openTabById?(id: string): void;
  };
}

/**
 * Feature-checked helper to open Darjeeling settings tab in Obsidian (OBS-34).
 * Safely guards private app.setting access with feature checking.
 */
export function openDarjeelingSettings(app: App): boolean {
  try {
    const typed = app as unknown as AppWithSetting;
    if (typed.setting?.openTabById) {
      typed.setting.openTabById("darjeeling");
      return true;
    }
    if (typed.setting?.open) {
      typed.setting.open();
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

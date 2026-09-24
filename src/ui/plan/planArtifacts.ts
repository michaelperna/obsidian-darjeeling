import { App, Modal, Notice, Setting, SuggestModal, TFile, TFolder, normalizePath } from "obsidian";
import type DarjeelingPlugin from "../../main";
import type { SessionManager } from "../../net/sessionManager";
import { insertTextSafe } from "../../vault/insert";
import { generatePlanCanvas } from "./planCanvas";
import {
  DarjeelingPlan,
  planFromMarkdown,
  planToMarkdown,
  planToMarkdownBody,
} from "./planTypes";

export interface PlanConflictError extends Error {
  conflict: boolean;
  path: string;
}

/**
 * Generates a Unicode-aware slug preserving non-Latin characters (F-08, OBS-28).
 */
export function unicodeSlug(title: string): string {
  const cleaned = title
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 80) || "plan";
}


/**
 * Finds a unique artifact path, resolving collisions with -n suffix (PD-05, F-08).
 */
export async function getUniqueArtifactPath(
  app: App,
  folder: string,
  plan: DarjeelingPlan
): Promise<string> {
  const { vault } = app;

  function matchesPlanId(text: string, id: string): boolean {
    return new RegExp(`plan-id:\\s*["']?${id}["']?`).test(text);
  }

  if (plan.artifactPath) {
    const existing = vault.getFileByPath?.(plan.artifactPath) ?? vault.getAbstractFileByPath(plan.artifactPath);
    if (existing instanceof TFile) {
      try {
        const text = await vault.read(existing);
        if (matchesPlanId(text, plan.id)) {
          return plan.artifactPath;
        }
      } catch {
        // read failure, recalculate path
      }
    }
  }

  const slug = unicodeSlug(plan.title || plan.id || "plan");
  let candidate = normalizePath(`${folder}/${slug}.md`);

  const initial = vault.getFileByPath?.(candidate) ?? vault.getAbstractFileByPath(candidate);
  if (!initial) {
    return candidate;
  }

  if (initial instanceof TFile) {
    try {
      const text = await vault.read(initial);
      if (matchesPlanId(text, plan.id)) {
        return candidate;
      }
    } catch {
      // proceed to suffix
    }
  }

  let counter = 1;
  while (true) {
    candidate = normalizePath(`${folder}/${slug}-${counter}.md`);
    const check = vault.getFileByPath?.(candidate) ?? vault.getAbstractFileByPath(candidate);
    if (!check) {
      return candidate;
    }
    if (check instanceof TFile) {
      try {
        const text = await vault.read(check);
        if (matchesPlanId(text, plan.id)) {
          return candidate;
        }
      } catch {
        // continue
      }
    }
    counter++;
  }
}

/**
 * Write the plan into the vault and mirror to host with hash/mtime conflict checking (PD-05, PD-25).
 */
export async function ensureFolderExists(
  vault: App["vault"],
  folder: string
): Promise<void> {
  const normalized = normalizePath(folder);
  if (!normalized || normalized === "/" || normalized === ".") return;
  const existing = vault.getAbstractFileByPath(normalized);
  if (existing instanceof TFolder) return;
  if (existing) {
    throw new Error(`Path "${normalized}" already exists and is not a folder`);
  }
  try {
    await vault.createFolder(normalized);
  } catch (err) {
    const recheck = vault.getAbstractFileByPath(normalized);
    if (!(recheck instanceof TFolder)) {
      throw err;
    }
  }
}

export async function saveArtifact(
  plugin: DarjeelingPlugin,
  sessions: SessionManager,
  plan: DarjeelingPlan,
  announce: boolean,
  confirmOverride = false
): Promise<string> {
  const folder = plugin.settings.artifactFolder || "Darjeeling Plans";
  const path = await getUniqueArtifactPath(plugin.app, folder, plan);
  const markdown = planToMarkdown(plan);
  const { vault } = plugin.app;

  const parent = path.split("/").slice(0, -1).join("/");
  if (parent) {
    await ensureFolderExists(vault, parent);
  }

  const existing = vault.getFileByPath?.(path) ?? vault.getAbstractFileByPath(path);

  if (existing instanceof TFile) {
    const existingContent = await vault.read(existing);
    // If the file exists on disk and differs from what we're about to write:
    // require confirmation before overwriting an edited plan (PD-05)
    if (existingContent.trim() !== markdown.trim() && !confirmOverride) {
      if (/type:\s*["']?darjeeling-plan["']?/.test(existingContent)) {
        const err = new Error(
          `Plan artifact ${path} was modified externally. Confirmation required to overwrite.`
        ) as PlanConflictError;
        err.conflict = true;
        err.path = path;
        throw err;
      }
    }
    await vault.process(existing, () => markdown);
  } else {
    await vault.create(path, markdown);
  }

  plan.artifactPath = path;
  plan.updatedAt = new Date().toISOString();
  plugin.settings.currentPlan = plan;
  await plugin.saveSettings();

  // Mirror onto the host so the agent can read its own plan back
  const slug = unicodeSlug(plan.title || plan.id || "plan");
  try {
    await sessions.writeArtifact(`${slug}.md`, markdown);
  } catch (err) {
    console.warn("[Darjeeling] Could not mirror artifact to host:", err);
  }

  if (announce) {
    new Notice(`Saved to ${path}`);
  }

  return path;
}

/** Export active plan as an interactive Obsidian 2D Canvas (.canvas) */
export async function exportToCanvas(
  plugin: DarjeelingPlugin,
  plan: DarjeelingPlan
): Promise<void> {
  const folder = plugin.settings.artifactFolder || "Darjeeling Plans";
  const slug = unicodeSlug(plan.title || plan.id || "plan");
  const canvasPath = normalizePath(`${folder}/${slug}.canvas`);

  const canvasData = generatePlanCanvas(plan, plugin.app);
  const canvasJson = JSON.stringify(canvasData, null, 2);

  const { vault } = plugin.app;
  try {
    const parent = canvasPath.split("/").slice(0, -1).join("/");
    if (parent) {
      await ensureFolderExists(vault, parent);
    }
    const existing = vault.getFileByPath?.(canvasPath) ?? vault.getAbstractFileByPath(canvasPath);
    let targetFile: TFile;
    if (existing instanceof TFile) {
      await vault.modify(existing, canvasJson);
      targetFile = existing;
    } else {
      targetFile = await vault.create(canvasPath, canvasJson);
    }

    new Notice(`Canvas exported to ${canvasPath}`);

    const leaf = plugin.app.workspace.getLeaf(true);
    await leaf.openFile(targetFile);
  } catch (err) {
    new Notice(`Could not export canvas: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Insert active plan tasks directly into current note as body-only (CORE-02, PD-18) */
export async function insertPlanIntoActiveNote(
  plugin: DarjeelingPlugin,
  plan: DarjeelingPlan
): Promise<void> {
  const body = planToMarkdownBody(plan);
  await insertTextSafe(plugin.app, body, { isPlan: true });
}

/** Suggest modal for selecting and opening a plan artifact (OBS-28, PD-25) */
export class OpenPlanArtifactModal extends SuggestModal<TFile> {
  private plugin: DarjeelingPlugin;
  private onSelect: (plan: DarjeelingPlan) => void;

  constructor(
    plugin: DarjeelingPlugin,
    onSelect: (plan: DarjeelingPlan) => void
  ) {
    super(plugin.app);
    this.plugin = plugin;
    this.onSelect = onSelect;
    this.setPlaceholder("Select a Darjeeling plan artifact...");
  }

  getSuggestions(query: string): TFile[] {
    const folder = this.plugin.settings.artifactFolder || "Darjeeling Plans";
    const files = this.app.vault.getMarkdownFiles().filter((f: TFile) =>
      f.path.startsWith(folder) || f.path.includes("plan")
    );
    const q = query.toLowerCase();
    return files.filter((f: TFile) => f.path.toLowerCase().includes(q));
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.createDiv({ text: file.basename, cls: "darjeeling-suggest-title" });
    el.createEl("small", { text: file.path, cls: "darjeeling-suggest-path" });
  }

  onChooseSuggestion(file: TFile): void {
    void this.choosePlanArtifact(file);
  }

  private async choosePlanArtifact(file: TFile): Promise<void> {
    const content = await this.app.vault.read(file);
    const plan = planFromMarkdown(content);
    if (!plan) {
      new Notice(`${file.path} is not a valid Darjeeling plan.`);
      return;
    }

    const current = this.plugin.settings.currentPlan;
    if (current && current.id !== plan.id) {
      new ConfirmReplacePlanModal(this.plugin.app, () => {
        this.plugin.settings.currentPlan = plan;
        void this.plugin.saveSettings();
        this.onSelect(plan);
      }).open();
      return;
    }

    this.plugin.settings.currentPlan = plan;
    await this.plugin.saveSettings();
    this.onSelect(plan);
  }
}

/** Confirmation modal before replacing active plan (PD-25) */
export class ConfirmReplacePlanModal extends Modal {
  private onConfirm: () => void;

  constructor(app: App, onConfirm: () => void) {
    super(app);
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Replace current plan?" });
    contentEl.createEl("p", {
      text: "Opening another plan will replace the active plan in your session. Proceed?",
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Replace plan")
          .setCta()
          .onClick(() => {
            this.close();
            this.onConfirm();
          })
      )
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          this.close();
        })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Re-open a plan from an artifact the agent or a previous session wrote. */
export async function loadFromArtifact(
  sessions: SessionManager
): Promise<DarjeelingPlan | null> {
  const artifacts = await sessions.listArtifacts();
  if (!artifacts.length) {
    new Notice("No artifacts on the host yet.");
    return null;
  }
  const newest = artifacts.sort((a, b) => b.modified - a.modified)[0];
  const content = await sessions.readArtifact(newest.path);
  if (!content) {
    new Notice(`Could not read ${newest.path}`);
    return null;
  }
  const plan = planFromMarkdown(content);
  if (!plan) {
    new Notice(`${newest.path} is not a Darjeeling plan artifact.`);
    return null;
  }
  new Notice(`Loaded ${newest.path}`);
  return plan;
}

// planFromMarkdown is implemented in planTypes.ts and re-exported here for compatibility
export { planFromMarkdown };

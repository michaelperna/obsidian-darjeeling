import { App, TFile } from "obsidian";
import type { DarjeelingSettings } from "../settings/schema";

export interface VaultHarnessResult {
  source: "DARJEELING.md" | "CLAUDE.md" | "none" | "fallback";
  systemPrompt: string;
}

export class VaultHarness {
  constructor(private app: App, private settings: DarjeelingSettings) {}

  public updateSettings(settings: DarjeelingSettings): void {
    this.settings = settings;
  }

  /**
   * Resolves the primary vault harness file and builds the system prompt
   * adhering strictly to ADR-14 privacy defaults.
   */
  public async loadHarness(
    activeFilePath?: string,
    isDirectApi = false
  ): Promise<VaultHarnessResult> {
    const vaultName = this.app.vault.getName();
    const effectiveDirectApi =
      isDirectApi || this.settings.runtimeMode === "direct-api";

    let harnessContent = "";
    let source: "DARJEELING.md" | "CLAUDE.md" | "none" | "fallback" = "fallback";

    // ADR-14: DARJEELING.md is sent to direct providers only when the user opts in (vaultContext === "instructions").
    // CLAUDE.md is never read for third-party APIs (CLI agents read it themselves).
    if (this.settings.vaultContext === "instructions") {
      const instructionsPath = this.settings.instructionsFile || "DARJEELING.md";
      const instructionFile = this.app.vault.getAbstractFileByPath(instructionsPath);
      if (instructionFile instanceof TFile) {
        try {
          harnessContent = await this.app.vault.read(instructionFile);
          source = "DARJEELING.md";
        } catch (e) {
          console.warn(`[Darjeeling] Could not read ${instructionsPath}:`, e);
        }
      }

      // CLAUDE.md is ONLY checked for non-direct-api runs if DARJEELING.md was not found
      if (!harnessContent && !effectiveDirectApi) {
        const claudeFile = this.app.vault.getAbstractFileByPath("CLAUDE.md");
        if (claudeFile instanceof TFile) {
          try {
            harnessContent = await this.app.vault.read(claudeFile);
            source = "CLAUDE.md";
          } catch (e) {
            console.warn("[Darjeeling] Could not read CLAUDE.md:", e);
          }
        }
      }
    } else {
      source = "none";
    }

    const sections: string[] = [];

    // ADR-14: Default system prompt is one neutral line
    sections.push(
      `You are working inside the Obsidian vault "${vaultName}". Refer to notes with [[wikilinks]].`
    );

    // Active note awareness if attached
    if (activeFilePath && this.settings.attachActiveNote) {
      sections.push(`Active Note: ${activeFilePath}`);
    }

    // Note listing is off by default per ADR-14
    if (this.settings.sendNoteListing) {
      const mdFiles = this.app.vault.getMarkdownFiles();
      const sampleFiles = mdFiles
        .slice(0, 50)
        .map((f) => `- [[${f.basename}]] (${f.path})`);
      sections.push(`Vault Notes Sample:\n${sampleFiles.join("\n")}`);
    }

    // Instructions content if opted in
    if (harnessContent.trim()) {
      sections.push(`[Vault Instructions (${source})]\n${harnessContent.trim()}`);
    }

    // Custom user prompt if configured
    if (this.settings.appendSystemPrompt?.trim()) {
      sections.push(this.settings.appendSystemPrompt.trim());
    }

    return {
      source,
      systemPrompt: sections.join("\n\n"),
    };
  }
}

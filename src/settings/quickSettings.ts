import { App, Modal, setIcon } from "obsidian";
import type DarjeelingPlugin from "../main";
import { DarjeelingSettingTab } from "./tab";
import { openDarjeelingSettings } from "./openSettings";

export class DarjeelingQuickSettingsModal extends Modal {
  constructor(app: App, private plugin: DarjeelingPlugin) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("dj-settings-modal-window");

    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("darjeeling-root", "dj-settings-modal-content");

    const header = contentEl.createDiv({ cls: "dj-settings-modal-header" });
    const titleRow = header.createDiv({ cls: "dj-settings-modal-title-row" });
    const titleIcon = titleRow.createSpan({ cls: "dj-settings-modal-icon" });
    setIcon(titleIcon, "settings");
    titleRow.createEl("h2", { text: "Darjeeling settings" });

    const headerActions = header.createDiv({ cls: "dj-settings-modal-header-actions" });
    const fullBtn = headerActions.createEl("button", {
      cls: "dj-btn dj-btn-secondary",
    });
    const fullIcon = fullBtn.createSpan({ cls: "dj-btn-icon-prefix" });
    setIcon(fullIcon, "external-link");
    fullBtn.createSpan({ text: "Full settings" });
    fullBtn.title = "Open in Obsidian settings tab";
    fullBtn.addEventListener("click", () => {
      this.close();
      openDarjeelingSettings(this.app);
    });

    const closeBtn = headerActions.createEl("button", {
      cls: "dj-btn",
      text: "Done",
    });
    closeBtn.addEventListener("click", () => this.close());

    const body = contentEl.createDiv({ cls: "dj-settings-modal-body" });
    const tab = new DarjeelingSettingTab(this.app, this.plugin);
    tab.containerEl = body;
    tab.display();

    const footer = contentEl.createDiv({ cls: "dj-settings-modal-footer" });
    const statusNote = footer.createDiv({ cls: "dj-settings-modal-status" });
    const checkIcon = statusNote.createSpan({ cls: "dj-settings-status-icon" });
    setIcon(checkIcon, "check-circle");
    statusNote.createSpan({ text: "Changes auto-saved" });

    const footerBtns = footer.createDiv({ cls: "dj-settings-footer-buttons" });
    const doneBtn = footerBtns.createEl("button", {
      cls: "dj-btn dj-btn-primary",
      text: "Done",
    });
    doneBtn.addEventListener("click", () => this.close());
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}

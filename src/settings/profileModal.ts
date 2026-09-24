import { App, Modal, Setting } from "obsidian";
import type { TerminalProfile } from "./schema";

export class ProfileEditModal extends Modal {
  private profile: TerminalProfile;
  private onSave: (profile: TerminalProfile) => Promise<void>;

  constructor(
    app: App,
    profile: TerminalProfile,
    onSave: (profile: TerminalProfile) => Promise<void>
  ) {
    super(app);
    this.profile = { ...profile };
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", {
      text: this.profile.id ? "Edit Terminal Profile" : "New Terminal Profile",
    });

    new Setting(contentEl).setName("Profile Name").addText((text) =>
      text.setValue(this.profile.name).onChange((val) => {
        this.profile.name = val.trim();
      })
    );

    new Setting(contentEl)
      .setName("Type")
      .addDropdown((drop) =>
        drop
          .addOption("local", "Local Process (on this machine)")
          .addOption("remote", "Remote Host (tmux via WebSocket)")
          .setValue(this.profile.type)
          .onChange((val) => {
            this.profile.type = val as "local" | "remote";
            this.onOpen();
          })
      );

    if (this.profile.type === "local") {
      new Setting(contentEl)
        .setName("Executable / Command")
        .setDesc(
          "Command or path to executable (e.g. /bin/zsh, agy). Leave blank for default shell."
        )
        .addText((text) =>
          text.setValue(this.profile.executable || "").onChange((val) => {
            this.profile.executable = val.trim();
          })
        );

      new Setting(contentEl)
        .setName("Arguments")
        .setDesc("Command line arguments separated by space (e.g. -i or -l)")
        .addText((text) =>
          text.setValue((this.profile.args || []).join(" ")).onChange((val) => {
            this.profile.args = val.trim() ? val.trim().split(/\s+/) : [];
          })
        );

      new Setting(contentEl)
        .setName("Working Directory (CWD)")
        .setDesc("Working directory. Leave blank for vault root.")
        .addText((text) =>
          text.setValue(this.profile.cwd || "").onChange((val) => {
            this.profile.cwd = val.trim();
          })
        );
    } else {
      new Setting(contentEl)
        .setName("Remote tmux session")
        .setDesc("Session name on the remote host (e.g. darjeeling).")
        .addText((text) =>
          text.setValue(this.profile.sessionName || "darjeeling").onChange((val) => {
            this.profile.sessionName = val.trim() || "darjeeling";
          })
        );
    }

    const footer = contentEl.createDiv({ cls: "modal-button-container" });
    const saveBtn = footer.createEl("button", { cls: "mod-cta", text: "Save Profile" });
    saveBtn.onclick = async () => {
      if (!this.profile.name) this.profile.name = "Custom Shell";
      if (!this.profile.id) this.profile.id = "profile-" + Date.now();
      await this.onSave(this.profile);
      this.close();
    };

    const cancelBtn = footer.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => this.close();
  }
}

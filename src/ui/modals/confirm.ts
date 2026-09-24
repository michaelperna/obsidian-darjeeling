import { App, Modal, Setting } from "obsidian";

const confirmedConversations = new Set<string>();

export function isBypassConfirmedForConversation(conversationId?: string | null): boolean {
  if (!conversationId) return false;
  return confirmedConversations.has(conversationId);
}

export function setBypassConfirmedForConversation(conversationId: string): void {
  if (conversationId) {
    confirmedConversations.add(conversationId);
  }
}

export function clearBypassConfirmed(conversationId?: string): void {
  if (conversationId) {
    confirmedConversations.delete(conversationId);
  } else {
    confirmedConversations.clear();
  }
}

export interface ConfirmModalOptions {
  title?: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export class ConfirmModal extends Modal {
  private confirmed = false;
  private resolvePromise?: (value: boolean) => void;

  constructor(
    app: App,
    private options: ConfirmModalOptions = {}
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("dj-confirm-modal");

    const title = this.options.title ?? "Allow bypass permissions?";
    contentEl.createEl("h2", { text: title });

    const message =
      this.options.message ??
      "In bypass mode, the agent can execute shell commands, edit notes, and make tool calls without prompting for confirmation. Use with caution.";
    contentEl.createEl("p", { text: message, cls: "dj-confirm-desc" });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText(this.options.cancelLabel ?? "Cancel")
          .onClick(() => {
            this.confirmed = false;
            this.close();
          })
      )
      .addButton((btn) => {
        btn
          .setButtonText(this.options.confirmLabel ?? "Allow bypass")
          .setCta();
        if (this.options.destructive !== false) {
          btn.setDestructive();
        }
        btn.onClick(() => {
          this.confirmed = true;
          this.close();
        });
      });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
    if (this.resolvePromise) {
      this.resolvePromise(this.confirmed);
    }
  }

  async promptConfirm(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
}

/**
 * Prompts user to confirm bypassPermissions mode for a conversation if not already confirmed.
 */
export async function confirmBypassMode(
  app: App,
  conversationId?: string | null
): Promise<boolean> {
  if (conversationId && isBypassConfirmedForConversation(conversationId)) {
    return true;
  }

  const modal = new ConfirmModal(app, {
    title: "Switch to bypass permissions?",
    message:
      "Bypass mode grants the agent full permissions to execute arbitrary tools and edit vault files without interactive prompts. Do you want to enable this for this conversation?",
    confirmLabel: "Enable bypass",
    cancelLabel: "Cancel",
    destructive: true,
  });

  const confirmed = await modal.promptConfirm();
  if (confirmed && conversationId) {
    setBypassConfirmedForConversation(conversationId);
  }
  return confirmed;
}

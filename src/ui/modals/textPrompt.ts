import { App, Modal, Setting } from "obsidian";

export interface TextPromptOptions {
  title?: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export class TextPromptModal extends Modal {
  private value: string | null = null;
  private resolvePromise?: (value: string | null) => void;
  private inputEl: HTMLInputElement | null = null;

  constructor(
    app: App,
    private options: TextPromptOptions = {}
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("dj-prompt-modal");

    const title = this.options.title ?? "Input";
    contentEl.createEl("h2", { text: title });

    if (this.options.message) {
      contentEl.createEl("p", { text: this.options.message, cls: "dj-prompt-desc" });
    }

    const form = contentEl.createEl("form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.submit();
    });

    const setting = new Setting(form).addText((text) => {
      this.inputEl = text.inputEl;
      if (this.options.placeholder) {
        text.setPlaceholder(this.options.placeholder);
      }
      if (this.options.defaultValue) {
        text.setValue(this.options.defaultValue);
      }
      text.inputEl.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter") {
          evt.preventDefault();
          this.submit();
        }
      });
    });

    setting.addButton((btn) =>
      btn
        .setButtonText(this.options.cancelLabel ?? "Cancel")
        .onClick(() => {
          this.value = null;
          this.close();
        })
    );

    setting.addButton((btn) =>
      btn
        .setButtonText(this.options.confirmLabel ?? "OK")
        .setCta()
        .onClick(() => {
          this.submit();
        })
    );

    window.setTimeout(() => {
      this.inputEl?.focus();
      this.inputEl?.select();
    }, 10);
  }

  private submit(): void {
    this.value = this.inputEl?.value ?? "";
    this.close();
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
    if (this.resolvePromise) {
      this.resolvePromise(this.value);
    }
  }

  async prompt(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
}

export async function promptText(
  app: App,
  options: TextPromptOptions = {}
): Promise<string | null> {
  const modal = new TextPromptModal(app, options);
  return modal.prompt();
}

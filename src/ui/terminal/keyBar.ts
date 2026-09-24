import { setIcon } from "obsidian";

export interface KeyBarActions {
  copyFromTerminal: () => Promise<void>;
  pasteToTerminal: () => Promise<void>;
  showLinks: () => void;
  sendRaw: (data: string) => void;
  focusTerminal: () => void;
  isAppCursorMode?: () => boolean;
  prefixKey?: string;
  onToggleHide?: () => void;
}

type ModifierState = "off" | "once" | "locked";

export class DarjeelingKeyBar {
  private barEl: HTMLElement;
  private actions: KeyBarActions;

  private ctrlState: ModifierState = "off";
  private altState: ModifierState = "off";

  private ctrlBtn: HTMLButtonElement | null = null;
  private altBtn: HTMLButtonElement | null = null;

  private repeatTimer: number | null = null;
  private repeatInterval: number | null = null;

  constructor(container: HTMLElement, actions: KeyBarActions) {
    this.actions = actions;
    this.barEl = container.createDiv({ cls: "dj-keybar" });
    this.barEl.setAttribute("role", "toolbar");
    this.barEl.setAttribute("aria-label", "Terminal key bar");
    this.build();
  }

  get element(): HTMLElement {
    return this.barEl;
  }

  toggleHidden(hidden?: boolean): void {
    if (hidden === undefined) {
      this.barEl.classList.toggle("is-hidden");
    } else if (hidden) {
      this.barEl.classList.add("is-hidden");
    } else {
      this.barEl.classList.remove("is-hidden");
    }
  }

  private build(): void {
    this.barEl.empty();

    // Group 1: Modifiers and core control keys (PRD 1.11 / DM-29)
    const grp1 = this.barEl.createDiv({ cls: "dj-key-group" });
    this.buildModifiersAndCore(grp1);

    this.barEl.createDiv({ cls: "dj-keybar-sep" });

    // Group 2: Navigation with press-and-hold repeat (PRD 1.11 / VTH-18 / VTH-35)
    const grp2 = this.barEl.createDiv({ cls: "dj-key-group" });
    this.buildNavigation(grp2);

    this.barEl.createDiv({ cls: "dj-keybar-sep" });

    // Group 3: Tmux prefix and common symbols (PRD 1.11 / DM-29)
    const grp3 = this.barEl.createDiv({ cls: "dj-key-group" });
    this.buildPrefixAndSymbols(grp3);

    this.barEl.createDiv({ cls: "dj-keybar-sep" });

    // Group 4: Clipboard actions (VTH-17)
    const grp4 = this.barEl.createDiv({ cls: "dj-key-group" });
    this.buildClipboardActions(grp4);
  }

  /**
   * Sticky Ctrl and Alt:
   * - Tap once = one-shot (active for next key).
   * - Tap again / double tap = locked.
   * - Tap when locked = off.
   */
  private buildModifiersAndCore(group: HTMLElement): void {
    this.ctrlBtn = this.createButton(group, {
      label: "Ctrl",
      ariaLabel: "Control modifier key (tap once for next key, double tap to lock)",
      title: "Ctrl: tap once for next key, tap again to lock",
      cls: "dj-key dj-key-mod",
      onPress: () => {
        this.ctrlState = this.cycleModifier(this.ctrlState);
        this.updateModifierVisuals();
      },
    });

    this.altBtn = this.createButton(group, {
      label: "Alt",
      ariaLabel: "Alt modifier key (tap once for next key, double tap to lock)",
      title: "Alt: tap once for next key, tap again to lock",
      cls: "dj-key dj-key-mod",
      onPress: () => {
        this.altState = this.cycleModifier(this.altState);
        this.updateModifierVisuals();
      },
    });

    this.createKeyButton(group, {
      label: "Esc",
      ariaLabel: "Escape key",
      title: "Escape",
      data: "\x1b",
    });

    this.createKeyButton(group, {
      label: "Tab",
      ariaLabel: "Tab key",
      title: "Tab",
      data: "\t",
    });
  }

  private cycleModifier(current: ModifierState): ModifierState {
    if (current === "off") return "once";
    if (current === "once") return "locked";
    return "off";
  }

  private updateModifierVisuals(): void {
    if (this.ctrlBtn) {
      this.ctrlBtn.classList.toggle("is-active", this.ctrlState === "once");
      this.ctrlBtn.classList.toggle("is-locked", this.ctrlState === "locked");
    }
    if (this.altBtn) {
      this.altBtn.classList.toggle("is-active", this.altState === "once");
      this.altBtn.classList.toggle("is-locked", this.altState === "locked");
    }
  }

  /**
   * Navigation keys:
   * - Press-and-hold repeat for arrows.
   * - Respects applicationCursorKeysMode (VTH-35).
   * - Primary pointer button only (VTH-35).
   */
  private buildNavigation(group: HTMLElement): void {
    const arrows: { icon: string; dir: "up" | "down" | "left" | "right"; label: string }[] = [
      { icon: "arrow-up", dir: "up", label: "Arrow up" },
      { icon: "arrow-down", dir: "down", label: "Arrow down" },
      { icon: "arrow-left", dir: "left", label: "Arrow left" },
      { icon: "arrow-right", dir: "right", label: "Arrow right" },
    ];

    for (const arrow of arrows) {
      const btn = group.createEl("button", {
        cls: "dj-key",
        attr: { "aria-label": arrow.label, title: arrow.label },
      });
      setIcon(btn, arrow.icon);

      const sendArrow = () => {
        const isApp = this.actions.isAppCursorMode ? this.actions.isAppCursorMode() : false;
        let seq = "";
        switch (arrow.dir) {
          case "up":
            seq = isApp ? "\x1bOA" : "\x1b[A";
            break;
          case "down":
            seq = isApp ? "\x1bOB" : "\x1b[B";
            break;
          case "left":
            seq = isApp ? "\x1bOD" : "\x1b[D";
            break;
          case "right":
            seq = isApp ? "\x1bOC" : "\x1b[C";
            break;
        }
        this.emitSequence(seq);
      };

      // Pointerdown starts repeat; primary button only (VTH-35)
      btn.addEventListener("pointerdown", (event: PointerEvent) => {
        if (event.button !== 0) return;
        event.preventDefault();
        sendArrow();
        this.actions.focusTerminal();

        this.clearRepeat();
        this.repeatTimer = window.setTimeout(() => {
          this.repeatInterval = window.setInterval(sendArrow, 80);
        }, 400);
      });

      const stopRepeat = () => this.clearRepeat();
      btn.addEventListener("pointerup", stopRepeat);
      btn.addEventListener("pointercancel", stopRepeat);
      btn.addEventListener("pointerleave", stopRepeat);
    }

    this.createKeyButton(group, {
      label: "PgUp",
      ariaLabel: "Page Up",
      title: "Page Up",
      data: "\x1b[5~",
    });

    this.createKeyButton(group, {
      label: "PgDn",
      ariaLabel: "Page Down",
      title: "Page Down",
      data: "\x1b[6~",
    });
  }

  private clearRepeat(): void {
    if (this.repeatTimer !== null) {
      window.clearTimeout(this.repeatTimer);
      this.repeatTimer = null;
    }
    if (this.repeatInterval !== null) {
      window.clearInterval(this.repeatInterval);
      this.repeatInterval = null;
    }
  }

  /**
   * Tmux prefix and common symbols.
   */
  private buildPrefixAndSymbols(group: HTMLElement): void {
    // Configurable tmux prefix key (default C-b / \x02)
    const prefixData = this.actions.prefixKey || "\x02";
    this.createKeyButton(group, {
      label: "Prefix",
      ariaLabel: "Tmux prefix key (Ctrl-B)",
      title: "Tmux prefix (Ctrl-B)",
      data: prefixData,
      cls: "dj-key dj-key-wide",
    });

    const symbols: { label: string; data: string; ariaLabel: string }[] = [
      { label: "|", data: "|", ariaLabel: "Pipe symbol" },
      { label: "~", data: "~", ariaLabel: "Tilde symbol" },
      { label: "/", data: "/", ariaLabel: "Slash symbol" },
      { label: "-", data: "-", ariaLabel: "Hyphen minus symbol" },
      { label: "`", data: "`", ariaLabel: "Backtick symbol" },
    ];

    for (const sym of symbols) {
      this.createKeyButton(group, {
        label: sym.label,
        ariaLabel: sym.ariaLabel,
        title: sym.label,
        data: sym.data,
      });
    }

    // Enter / Return
    const enterBtn = group.createEl("button", {
      cls: "dj-key",
      attr: { "aria-label": "Enter key", title: "Enter" },
    });
    setIcon(enterBtn, "corner-down-left");
    enterBtn.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      this.emitSequence("\r");
      this.actions.focusTerminal();
    });
  }

  /**
   * Clipboard actions:
   * Pointerdown calls preventDefault() only to retain terminal focus.
   * Click executes the clipboard operation (VTH-17).
   */
  private buildClipboardActions(group: HTMLElement): void {
    const clipActions: { label: string; ariaLabel: string; title: string; run: () => void }[] = [
      {
        label: "copy",
        ariaLabel: "Copy terminal selection",
        title: "Copy selection (or screen)",
        run: () => void this.actions.copyFromTerminal(),
      },
      {
        label: "paste",
        ariaLabel: "Paste clipboard text into terminal",
        title: "Paste clipboard",
        run: () => void this.actions.pasteToTerminal(),
      },
      {
        label: "links",
        ariaLabel: "Find and display URLs on screen",
        title: "Find URLs on screen",
        run: () => this.actions.showLinks(),
      },
    ];

    for (const action of clipActions) {
      const btn = group.createEl("button", {
        cls: "dj-key dj-key-wide",
        text: action.label,
        attr: { "aria-label": action.ariaLabel, title: action.title },
      });

      btn.addEventListener("pointerdown", (event: PointerEvent) => {
        if (event.button !== 0) return;
        // Prevent loss of focus in webview without triggering action (VTH-17)
        event.preventDefault();
      });

      btn.addEventListener("click", (event: MouseEvent) => {
        if (event.button !== 0) return;
        action.run();
        this.actions.focusTerminal();
      });
    }
  }

  private createKeyButton(
    group: HTMLElement,
    spec: { label: string; ariaLabel: string; title: string; data: string; cls?: string }
  ): HTMLButtonElement {
    const btn = group.createEl("button", {
      cls: spec.cls ?? "dj-key",
      text: spec.label,
      attr: { "aria-label": spec.ariaLabel, title: spec.title },
    });

    btn.addEventListener("pointerdown", (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      this.emitSequence(spec.data);
      this.actions.focusTerminal();
    });

    return btn;
  }

  private createButton(
    group: HTMLElement,
    spec: { label: string; ariaLabel: string; title: string; cls?: string; onPress: () => void }
  ): HTMLButtonElement {
    const btn = group.createEl("button", {
      cls: spec.cls ?? "dj-key",
      text: spec.label,
      attr: { "aria-label": spec.ariaLabel, title: spec.title },
    });

    btn.addEventListener("pointerdown", (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      spec.onPress();
      this.actions.focusTerminal();
    });

    return btn;
  }

  /**
   * Applies active Ctrl / Alt modifier transformations to an input character or sequence.
   */
  public transformInput(data: string): string {
    let out = data;

    // Apply Ctrl modifier
    if (this.ctrlState !== "off") {
      if (out.length === 1) {
        const code = out.charCodeAt(0);
        if (code >= 97 && code <= 122) {
          // a-z -> \x01-\x1a
          out = String.fromCharCode(code - 96);
        } else if (code >= 65 && code <= 90) {
          // A-Z -> \x01-\x1a
          out = String.fromCharCode(code - 64);
        } else if (out === "[") {
          out = "\x1b";
        } else if (out === "\\") {
          out = "\x1c";
        } else if (out === "]") {
          out = "\x1d";
        } else if (out === "^") {
          out = "\x1e";
        } else if (out === "_") {
          out = "\x1f";
        } else if (out === "?") {
          out = "\x7f";
        } else if (out === "@") {
          out = "\x00";
        }
      }
      if (this.ctrlState === "once") {
        this.ctrlState = "off";
      }
    }

    // Apply Alt modifier (prepend ESC)
    if (this.altState !== "off") {
      out = "\x1b" + out;
      if (this.altState === "once") {
        this.altState = "off";
      }
    }

    this.updateModifierVisuals();
    return out;
  }

  /**
   * Emits data sequence applying active Ctrl / Alt modifier transformations.
   */
  public emitSequence(data: string): void {
    const transformed = this.transformInput(data);
    this.actions.sendRaw(transformed);
  }
}

/** Legacy helper wrapping DarjeelingKeyBar */
export function buildKeyBar(pane: HTMLElement, actions: KeyBarActions): HTMLElement {
  const kb = new DarjeelingKeyBar(pane, actions);
  return kb.element;
}

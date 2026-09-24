import { Menu, Platform, setIcon } from "obsidian";
import type { DarjeelingChat } from "./chatView";

export interface QuickAction {
  label: string;
  prompt: string;
  permissionMode?: string;
  icon?: string;
}

export const QUICK_ACTIONS: QuickAction[] = [
  {
    label: "Review note",
    prompt:
      "Read the attached note and review it: unclear claims, missing edge cases, " +
      "what a reader would push back on. Be specific and quote the note.",
    permissionMode: "plan",
    icon: "file-search",
  },
  {
    label: "Summarise",
    prompt:
      "Summarise the attached note: decisions made, action items with owners, " +
      "and open questions. Keep it tight.",
    permissionMode: "plan",
    icon: "align-left",
  },
  {
    label: "Challenge",
    prompt:
      "Argue against the position in the attached note. Find the weakest link in " +
      "the reasoning and say what evidence would change the conclusion.",
    permissionMode: "plan",
    icon: "swords",
  },
  {
    label: "Search vault",
    prompt: "Search the vault for everything relevant to: ",
    permissionMode: "plan",
    icon: "search",
  },
];

export interface ComposerElements {
  composerEl: HTMLElement;
  notePillEl: HTMLElement;
  attachEl: HTMLInputElement;
  inputEl: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  quickMenuBtn?: HTMLButtonElement;
}

export function getComposerPlaceholder(settings: { sendWithCmdEnter?: boolean; enterToSend?: boolean }): string {
  const isTouchOnly =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches &&
    !window.matchMedia("(pointer: fine)").matches;

  if (isTouchOnly && !settings.enterToSend) {
    return "Ask Darjeeling… (tap Send to send)";
  }
  const sendWithCmd = settings.sendWithCmdEnter === true;
  if (sendWithCmd) {
    return `Ask Darjeeling… (${Platform.isMacOS ? "Cmd" : "Ctrl"}+Enter to send)`;
  }
  return "Ask Darjeeling… (Enter to send, Shift+Enter for a newline)";
}

export function buildComposer(
  chat: DarjeelingChat,
  hostEl: HTMLElement
): ComposerElements {
  const plugin = chat.getPlugin();
  const composerEl = hostEl.createDiv({ cls: "dj-composer-island" });

  const context = composerEl.createDiv({ cls: "dj-context-capsule" });
  const notePillEl = context.createDiv({ cls: "dj-pill" });

  const toggle = context.createEl("label", { cls: "dj-toggle" });
  const attachEl = toggle.createEl("input", { type: "checkbox" });
  attachEl.checked = plugin.settings.attachActiveNote;
  toggle.createSpan({ text: "Attach note" });
  attachEl.addEventListener("change", () => {
    void (async () => {
      plugin.settings.attachActiveNote = !!attachEl.checked;
      await plugin.saveSettings();
      chat.paintNotePill();
    })();
  });

  const placeholderText = getComposerPlaceholder(plugin.settings);

  const inputEl = composerEl.createEl("textarea", {
    cls: "dj-composer-textarea",
    attr: {
      rows: "1",
      placeholder: placeholderText,
      "aria-label": "Darjeeling prompt",
    },
  });

  const syncInputState = () => {
    chat.growInput();
    const hasText = inputEl.value.trim().length > 0;
    composerEl.classList.toggle("has-input", hasText);
  };

  inputEl.addEventListener("input", syncInputState);
  inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.isComposing) return;

    // Hardware Cmd+Enter or Ctrl+Enter always sends
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void chat.send();
      return;
    }

    const isTouchOnly =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches &&
      !window.matchMedia("(pointer: fine)").matches;

    if (isTouchOnly && !plugin.settings.enterToSend) {
      // DM-07, CHAT-45: Soft keyboard Return key inserts a newline on touch devices.
      // Tapping Send or hardware Cmd/Ctrl+Enter sends.
      return;
    }

    if (plugin.settings.sendWithCmdEnter === true) {
      // User explicitly opted into Cmd/Ctrl+Enter to send
      return;
    }

    // Default desktop: Enter sends, Shift+Enter creates a newline
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void chat.send();
    }
  });

  const bottomRow = composerEl.createDiv({ cls: "dj-composer-bottom-row" });

  const applyAction = (action: QuickAction) => {
    inputEl.value = action.prompt;
    chat.setModeOverride(action.permissionMode ?? null);
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
    syncInputState();
  };

  // Compact quick menu trigger for mobile & narrow viewports (zero permanent vertical clutter)
  const quickMenuBtn = bottomRow.createEl("button", {
    cls: "dj-quick-menu-btn",
    attr: {
      type: "button",
      "aria-label": "Quick prompt actions",
      title: "Quick prompt actions",
    },
  });
  const quickIcon = quickMenuBtn.createSpan({ cls: "dj-action-btn-icon" });
  setIcon(quickIcon, "sparkles");
  quickMenuBtn.createSpan({ cls: "dj-quick-menu-label", text: "Prompts" });

  quickMenuBtn.addEventListener("click", (evt: MouseEvent) => {
    evt.preventDefault();
    const menu = new Menu();
    for (const action of QUICK_ACTIONS) {
      menu.addItem((item) => {
        item.setTitle(action.label);
        if (action.icon) item.setIcon(action.icon);
        item.onClick(() => applyAction(action));
      });
    }
    menu.showAtMouseEvent(evt);
  });

  // Inline chips container for wide desktop viewports
  const chips = bottomRow.createDiv({ cls: "dj-composer-quick-chips dj-chips" });
  for (const action of QUICK_ACTIONS) {
    const chip = chips.createEl("button", {
      cls: "dj-quick-chip dj-chip",
      text: action.label,
    });
    chip.addEventListener("click", () => applyAction(action));
  }

  const actions = bottomRow.createDiv({ cls: "dj-composer-actions" });
  const stopBtn = actions.createEl("button", {
    cls: "dj-stop-circle-btn",
    attr: { "aria-label": "Interrupt the running turn", title: "Interrupt the running turn" },
  });
  const stopIcon = stopBtn.createSpan({ cls: "dj-action-btn-icon" });
  setIcon(stopIcon, "square");
  stopBtn.disabled = true;
  stopBtn.addEventListener("click", () => {
    chat.interrupt();
  });

  const sendBtn = actions.createEl("button", {
    cls: "dj-send-circle-btn",
    attr: { "aria-label": "Send message", title: "Send message" },
  });
  const sendIcon = sendBtn.createSpan({ cls: "dj-action-btn-icon" });
  setIcon(sendIcon, "arrow-up");
  sendBtn.addEventListener("click", () => void chat.send());

  return {
    composerEl,
    notePillEl,
    attachEl,
    inputEl,
    sendBtn,
    stopBtn,
    quickMenuBtn,
  };
}

import { FileSystemAdapter, Menu, Notice, Platform, setIcon, type EventRef } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import {
  attachClipboardKeys,
  extractUrls,
  framePaste,
  readBufferLines,
  readClipboard,
  writeClipboard,
} from "./clipboard";
import { DarjeelingKeyBar } from "./keyBar";
import { TEA_TERMINAL_THEME, TEA_TERMINAL_THEME_LIGHT, ANSI, banner } from "../theme";
import type { TerminalProfile } from "../../settings/schema";
import { LocalTerminalProcess } from "../../platform/localProcess";
import { resolveShell, getUserHome } from "../../platform/node";
import type DarjeelingPlugin from "../../main";
import type { SessionInfo, SessionManager } from "../../net/sessionManager";
import { DarjeelingQuickSettingsModal } from "../../settings/quickSettings";
import { promptText } from "../modals/textPrompt";
import { ConfirmModal } from "../modals/confirm";
import { withPlatformShim } from "../../platform/polyfill";

export class TerminalPane {
  private terminal: Terminal | null = null;
  private fit: FitAddon | null = null;
  private termSocket: WebSocket | null = null;
  private termReconnect: number | null = null;
  private termAttempt = 0;
  private termWanted = false;
  private terminalReady = false;
  private resizeObserver: ResizeObserver | null = null;
  private localProcess: LocalTerminalProcess | null = null;
  private activeProfile: TerminalProfile | null = null;
  private cssListenerRef: EventRef | null = null;

  private hostEl!: HTMLElement;
  private toolbarEl: HTMLElement | null = null;
  private profileSelect: HTMLSelectElement | null = null;
  private sessionBarEl: HTMLElement | null = null;
  private sessionSelect: HTMLSelectElement | null = null;
  private termStatusEl: HTMLElement | null = null;
  private termStatusDot: HTMLElement | null = null;
  private termStatusText: HTMLElement | null = null;
  public keyBar: DarjeelingKeyBar | null = null;

  constructor(
    private plugin: DarjeelingPlugin,
    private sessions: SessionManager,
    private containerEl: HTMLElement
  ) {}

  mount(): void {
    this.buildToolbar(this.containerEl);
    this.hostEl = this.containerEl.createDiv({ cls: "dj-terminal-host" });
    this.keyBar = new DarjeelingKeyBar(this.containerEl, {
      copyFromTerminal: () => this.copyFromTerminal(),
      pasteToTerminal: () => this.pasteToTerminal(),
      showLinks: () => this.showLinks(),
      sendRaw: (data) => this.sendRaw(data),
      focusTerminal: () => this.focus(),
      isAppCursorMode: () =>
        Boolean((this.terminal?.modes as { applicationCursorKeysMode?: boolean } | undefined)?.applicationCursorKeysMode),
      onToggleHide: () => this.toggleKeyBar(),
    });
    this.setupPinchZoom();

    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onOnline);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
    this.cssListenerRef = this.plugin.app.workspace.on("css-change", () => {
      this.refreshSettings();
    });
  }

  private onOnline = (): void => {
    if (this.termWanted && !this.termSocket && this.activeProfile?.type === "remote") {
      void this.connectTerminal();
    }
  };

  private onVisibilityChange = (): void => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "visible" &&
      this.termWanted &&
      !this.termSocket &&
      this.activeProfile?.type === "remote"
    ) {
      void this.connectTerminal();
    }
  };

  private buildToolbar(pane: HTMLElement): void {
    const bar = pane.createDiv({ cls: "dj-terminal-toolbar" });
    this.toolbarEl = bar;

    this.profileSelect = bar.createEl("select", { cls: "dj-select" });
    this.profileSelect.title = "Select active terminal profile";
    this.paintTerminalProfiles();

    this.profileSelect.addEventListener("change", () => {
      void (async () => {
        const selectedId = this.profileSelect?.value;
        if (!selectedId) return;
        this.plugin.settings.activeTerminalProfileId = selectedId;
        await this.plugin.saveSettings();
        this.updateSessionBarVisibility();
        void this.connectTerminal(selectedId);
      })();
    });

    // Session controls for remote tmux profiles (VTH-03, VTH-15)
    this.sessionBarEl = bar.createDiv({ cls: "dj-terminal-session-bar" });
    this.sessionSelect = this.sessionBarEl.createEl("select", { cls: "dj-select" });
    this.sessionSelect.title = "Select active tmux session on host";
    this.sessionSelect.addEventListener("change", () => {
      void (async () => {
        const selected = this.sessionSelect?.value;
        if (!selected) return;
        this.plugin.settings.sessionName = selected;
        await this.plugin.saveSettings();
        void this.connectTerminal();
      })();
    });

    const addSessionBtn = this.sessionBarEl.createEl("button", {
      cls: "dj-btn dj-btn-icon",
      attr: { "aria-label": "New shell session" },
    });
    setIcon(addSessionBtn, "plus");
    addSessionBtn.title = "New shell session on the host";
    addSessionBtn.addEventListener("click", () => void this.createSession());

    const killSessionBtn = this.sessionBarEl.createEl("button", {
      cls: "dj-btn dj-btn-icon dj-btn-danger",
      attr: { "aria-label": "Kill session" },
    });
    setIcon(killSessionBtn, "x");
    killSessionBtn.title = "Kill this tmux session";
    killSessionBtn.addEventListener("click", () => void this.killSession());

    const refreshSessionsBtn = this.sessionBarEl.createEl("button", {
      cls: "dj-btn dj-btn-icon",
      attr: { "aria-label": "Refresh sessions" },
    });
    setIcon(refreshSessionsBtn, "rotate-cw");
    refreshSessionsBtn.title = "Refresh tmux sessions list";
    refreshSessionsBtn.addEventListener("click", () => void this.refreshSessions());

    const restartBtn = bar.createEl("button", { cls: "dj-btn" });
    const restartIcon = restartBtn.createSpan({ cls: "dj-btn-icon-prefix" });
    setIcon(restartIcon, "refresh-cw");
    restartBtn.createSpan({ text: "Restart" });
    restartBtn.title = "Restart current terminal process / session";
    restartBtn.addEventListener("click", () => {
      this.termAttempt = 0;
      void this.connectTerminal(this.plugin.settings.activeTerminalProfileId);
    });

    const clearBtn = bar.createEl("button", { cls: "dj-btn" });
    const clearIcon = clearBtn.createSpan({ cls: "dj-btn-icon-prefix" });
    setIcon(clearIcon, "trash-2");
    clearBtn.createSpan({ text: "Clear" });
    clearBtn.title = "Clear terminal screen";
    clearBtn.addEventListener("click", () => {
      this.terminal?.clear();
    });

    const configBtn = bar.createEl("button", { cls: "dj-btn" });
    const configIcon = configBtn.createSpan({ cls: "dj-btn-icon-prefix" });
    setIcon(configIcon, "settings");
    configBtn.createSpan({ text: "Profiles" });
    configBtn.title = "Configure terminal profiles and settings";
    configBtn.addEventListener("click", () => {
      new DarjeelingQuickSettingsModal(this.plugin.app, this.plugin).open();
    });

    this.termStatusEl = bar.createDiv({ cls: "dj-terminal-status" });
    this.termStatusDot = this.termStatusEl.createSpan({ cls: "dj-terminal-dot" });
    this.termStatusText = this.termStatusEl.createSpan({ text: "Idle" });

    const overflowBtn = bar.createEl("button", {
      cls: "dj-btn dj-btn-icon",
      attr: { "aria-label": "More terminal options" },
    });
    setIcon(overflowBtn, "more-horizontal");
    overflowBtn.title = "More terminal options";
    overflowBtn.addEventListener("click", (event) => {
      const menu = new Menu();
      if (this.activeProfile?.type === "remote") {
        menu.addItem((item) => {
          item.setTitle("New shell session").setIcon("plus").onClick(() => void this.createSession());
        });
        menu.addItem((item) => {
          item.setTitle("Kill shell session").setIcon("x").onClick(() => void this.killSession());
        });
        menu.addItem((item) => {
          item.setTitle("Refresh sessions").setIcon("rotate-cw").onClick(() => void this.refreshSessions());
        });
        menu.addSeparator();
      }
      menu.addItem((item) => {
        item.setTitle("Restart terminal").setIcon("refresh-cw").onClick(() => {
          this.termAttempt = 0;
          void this.connectTerminal(this.plugin.settings.activeTerminalProfileId);
        });
      });
      menu.addItem((item) => {
        item.setTitle("Clear screen").setIcon("trash-2").onClick(() => this.terminal?.clear());
      });
      menu.addItem((item) => {
        item.setTitle("Toggle key bar").setIcon("keyboard").onClick(() => this.toggleKeyBar());
      });
      menu.addSeparator();
      menu.addItem((item) => {
        item.setTitle("Increase font size").setIcon("zoom-in").onClick(() => this.adjustFontSize(1));
      });
      menu.addItem((item) => {
        item.setTitle("Decrease font size").setIcon("zoom-out").onClick(() => this.adjustFontSize(-1));
      });
      menu.addItem((item) => {
        item.setTitle("Reset font size").setIcon("type").onClick(() => this.resetFontSize());
      });
      menu.addSeparator();
      menu.addItem((item) => {
        item.setTitle("Configure profiles").setIcon("settings").onClick(() => {
          new DarjeelingQuickSettingsModal(this.plugin.app, this.plugin).open();
        });
      });
      menu.showAtMouseEvent(event);
    });

    this.updateSessionBarVisibility();
  }

  public toggleKeyBar(hidden?: boolean): void {
    this.keyBar?.toggleHidden(hidden);
  }

  public adjustFontSize(delta: number): void {
    if (!this.terminal) return;
    const current = this.terminal.options.fontSize || this.plugin.settings.fontSize || 14;
    const next = Math.max(8, Math.min(28, current + delta));
    this.terminal.options.fontSize = next;
    this.fit?.fit();
  }

  public resetFontSize(): void {
    if (!this.terminal) return;
    this.terminal.options.fontSize = this.plugin.settings.fontSize || 14;
    this.fit?.fit();
  }

  private setupPinchZoom(): void {
    let initialPinchDist = 0;
    let initialFontSize = 14;

    this.hostEl.addEventListener(
      "touchstart",
      (e: TouchEvent) => {
        if (e.touches.length === 2) {
          initialPinchDist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
          initialFontSize = this.terminal?.options.fontSize || this.plugin.settings.fontSize || 14;
        }
      },
      { passive: true }
    );

    this.hostEl.addEventListener(
      "touchmove",
      (e: TouchEvent) => {
        if (e.touches.length === 2 && initialPinchDist > 0 && this.terminal) {
          const currentDist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
          const scale = currentDist / initialPinchDist;
          const newSize = Math.max(8, Math.min(28, Math.round(initialFontSize * scale)));
          if (this.terminal.options.fontSize !== newSize) {
            this.terminal.options.fontSize = newSize;
            this.fit?.fit();
          }
        }
      },
      { passive: true }
    );

    this.hostEl.addEventListener(
      "touchend",
      (e: TouchEvent) => {
        if (e.touches.length < 2) {
          initialPinchDist = 0;
        }
      },
      { passive: true }
    );
  }

  private updateSessionBarVisibility(): void {
    if (!this.sessionBarEl) return;
    const isRemote = this.activeProfile ? this.activeProfile.type === "remote" : true;
    this.sessionBarEl.toggleClass("is-hidden", !isRemote);
  }

  private paintTerminalProfiles(): void {
    if (!this.profileSelect) return;
    this.profileSelect.empty();
    const profiles = this.plugin.settings.terminalProfiles || [];
    for (const p of profiles) {
      const opt = this.profileSelect.createEl("option", {
        value: p.id,
        text: `${p.type === "local" ? "Local" : "Remote"}: ${p.name}`,
      });
      if (p.id === this.plugin.settings.activeTerminalProfileId) {
        opt.selected = true;
      }
    }
  }

  private onStatus(running: boolean, label: string): void {
    if (!this.termStatusEl || !this.termStatusText) return;
    this.termStatusEl.toggleClass("is-running", running);
    this.termStatusText.textContent = label;
  }

  activate(): void {
    this.ensureTerminal();
    this.fitTerminal();
    this.focus();
    if (this.termWanted && !this.termSocket && this.activeProfile?.type === "remote") {
      void this.connectTerminal();
    }
    void this.refreshSessions();
  }

  ensureTerminal(): void {
    if (this.terminalReady || !this.hostEl) return;

    try {
      const settings = this.plugin.settings;
      const light = typeof document !== "undefined" && document.body?.hasClass?.("theme-light");

      this.terminal = withPlatformShim(() => {
        return new Terminal({
          cursorBlink: settings.cursorBlink,
          fontSize: settings.fontSize,
          fontFamily: settings.fontFamily,
          theme: light ? TEA_TERMINAL_THEME_LIGHT : TEA_TERMINAL_THEME,
          convertEol: false,
          scrollback: 10000,
          macOptionIsMeta: settings.macOptionIsMeta ?? false,
        });
      });

      this.fit = new FitAddon();
      this.terminal.loadAddon(this.fit);

      this.terminal.loadAddon(
        new WebLinksAddon((event: MouseEvent, uri: string) => {
          event.preventDefault();
          // egress: browser-open
          window.open(uri, "_blank");
        })
      );

      this.terminal.open(this.hostEl);
      this.terminal.onData((data) => {
        const transformed = this.keyBar ? this.keyBar.transformInput(data) : data;
        this.sendRaw(transformed);
      });

      attachClipboardKeys(this.terminal, (data) => this.sendRaw(data));
      this.hostEl.addEventListener("contextmenu", (event: MouseEvent) =>
        this.showTerminalMenu(event)
      );

      if (typeof ResizeObserver !== "undefined") {
        this.resizeObserver = new ResizeObserver(() => {
          this.fitTerminal();
        });
        this.resizeObserver.observe(this.hostEl);
      }

      this.terminalReady = true;
      void this.connectTerminal();
    } catch (err) {
      console.warn("[Darjeeling] Could not initialize interactive terminal:", err);
      if (this.hostEl) {
        this.hostEl.empty();
        const placeholder = this.hostEl.createDiv({ cls: "dj-empty-state" });
        placeholder.createDiv({ cls: "dj-empty-title", text: "Terminal unavailable" });
        placeholder.createDiv({
          cls: "dj-empty-sub",
          text: "Interactive terminal cannot initialize on this device.",
        });
      }
    }
  }

  fitTerminal(): void {
    if (!this.fit || !this.terminal || !this.hostEl) return;
    if (this.hostEl.clientWidth < 40 || this.hostEl.clientHeight < 40) {
      return;
    }
    try {
      this.fit.fit();
      const cols = this.terminal.cols;
      const rows = this.terminal.rows;

      if (this.localProcess?.isRunning) {
        this.localProcess.resize(cols, rows);
      } else if (this.termSocket?.readyState === WebSocket.OPEN) {
        this.termSocket.send(
          JSON.stringify({
            type: "resize",
            cols,
            rows,
          })
        );
      }
    } catch {
      /* ignore */
    }
  }

  async connectTerminal(profileId?: string): Promise<void> {
    if (!this.terminal) return;
    this.termWanted = true;

    if (this.localProcess) {
      const old = this.localProcess;
      this.localProcess = null;
      try {
        old.kill();
      } catch {
        /* already dead */
      }
    }

    if (this.termSocket) {
      const old = this.termSocket;
      this.termSocket = null;
      old.onopen = null;
      old.onmessage = null;
      old.onerror = null;
      old.onclose = null;
      try {
        old.close();
      } catch {
        /* already closing */
      }
    }

    const settings = this.plugin.settings;
    const id = profileId || settings.activeTerminalProfileId;
    let profile =
      settings.terminalProfiles.find((p) => p.id === id) ||
      settings.terminalProfiles[0];

    if (!Platform.isDesktop && profile.type === "local") {
      const remoteProfile = settings.terminalProfiles.find(
        (p) => p.type === "remote"
      );
      if (remoteProfile) {
        profile = remoteProfile;
      }
    }
    this.activeProfile = profile;
    this.updateSessionBarVisibility();

    if (profile.type === "local") {
      if (!Platform.isDesktop) {
        this.terminal.writeln(
          `\r\n${banner("local terminal processes require obsidian desktop", ANSI.chili)}`
        );
        this.terminal.writeln(
          `\r\n\x1b[38;2;160;185;155mOn mobile, configure a Remote Profile (tmux via WebSocket) in Settings to use the terminal.\x1b[0m`
        );
        this.onStatus(false, "Desktop only");
        return;
      }

      this.terminal.writeln(`\r\n${banner(`starting ${profile.name}…`)}`);
      this.onStatus(false, "Starting…");

      const executable = profile.executable?.trim() || resolveShell();
      const adapter = this.plugin.app.vault.adapter;
      const vaultPath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
      let cwd = profile.cwd?.trim();
      if (!cwd) {
        cwd = vaultPath || getUserHome();
      }

      try {
        const proc = new LocalTerminalProcess({
          executable,
          args: profile.args,
          cwd,
          env: profile.env,
          cols: this.terminal.cols || 80,
          rows: this.terminal.rows || 24,
        });
        this.localProcess = proc;

        proc.onData((data) => {
          if (this.localProcess !== proc) return;
          this.terminal?.write(data);
        });

        proc.onExit((code) => {
          if (this.localProcess !== proc) return;
          this.localProcess = null;
          this.onStatus(false, `Exited (${code})`);
          this.terminal?.writeln(
            `\r\n${banner(`process exited with code ${code}`, code === 0 ? ANSI.flush : ANSI.gold)}`
          );
        });

        await proc.start();
        if (this.localProcess === proc) {
          this.onStatus(true, "Running");
          this.fitTerminal();
        }
      } catch (err) {
        if (this.localProcess === null) return;
        this.onStatus(false, "Failed");
        this.terminal.writeln(`\r\n${banner(`failed to start: ${String(err)}`, ANSI.chili)}`);
      }
      return;
    }

    // Remote profile (WebSocket)
    const { meshnetHost, port, authToken } = settings;
    // One source of truth for remote session (VTH-03):
    const sessionName =
      settings.sessionName?.trim() || profile.sessionName?.trim() || "darjeeling";
    settings.sessionName = sessionName;

    if (!meshnetHost) {
      this.onStatus(false, "No host");
      this.terminal.writeln(`\r\n${banner("no host configured", ANSI.chili)}`);
      return;
    }

    const url = `ws://${meshnetHost}:${port}/ws/terminal?session=${encodeURIComponent(
      sessionName
    )}`;
    this.terminal.writeln(`\r\n${banner(`attaching to ${sessionName}…`)}`);
    this.onStatus(false, "Connecting…");

    let ws: WebSocket;
    try {
      ws = authToken
        ? new WebSocket(url, [`darjeeling.token.${authToken}`]) // egress: host-terminal
        : new WebSocket(url); // egress: host-terminal
    } catch (err) {
      this.onStatus(false, "Error");
      this.terminal.writeln(banner(String(err), ANSI.chili));
      return;
    }
    this.termSocket = ws;

    ws.onopen = () => {
      if (this.termSocket !== ws) return;
      this.termAttempt = 0;
      this.onStatus(true, "Attached");
      this.terminal?.writeln(banner(`attached to ${sessionName}`, ANSI.flush));
      this.fitTerminal();
      void this.refreshSessions();
    };

    ws.onmessage = (event: MessageEvent) => {
      if (this.termSocket !== ws) return;
      if (typeof event.data === "string") this.terminal?.write(event.data);
    };

    ws.onerror = () => {
      if (this.termSocket !== ws) return;
    };

    ws.onclose = (event: CloseEvent) => {
      if (this.termSocket !== ws) return;
      this.termSocket = null;
      this.onStatus(false, "Detached");

      if (event.code === 4401 || event.code === 1008) {
        this.terminal?.writeln(
          `\r\n${banner("Token rejected — bad or missing auth token", ANSI.chili)}`
        );
        return; // No retry on auth failure (VTH-07)
      }

      if (event.code === 4000) {
        this.terminal?.writeln(
          `\r\n${banner("Shell ended", ANSI.gold)}`
        );
        return; // Shell cleanly ended, no auto-retry (VTH-10)
      }

      this.terminal?.writeln(
        `\r\n${banner(`detached (${event.code}); tmux keeps running`, ANSI.gold)}`
      );
      if (this.termWanted && this.activeProfile?.type === "remote") {
        this.scheduleTerminalReconnect();
      }
    };
  }

  private scheduleTerminalReconnect(): void {
    if (this.termReconnect !== null) return;
    const delay = Math.min(1000 * 2 ** this.termAttempt, 30000) + Math.random() * 400;
    this.termAttempt = Math.min(this.termAttempt + 1, 6);
    this.termReconnect = window.setTimeout(() => {
      this.termReconnect = null;
      if (this.termWanted) void this.connectTerminal();
    }, delay);
  }

  private async createSession(): Promise<void> {
    const defaultName = `shell-${Date.now().toString(36).slice(-4)}`;
    const name = await promptText(this.plugin.app, {
      title: "New shell session",
      message: "Enter a name for the new tmux session on the host:",
      placeholder: defaultName,
      defaultValue: defaultName,
      confirmLabel: "Create session",
    });
    if (!name || !name.trim()) return;

    const result = await this.sessions.createSession(name.trim(), "bash");
    if (!result.ok) {
      new Notice(`Could not create session: ${result.error ?? "unknown error"}`);
      return;
    }

    const assignedName = result.name || name.trim();
    this.plugin.settings.sessionName = assignedName;
    await this.plugin.saveSettings();
    await this.refreshSessions();
    void this.connectTerminal();
  }

  private async killSession(): Promise<void> {
    const name = this.plugin.settings.sessionName || "darjeeling";
    const modal = new ConfirmModal(this.plugin.app, {
      title: "Kill session",
      message: `Kill session '${name}'? Anything running in it will terminate.`,
      confirmLabel: "Kill session",
      cancelLabel: "Cancel",
      destructive: true,
    });
    const confirmed = await modal.promptConfirm();
    if (!confirmed) return;

    const ok = await this.sessions.deleteSession(name);
    if (!ok) {
      new Notice(`Failed to kill session '${name}'`);
      return;
    }

    new Notice(`Killed '${name}'`);
    await this.refreshSessions();

    const list = await this.sessions.listSessions().catch(() => []);
    if (list.length > 0 && list[0]?.name) {
      this.plugin.settings.sessionName = list[0].name;
      await this.plugin.saveSettings();
      void this.connectTerminal();
    } else {
      if (this.termSocket) {
        const old = this.termSocket;
        this.termSocket = null;
        old.onopen = null;
        old.onmessage = null;
        old.onerror = null;
        old.onclose = null;
        try {
          old.close();
        } catch {
          /* ignore */
        }
      }
      this.onStatus(false, "No sessions");
      this.terminal?.clear();
      this.terminal?.writeln(
        `\r\n${banner(`session '${name}' killed — no remaining sessions`, ANSI.gold)}`
      );
    }
  }

  sendRaw(data: string): void {
    if (this.localProcess?.isRunning) {
      this.localProcess.write(data);
    } else if (this.termSocket?.readyState === WebSocket.OPEN) {
      this.termSocket.send(data);
    }
  }

  sendText(text: string): void {
    this.sendRaw(text.endsWith("\r") ? text : `${text}\r`);
  }

  focus(): void {
    this.terminal?.focus();
  }

  clear(): void {
    this.terminal?.clear();
  }

  selectAll(): void {
    this.terminal?.selectAll();
  }

  async copyFromTerminal(): Promise<void> {
    if (!this.terminal) return;
    const selection = this.terminal.getSelection();
    const text = selection || readBufferLines(this.terminal, 400).join("\n").trimEnd();
    if (!text) {
      new Notice("Nothing to copy.");
      return;
    }
    const ok = await writeClipboard(text);
    new Notice(
      ok
        ? `Copied ${text.length} characters${selection ? "" : " (visible screen)"}`
        : "Could not reach the clipboard."
    );
    if (selection) this.terminal.clearSelection();
  }

  async pasteToTerminal(): Promise<void> {
    if (!this.terminal) return;
    const text = await readClipboard();
    if (!text) {
      new Notice("Clipboard is empty, or Obsidian was denied access to it.");
      return;
    }
    this.sendRaw(framePaste(this.terminal, text));
    this.terminal.focus();
  }

  showLinks(): void {
    if (!this.terminal) return;
    const urls = extractUrls(this.terminal);
    if (!urls.length) {
      new Notice("No links found on screen.");
      return;
    }

    const menu = new Menu();
    for (const url of urls) {
      const label = url.length > 62 ? `${url.slice(0, 59)}…` : url;
      menu.addItem((item) =>
        item
          .setTitle(`Open  ${label}`)
          .setIcon("external-link")
          // egress: browser-open
          .onClick(() => window.open(url, "_blank"))
      );
      menu.addItem((item) =>
        item
          .setTitle(`Copy  ${label}`)
          .setIcon("copy")
          .onClick(() =>
            void writeClipboard(url).then((ok) =>
              new Notice(ok ? `Copied ${url.length}-character URL` : "Copy failed")
            )
          )
      );
      menu.addSeparator();
    }
    const rect = this.hostEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left + 16, y: rect.bottom - 48 });
  }

  showTerminalMenu(event: MouseEvent): void {
    const menu = new Menu();

    menu.addItem((item) =>
      item
        .setTitle(this.terminal?.hasSelection() ? "Copy selection" : "Copy visible screen")
        .setIcon("copy")
        .onClick(() => void this.copyFromTerminal())
    );

    menu.addItem((item) =>
      item
        .setTitle("Paste")
        .setIcon("clipboard")
        .onClick(() => void this.pasteToTerminal())
    );

    menu.addItem((item) =>
      item
        .setTitle("Select all")
        .setIcon("check-square")
        .onClick(() => this.selectAll())
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle("Links on screen…")
        .setIcon("link")
        .onClick(() => this.showLinks())
    );

    menu.addItem((item) =>
      item
        .setTitle("Clear")
        .setIcon("eraser")
        .onClick(() => this.terminal?.clear())
    );

    menu.showAtMouseEvent(event);
  }

  async refreshSessions(): Promise<void> {
    if (!this.sessions || !this.sessionSelect) return;
    try {
      const list: SessionInfo[] = await this.sessions.listSessions();
      if (!this.sessionSelect) return;
      this.sessionSelect.empty();
      if (!list.length) {
        this.sessionSelect.createEl("option", {
          text: this.plugin.settings.sessionName || "darjeeling",
          value: this.plugin.settings.sessionName || "darjeeling",
        });
        return;
      }
      for (const session of list) {
        this.sessionSelect.createEl("option", {
          text: `${session.name}${session.command ? ` · ${session.command}` : ""}`,
          value: session.name,
        });
      }
      if (!list.some((s) => s.name === this.plugin.settings.sessionName)) {
        this.plugin.settings.sessionName = list[0].name;
        void this.plugin.saveSettings();
      }
      this.sessionSelect.value = this.plugin.settings.sessionName;
    } catch {
      /* ignore remote list errors */
    }
  }

  refreshSettings(): void {
    if (!this.terminal) return;
    const settings = this.plugin.settings;
    const light = typeof document !== "undefined" && document.body?.hasClass?.("theme-light");
    this.terminal.options.fontSize = settings.fontSize;
    this.terminal.options.fontFamily = settings.fontFamily;
    this.terminal.options.cursorBlink = settings.cursorBlink;
    this.terminal.options.macOptionIsMeta = settings.macOptionIsMeta ?? false;
    this.terminal.options.theme = light ? TEA_TERMINAL_THEME_LIGHT : TEA_TERMINAL_THEME;
    this.paintTerminalProfiles();
    this.updateSessionBarVisibility();
    this.fitTerminal();
  }

  destroy(): void {
    this.termWanted = false;
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onOnline);
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    if (this.cssListenerRef) {
      this.plugin.app.workspace.offref(this.cssListenerRef);
      this.cssListenerRef = null;
    }
    if (this.termReconnect !== null) {
      window.clearTimeout(this.termReconnect);
      this.termReconnect = null;
    }
    if (this.localProcess) {
      try {
        this.localProcess.kill();
      } catch {
        /* ignore */
      }
      this.localProcess = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.termSocket) {
      const old = this.termSocket;
      this.termSocket = null;
      old.onopen = null;
      old.onmessage = null;
      old.onerror = null;
      old.onclose = null;
      try {
        old.close();
      } catch {
        /* ignore */
      }
    }
    this.terminal?.dispose();
    this.terminal = null;
    this.terminalReady = false;
  }
}

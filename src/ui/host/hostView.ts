import { Notice, setIcon } from "obsidian";
import type DarjeelingPlugin from "../../main";
import type { SessionManager } from "../../net/sessionManager";
import type { BatteryStatus, HostStatus } from "./hostTypes";

/**
 * Host dashboard.
 *
 * Built to answer one question first — is it safe to keep working this machine
 * this hard — and only then to show the numbers behind the answer. So there is
 * a verdict strip at the top, a hero figure, then tiles.
 *
 * Forms follow the data's job: a single current value with a trend is a stat
 * tile, a ratio against a limit is a meter, per-process detail is a table.
 */

const POLL_MS = 5000;
const MAX_BACKOFF_MS = 60000;
const HISTORY = 40;

type Level = "ok" | "warn" | "critical";

const LEVEL_ICON: Record<Level, string> = {
  ok: "check-circle",
  warn: "alert-triangle",
  critical: "alert-octagon",
};
const LEVEL_WORD: Record<Level, string> = {
  ok: "Healthy",
  warn: "Under load",
  critical: "Throttle risk",
};

type Series = {
  cpuTemp: number[];
  load: number[];
  watts: number[];
  cpuPct: number[];
};

export class DarjeelingHostPanel {
  private readonly plugin: DarjeelingPlugin;
  private readonly sessions: SessionManager;
  public readonly hostEl: HTMLElement;

  private bodyEl: HTMLElement | null = null;
  private timer: number | null = null;
  private visible = false;
  private inFlight = false;
  private pollInterval = POLL_MS;
  private last: HostStatus | null = null;

  // Cached DOM elements for in-place patching (DM-33)
  private verdictEl: HTMLElement | null = null;
  private heroEl: HTMLElement | null = null;
  private kpisEl: HTMLElement | null = null;
  private metersEl: HTMLElement | null = null;
  private batteryCardEl: HTMLElement | null = null;
  private agentsCardEl: HTMLElement | null = null;
  private footerEl: HTMLElement | null = null;

  private series: Series = { cpuTemp: [], load: [], watts: [], cpuPct: [] };

  constructor(plugin: DarjeelingPlugin, sessions: SessionManager, hostEl: HTMLElement) {
    this.plugin = plugin;
    this.sessions = sessions;
    this.hostEl = hostEl;
  }

  mount(): void {
    this.hostEl.empty();
    this.bodyEl = this.hostEl.createDiv({ cls: "dj-host" });
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
    this.renderLoading();
  }

  private onVisibilityChange = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "visible" && this.visible) {
      void this.refresh();
      this.reschedule();
    } else {
      this.clearTimer();
    }
  };

  private renderLoading(): void {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    this.clearCachedElements();
    this.bodyEl.createDiv({
      cls: "dj-host-loading",
      text: "Reading host telemetry…",
    });
  }

  private clearCachedElements(): void {
    this.verdictEl = null;
    this.heroEl = null;
    this.kpisEl = null;
    this.metersEl = null;
    this.batteryCardEl = null;
    this.agentsCardEl = null;
    this.footerEl = null;
  }

  /**
   * Polling runs only while the tab is visible and document is in foreground.
   * Skipped when not connected to a remote host (VTH-31, DOC-41).
   */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      this.pollInterval = POLL_MS;
      void this.refresh();
      this.reschedule();
    } else {
      this.clearTimer();
    }
  }

  private reschedule(): void {
    this.clearTimer();
    if (!this.visible) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;

    this.timer = window.setTimeout(() => {
      void this.refresh();
    }, this.pollInterval);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  destroy(): void {
    this.clearTimer();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
  }

  private push(status: HostStatus): void {
    const add = (arr: number[], value: number | null | undefined) => {
      if (typeof value === "number" && Number.isFinite(value)) arr.push(value);
      if (arr.length > HISTORY) arr.shift();
    };
    add(this.series.cpuTemp, status.thermal.cpuCelsius);
    add(this.series.load, status.cpu.loadPerCore);
    add(this.series.watts, status.battery?.watts);
    add(this.series.cpuPct, status.cpu.usagePct);
  }

  private async refresh(): Promise<void> {
    if (this.inFlight) return;
    if (!this.visible) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;

    const mode = this.plugin.settings.runtimeMode;
    if (mode !== "remote" || !this.plugin.settings.meshnetHost) {
      this.renderUnreachable();
      return;
    }

    this.inFlight = true;
    try {
      const status = await this.sessions.hostStatus();
      if (!status) {
        this.pollInterval = Math.min(MAX_BACKOFF_MS, this.pollInterval * 2);
        this.renderUnreachable();
        this.reschedule();
        return;
      }
      this.pollInterval = POLL_MS;
      this.last = status;
      this.push(status);
      this.render(status);
      this.reschedule();
    } catch {
      this.pollInterval = Math.min(MAX_BACKOFF_MS, this.pollInterval * 2);
      this.reschedule();
    } finally {
      this.inFlight = false;
    }
  }

  private renderUnreachable(): void {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    this.clearCachedElements();

    const mode = this.plugin.settings.runtimeMode;
    const box = this.bodyEl.createDiv({ cls: "dj-host-verdict is-critical" });
    const glyphSpan = box.createSpan({ cls: "dj-host-verdict-glyph" });
    setIcon(glyphSpan, mode === "remote" ? "wifi-off" : "server");
    const text = box.createDiv();

    if (mode !== "remote") {
      text.createDiv({ cls: "dj-host-verdict-word", text: "Host telemetry inactive" });
      text.createDiv({
        cls: "dj-host-verdict-detail",
        text: `Currently running in ${mode.toUpperCase()} mode. Telemetry is available when connected to a remote Darjeeling daemon.`,
      });
    } else {
      text.createDiv({ cls: "dj-host-verdict-word", text: "Host unreachable" });
      text.createDiv({
        cls: "dj-host-verdict-detail",
        text: `Could not reach ${this.plugin.settings.meshnetHost || "host"}:${this.plugin.settings.port}. Check your network, Meshnet/VPN, and daemon status.`,
      });
    }

    const retryBtn = this.bodyEl.createEl("button", {
      cls: "dj-btn dj-btn-subtle dj-host-retry-btn",
      text: "Retry connection",
    });
    retryBtn.addEventListener("click", () => {
      this.renderLoading();
      void this.refresh();
    });
  }

  // ------------------------------------------------------------------ render

  /**
   * Patches values in place rather than emptying the whole DOM tree (DM-33).
   * Focus on threshold buttons is preserved; screen readers aren't blasted every 5s.
   */
  public render(status: HostStatus): void {
    if (!this.bodyEl) return;

    if (!this.verdictEl || !this.heroEl || !this.kpisEl || !this.metersEl) {
      this.bodyEl.empty();
      this.clearCachedElements();

      // aria-live on the verdict strip only (DM-33)
      this.verdictEl = this.bodyEl.createDiv({ cls: "dj-host-verdict" });
      this.verdictEl.setAttribute("aria-live", "polite");
      this.verdictEl.setAttribute("aria-atomic", "true");

      this.heroEl = this.bodyEl.createDiv({ cls: "dj-host-hero" });
      this.kpisEl = this.bodyEl.createDiv({ cls: "dj-host-kpis" });
      this.metersEl = this.bodyEl.createDiv({ cls: "dj-host-meters" });
      this.batteryCardEl = this.bodyEl.createDiv({ cls: "dj-host-card dj-host-battery-card" });
      this.agentsCardEl = this.bodyEl.createDiv({ cls: "dj-host-card dj-host-agents-card" });
      this.footerEl = this.bodyEl.createDiv({ cls: "dj-host-footer" });
    }

    this.patchVerdict(status);
    this.patchHero(status);
    this.patchTiles(status);
    this.patchMeters(status);
    this.patchBattery(status);
    this.patchAgents(status);
    this.patchFooter(status);
  }

  /** Verdict strip: glyph, word and sentence. Neutral copy (DM-33, VTH-24). */
  private patchVerdict(status: HostStatus): void {
    if (!this.verdictEl) return;
    const level = status.level;
    this.verdictEl.className = `dj-host-verdict is-${level}`;
    this.verdictEl.empty();

    const glyphSpan = this.verdictEl.createSpan({ cls: "dj-host-verdict-glyph" });
    setIcon(glyphSpan, LEVEL_ICON[level] ?? "alert-circle");

    const text = this.verdictEl.createDiv({ cls: "dj-host-verdict-text" });
    text.createDiv({ cls: "dj-host-verdict-word", text: LEVEL_WORD[level] });

    if (!status.alerts.length) {
      let powerCopy = "Server running";
      if (status.battery?.present) {
        powerCopy = status.battery.acOnline ? "On AC power" : "On battery power";
      }
      const tempCopy = status.thermal.cpuCelsius != null ? `${status.thermal.cpuCelsius}°C` : "normal temp";
      text.createDiv({
        cls: "dj-host-verdict-detail",
        text: `${powerCopy}, ${tempCopy}, ${status.agents.activeTurns}/${status.agents.maxConcurrentTurns} turns running. Normal.`,
      });
      return;
    }

    for (const alert of status.alerts) {
      const row = text.createDiv({ cls: `dj-host-alert is-${alert.level}` });
      const alertGlyph = row.createSpan({ cls: "dj-host-alert-glyph" });
      setIcon(alertGlyph, LEVEL_ICON[alert.level] ?? "alert-circle");
      const copy = row.createDiv();
      copy.createDiv({ cls: "dj-host-alert-title", text: alert.title });
      copy.createDiv({ cls: "dj-host-alert-detail", text: alert.detail });
    }
  }

  /**
   * Hero figure by availability: CPU temp > CPU busy % > Load per core (VTH-24).
   */
  private patchHero(status: HostStatus): void {
    if (!this.heroEl) return;
    this.heroEl.empty();

    let label = "CPU temperature";
    let valStr = "—";
    let unit = "°C";
    let level: Level = "ok";
    let seriesData: number[] = this.series.cpuTemp;

    if (status.thermal.cpuCelsius != null) {
      const temp = status.thermal.cpuCelsius;
      valStr = temp.toFixed(0);
      unit = "°C";
      level = temp >= 85 ? "critical" : temp >= 75 ? "warn" : "ok";
      seriesData = this.series.cpuTemp;
    } else if (status.cpu.usagePct != null) {
      label = "CPU busy";
      valStr = status.cpu.usagePct.toFixed(0);
      unit = "%";
      level = status.cpu.usagePct >= 90 ? "critical" : status.cpu.usagePct >= 65 ? "warn" : "ok";
      seriesData = this.series.cpuPct;
    } else if (status.cpu.loadPerCore != null) {
      label = "Load per core";
      valStr = status.cpu.loadPerCore.toFixed(2);
      unit = "";
      level = status.cpu.loadPerCore >= 1.5 ? "critical" : status.cpu.loadPerCore >= 0.8 ? "warn" : "ok";
      seriesData = this.series.load;
    }

    this.heroEl.className = `dj-host-hero is-${level}`;
    const left = this.heroEl.createDiv({ cls: "dj-host-hero-figure" });
    left.createDiv({ cls: "dj-host-hero-label", text: label });
    const value = left.createDiv({ cls: "dj-host-hero-value" });
    value.createSpan({ text: valStr });
    if (unit) value.createSpan({ cls: "dj-host-hero-unit", text: unit });

    const delta = this.trend(seriesData);
    if (delta !== null) {
      left.createDiv({
        cls: `dj-host-hero-delta ${delta > 0 ? "is-up" : delta < 0 ? "is-down" : ""}`,
        text:
          delta === 0
            ? "steady"
            : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}${unit} over ${
                Math.round((seriesData.length * POLL_MS) / 1000)
              }s`,
      });
    }

    this.heroEl.appendChild(this.sparkline(seriesData, 200, 56));
  }

  /**
   * KPI tiles: render ONLY for sensors that exist (VTH-24, F-35).
   * Omit Fan and Draw if sensor readings are null (e.g. VPS or desktop without fan reporting).
   */
  private patchTiles(status: HostStatus): void {
    if (!this.kpisEl) return;
    this.kpisEl.empty();

    if (status.cpu.loadPerCore != null) {
      const load = status.cpu.loadPerCore;
      this.tile(this.kpisEl, {
        label: "Load per core",
        value: load.toFixed(2),
        sub: `${status.cpu.load1 ?? "—"} across ${status.cpu.cores ?? "?"} cores`,
        level: load >= 1.5 ? "critical" : load >= 0.8 ? "warn" : "ok",
        series: this.series.load,
      });
    }

    if (status.cpu.usagePct != null) {
      this.tile(this.kpisEl, {
        label: "CPU busy",
        value: `${status.cpu.usagePct.toFixed(0)}%`,
        sub: status.cpu.freqMhz ? `${status.cpu.freqMhz} MHz` : "",
        level: status.cpu.usagePct >= 90 ? "critical" : status.cpu.usagePct >= 65 ? "warn" : "ok",
        series: this.series.cpuPct,
      });
    }

    if (status.thermal.fanRpm != null) {
      this.tile(this.kpisEl, {
        label: "Fan",
        value: String(status.thermal.fanRpm),
        sub: status.thermal.fanRpm === 0 ? "idle, not spinning" : "rpm",
        level: status.thermal.fanRpm > 4500 ? "warn" : "ok",
      });
    }

    if (status.battery?.watts != null) {
      this.tile(this.kpisEl, {
        label: "Draw",
        value: `${status.battery.watts.toFixed(1)} W`,
        sub: status.battery.psuOutrun ? "from the battery" : "power draw",
        level: status.battery.psuOutrun ? "critical" : "ok",
        series: this.series.watts,
      });
    }
  }

  private patchMeters(status: HostStatus): void {
    if (!this.metersEl) return;
    this.metersEl.empty();

    this.meter(this.metersEl, {
      label: "Concurrent turns",
      current: status.agents.activeTurns,
      limit: status.agents.maxConcurrentTurns,
      text: `${status.agents.activeTurns} of ${status.agents.maxConcurrentTurns}`,
      level: status.agents.atCapacity ? "warn" : "ok",
      note: status.agents.atCapacity
        ? "At the cap — further turns are refused"
        : "Turns beyond the cap are refused, not queued",
    });

    this.meter(this.metersEl, {
      label: "Memory",
      current: status.memory.usedMb ?? 0,
      limit: status.memory.totalMb ?? 1,
      text: `${(((status.memory.usedMb ?? 0) / 1024)).toFixed(1)} of ${(
        (status.memory.totalMb ?? 0) / 1024
      ).toFixed(1)} GB`,
      level:
        (status.memory.usedPct ?? 0) >= 90 ? "critical" : (status.memory.usedPct ?? 0) >= 75 ? "warn" : "ok",
      note: (status.memory.swapUsedMb ?? 0) > 0 ? `${status.memory.swapUsedMb} MB swapped` : "",
    });

    this.meter(this.metersEl, {
      label: "Vault disk",
      current: (status.disk.totalGb ?? 0) - (status.disk.freeGb ?? 0),
      limit: status.disk.totalGb ?? 1,
      text: `${status.disk.freeGb ?? "—"} GB free`,
      level: (status.disk.usedPct ?? 0) >= 90 ? "critical" : (status.disk.usedPct ?? 0) >= 75 ? "warn" : "ok",
    });
  }

  /**
   * Battery card and charge controls only when sysfs supports them (VTH-24, VTH-25).
   */
  private patchBattery(status: HostStatus): void {
    if (!this.batteryCardEl) return;
    const battery = status.battery;
    if (!battery || !battery.present) {
      this.batteryCardEl.toggleClass("is-hidden", true);
      this.batteryCardEl.empty();
      return;
    }

    this.batteryCardEl.toggleClass("is-hidden", false);
    this.batteryCardEl.empty();

    const head = this.batteryCardEl.createDiv({ cls: "dj-host-card-head" });
    head.createSpan({ cls: "dj-host-card-title", text: "Battery" });
    head.createSpan({
      cls: "dj-host-card-meta",
      text: [
        battery.acOnline ? "on AC power" : "on battery",
        battery.status?.toLowerCase(),
        battery.model ? `${battery.model}` : null,
        battery.cycleCount != null ? `${battery.cycleCount} cycles` : null,
      ]
        .filter(Boolean)
        .join("  ·  "),
    });

    const health = battery.healthPct;
    this.meter(this.batteryCardEl, {
      label: "Health (capacity against design)",
      current: health ?? 0,
      limit: 100,
      text:
        health == null
          ? "—"
          : `${health.toFixed(1)}%  ·  ${battery.energyFullWh} of ${battery.energyDesignWh} Wh`,
      level: health == null ? "ok" : health < 70 ? "critical" : health < 85 ? "warn" : "ok",
      note:
        health != null && health < 100
          ? `${(100 - health).toFixed(1)}% of design capacity lost`
          : "",
    });

    this.meter(this.batteryCardEl, {
      label: "Charge",
      current: battery.capacityPct ?? 0,
      limit: 100,
      text: `${battery.capacityPct ?? "—"}%`,
      level: "ok",
      note:
        battery.chargeEndThreshold != null
          ? `charging stops at ${battery.chargeEndThreshold}%, resumes below ${
              battery.chargeStartThreshold ?? "?"
            }%`
          : "",
    });

    // Render charge ceiling controls ONLY when hardware/sysfs threshold is supported (VTH-25)
    if (battery.chargeEndThreshold != null || battery.thresholdWritable) {
      this.renderThresholdControls(this.batteryCardEl, battery);
    }
  }

  private renderThresholdControls(parent: HTMLElement, battery: BatteryStatus): void {
    const controls = parent.createDiv({ cls: "dj-host-threshold" });
    controls.createDiv({
      cls: "dj-host-threshold-label",
      text: "Charge ceiling",
    });
    controls.createDiv({
      cls: "dj-host-threshold-help",
      text: "Stop charging early to preserve battery health under continuous AC power.",
    });

    const buttons = controls.createDiv({ cls: "dj-host-threshold-row" });
    for (const target of [60, 70, 80, 90, 100]) {
      const active = battery.chargeEndThreshold === target;
      const btn = buttons.createEl("button", {
        cls: `dj-btn${active ? " dj-btn-accent" : ""}`,
        text: `${target}%`,
      });
      btn.title =
        target === 100
          ? "No limit (100% full charge)"
          : `Stop charging at ${target}%`;
      btn.addEventListener("click", () => {
        void (async () => {
          buttons
            .querySelectorAll<HTMLButtonElement>("button")
            .forEach((b) => (b.disabled = true));
          const ok = await this.sessions.setChargeThreshold(target, Math.max(40, target - 5));
          new Notice(
            ok
              ? `Charge ceiling set to ${target}%`
              : "Could not set charge ceiling: check host hardware support or udev rules."
          );
          await this.refresh();
        })();
      });
    }
  }

  private patchAgents(status: HostStatus): void {
    if (!this.agentsCardEl) return;
    this.agentsCardEl.empty();

    const head = this.agentsCardEl.createDiv({ cls: "dj-host-card-head" });
    head.createSpan({ cls: "dj-host-card-title", text: "Agent load" });
    head.createSpan({
      cls: "dj-host-card-meta",
      text: `${status.agents.interactiveAgents} interactive session(s) in tmux`,
    });

    if (!status.agents.turns.length) {
      this.agentsCardEl.createDiv({
        cls: "dj-host-empty",
        text: "No agent turns running. Capacity is available.",
      });
      return;
    }

    const table = this.agentsCardEl.createEl("table", { cls: "dj-host-table" });
    const header = table.createEl("thead").createEl("tr");
    for (const col of ["pid", "agent", "model", "running"]) {
      header.createEl("th", { text: col });
    }
    const body = table.createEl("tbody");
    for (const turn of status.agents.turns) {
      const row = body.createEl("tr");
      row.createEl("td", { text: String(turn.pid) });
      row.createEl("td", { text: turn.agent ?? "—" });
      row.createEl("td", { text: (turn.model ?? "—").replace(/^claude-/, "") });
      row.createEl("td", { text: `${turn.startedAgo.toFixed(0)}s` });
    }
  }

  private patchFooter(status: HostStatus): void {
    if (!this.footerEl) return;
    this.footerEl.empty();

    const pressure = status.pressure ?? {};
    const parts = Object.entries(pressure)
      .map(([key, value]) => `${key} ${(value.avg10 ?? 0).toFixed(1)}%`)
      .join("  ·  ");

    this.footerEl.createDiv({
      text: [
        status.hostname,
        status.uptimeSeconds
          ? `up ${(status.uptimeSeconds / 3600).toFixed(1)} h`
          : null,
        status.kernel,
      ]
        .filter(Boolean)
        .join("  ·  "),
    });
    if (parts) {
      this.footerEl.createDiv({
        text: `stall (10s avg): ${parts}`,
        title: "Linux pressure-stall information (PSI) 10-second averages.",
      });
    }
    this.footerEl.createDiv({
      text: `sampled ${new Date(status.sampledAt * 1000).toLocaleTimeString()} · polling every ${
        Math.round(this.pollInterval / 1000)
      }s while tab is visible`,
    });
  }

  // ----------------------------------------------------------- primitives

  private tile(
    parent: HTMLElement,
    spec: { label: string; value: string; sub?: string; level: Level; series?: number[] }
  ): void {
    const tile = parent.createDiv({ cls: `dj-host-tile is-${spec.level}` });
    tile.createDiv({ cls: "dj-host-tile-label", text: spec.label });
    tile.createDiv({ cls: "dj-host-tile-value", text: spec.value });
    if (spec.sub) tile.createDiv({ cls: "dj-host-tile-sub", text: spec.sub });
    if (spec.series && spec.series.length > 2) {
      tile.appendChild(this.sparkline(spec.series, 120, 26));
    }
  }

  private meter(
    parent: HTMLElement,
    spec: {
      label: string;
      current: number;
      limit: number;
      text: string;
      level: Level;
      note?: string;
    }
  ): void {
    const wrap = parent.createDiv({ cls: `dj-host-meter is-${spec.level}` });
    const head = wrap.createDiv({ cls: "dj-host-meter-head" });
    head.createSpan({ cls: "dj-host-meter-label", text: spec.label });
    head.createSpan({ cls: "dj-host-meter-value", text: spec.text });

    const pct = spec.limit > 0 ? Math.max(0, Math.min(100, (spec.current / spec.limit) * 100)) : 0;
    const track = wrap.createDiv({ cls: "dj-host-meter-track" });
    const fill = track.createDiv({ cls: "dj-host-meter-fill" });
    fill.style.width = `${pct}%`;

    if (spec.note) wrap.createDiv({ cls: "dj-host-meter-note", text: spec.note });
  }

  private sparkline(values: number[], width: number, height: number): SVGSVGElement {
    const svg = createSvg("svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.addClass("dj-spark");
    svg.setAttribute("role", "img");
    svg.setAttribute("preserveAspectRatio", "none");

    if (values.length < 2) return svg;

    const pad = 3;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min < 1e-6 ? 1 : max - min;
    const x = (i: number) => pad + (i * (width - pad * 2)) / (values.length - 1);
    const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);

    const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);

    const area = createSvg("path");
    area.setAttribute(
      "d",
      `M ${points[0]} L ${points.slice(1).join(" L ")} L ${x(values.length - 1).toFixed(
        1
      )},${height} L ${x(0).toFixed(1)},${height} Z`
    );
    area.addClass("dj-spark-area");
    svg.appendChild(area);

    const line = createSvg("polyline");
    line.setAttribute("points", points.join(" "));
    line.addClass("dj-spark-line");
    svg.appendChild(line);

    const dot = createSvg("circle");
    dot.setAttribute("cx", x(values.length - 1).toFixed(1));
    dot.setAttribute("cy", y(values[values.length - 1]).toFixed(1));
    dot.setAttribute("r", "4");
    dot.addClass("dj-spark-dot");
    svg.appendChild(dot);

    svg.setAttribute(
      "aria-label",
      `${values.length} samples, latest ${values[values.length - 1].toFixed(
        1
      )}, range ${min.toFixed(1)} to ${max.toFixed(1)}`
    );
    return svg;
  }

  private trend(values: number[]): number | null {
    if (values.length < 4) return null;
    const half = Math.floor(values.length / 2);
    const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    return Number((mean(values.slice(half)) - mean(values.slice(0, half))).toFixed(2));
  }
}

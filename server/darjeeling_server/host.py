"""Host telemetry and hardware control endpoints."""

import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from darjeeling_server.agents import AGENTS
from darjeeling_server.auth import require_auth
from darjeeling_server.config import MAX_CONCURRENT_TURNS, VAULT_PATH
from darjeeling_server.terminal import tmux

router = APIRouter(prefix="/api/host", tags=["host"])

SYS_POWER = Path("/sys/class/power_supply")


class CpuSampler:
    """Background sampler for CPU usage percentage from /proc/stat."""

    def __init__(self, sample_interval: float = 1.0) -> None:
        self.sample_interval = sample_interval
        self._usage_pct: Optional[float] = None
        self._prev_total: Optional[int] = None
        self._prev_idle: Optional[int] = None
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._lock = threading.Lock()

    def _read_stat(self) -> Optional[Tuple[int, int]]:
        try:
            stat_path = Path("/proc/stat")
            if not stat_path.exists():
                return None
            fields = stat_path.read_text().splitlines()[0].split()[1:]
            values = [int(v) for v in fields]
            idle = values[3] + (values[4] if len(values) > 4 else 0)
            total = sum(values)
            return total, idle
        except (OSError, IndexError, ValueError):
            return None

    def start(self) -> None:
        if self._running:
            return
        initial = self._read_stat()
        if initial:
            self._prev_total, self._prev_idle = initial
        self._running = True
        self._thread = threading.Thread(
            target=self._loop, daemon=True, name="darjeeling-cpu-sampler"
        )
        self._thread.start()

    def stop(self) -> None:
        self._running = False

    def _loop(self) -> None:
        while self._running:
            time.sleep(self.sample_interval)
            cur = self._read_stat()
            if not cur:
                continue
            total, idle = cur
            with self._lock:
                if self._prev_total is not None and self._prev_idle is not None:
                    d_total = total - self._prev_total
                    d_idle = idle - self._prev_idle
                    if d_total > 0:
                        self._usage_pct = round(100.0 * (d_total - d_idle) / d_total, 1)
                self._prev_total = total
                self._prev_idle = idle

    def get_usage_pct(self) -> Optional[float]:
        with self._lock:
            if self._usage_pct is not None:
                return self._usage_pct
            cur = self._read_stat()
            if cur and self._prev_total is not None and self._prev_idle is not None:
                total, idle = cur
                d_total = total - self._prev_total
                d_idle = idle - self._prev_idle
                if d_total > 0:
                    return round(100.0 * (d_total - d_idle) / d_total, 1)
            return None


_cpu_sampler = CpuSampler()
_cpu_sampler.start()

# Active turns (CLI processes, API turns, probes) started by this server.
_active_turns: Dict[Any, Dict[str, Any]] = {}
_active_turn_pids: Dict[int, Dict[str, Any]] = _active_turns


def register_turn(key: Any, meta: Dict[str, Any]) -> None:
    _active_turns[key] = meta


def unregister_turn(key: Any) -> None:
    _active_turns.pop(key, None)


def _read(path: Path, cast=str, default=None):
    try:
        raw = path.read_text().strip()
    except (OSError, ValueError):
        return default
    if not raw:
        return default
    try:
        return cast(raw)
    except (TypeError, ValueError):
        return default


def _write_sysfs(path: Path, val: str) -> None:
    path.write_text(val)


def battery_info() -> Optional[Dict[str, Any]]:
    if not SYS_POWER.exists():
        return None

    ac_online = False
    for ac in SYS_POWER.glob("*"):
        if _read(ac / "type") == "Mains" and _read(ac / "online", int, 0) == 1:
            ac_online = True
            break

    bat_dir = next(
        (d for d in sorted(SYS_POWER.glob("*")) if _read(d / "type") == "Battery"),
        None,
    )
    if bat_dir is None:
        return None

    energy_now = _read(bat_dir / "energy_now", int)
    energy_full = _read(bat_dir / "energy_full", int)
    energy_design = _read(bat_dir / "energy_full_design", int)
    power_now = _read(bat_dir / "power_now", int)
    voltage = _read(bat_dir / "voltage_now", int)
    current = _read(bat_dir / "current_now", int)
    status = _read(bat_dir / "status") or "Unknown"

    watts = None
    if power_now is not None:
        watts = round(power_now / 1_000_000, 2)
    elif voltage and current:
        watts = round((voltage / 1_000_000) * (current / 1_000_000), 2)

    health = None
    if energy_full and energy_design:
        health = round(100 * energy_full / energy_design, 1)

    psu_outrun = ac_online and status == "Discharging"

    return {
        "present": True,
        "acOnline": ac_online,
        "status": status,
        "capacityPct": _read(bat_dir / "capacity", int),
        "healthPct": health,
        "energyNowWh": round(energy_now / 1_000_000, 2) if energy_now else None,
        "energyFullWh": round(energy_full / 1_000_000, 2) if energy_full else None,
        "energyDesignWh": round(energy_design / 1_000_000, 2) if energy_design else None,
        "cycleCount": _read(bat_dir / "cycle_count", int),
        "watts": watts,
        "voltageV": round(voltage / 1_000_000, 2) if voltage else None,
        "psuOutrun": psu_outrun,
        "chargeStartThreshold": _read(bat_dir / "charge_control_start_threshold", int),
        "chargeEndThreshold": _read(bat_dir / "charge_control_end_threshold", int),
        "thresholdWritable": os.access(
            bat_dir / "charge_control_end_threshold", os.W_OK
        ),
        "model": _read(bat_dir / "model_name"),
        "device": bat_dir.name,
    }


def thermal_info() -> Dict[str, Any]:
    zones = []
    thermal_dir = Path("/sys/class/thermal")
    if thermal_dir.exists():
        for zone in sorted(thermal_dir.glob("thermal_zone*")):
            temp = _read(zone / "temp", int)
            if temp is None:
                continue
            zones.append({
                "name": _read(zone / "type") or zone.name,
                "celsius": round(temp / 1000, 1),
            })

    cpu_c = None
    fan_rpm = None
    nvme_c = None
    hwmon_dir = Path("/sys/class/hwmon")
    if hwmon_dir.exists():
        for hwmon in sorted(hwmon_dir.glob("hwmon*")):
            name = _read(hwmon / "name") or ""
            if name in ("coretemp", "k10temp", "zenpower"):
                t = _read(hwmon / "temp1_input", int)
                if t is not None:
                    cpu_c = round(t / 1000, 1)
            elif name == "thinkpad":
                fan_rpm = _read(hwmon / "fan1_input", int)
            elif name == "nvme":
                nvme_c = _read(hwmon / "temp1_input", int)
                nvme_c = round(nvme_c / 1000, 1) if nvme_c else None

    if cpu_c is None:
        for target_zone in (
            "x86_pkg_temp",
            "cpu-thermal",
            "cpu_thermal",
            "soc-thermal",
            "soc_thermal",
        ):
            pkg = next(
                (z for z in zones if z["name"].lower() == target_zone.lower()), None
            )
            if pkg:
                cpu_c = pkg["celsius"]
                break
        if cpu_c is None:
            pkg = next(
                (
                    z
                    for z in zones
                    if "cpu" in z["name"].lower() or "soc" in z["name"].lower()
                ),
                None,
            )
            if pkg:
                cpu_c = pkg["celsius"]

    return {
        "cpuCelsius": cpu_c,
        "fanRpm": fan_rpm,
        "nvmeCelsius": nvme_c,
        "maxCelsius": max((z["celsius"] for z in zones), default=None),
        "zones": zones,
    }


def cpu_info() -> Dict[str, Any]:
    usage_pct = _cpu_sampler.get_usage_pct()

    load1 = load5 = load15 = None
    try:
        load1, load5, load15 = os.getloadavg()
    except OSError:
        pass

    cores = os.cpu_count() or 1
    freq_mhz = None
    cpu_sys = Path("/sys/devices/system/cpu")
    if cpu_sys.exists():
        freqs = [
            _read(f, int)
            for f in cpu_sys.glob("cpu[0-9]*/cpufreq/scaling_cur_freq")
        ]
        freqs = [f for f in freqs if f]
        if freqs:
            freq_mhz = round(sum(freqs) / len(freqs) / 1000)

    return {
        "usagePct": usage_pct,
        "cores": cores,
        "load1": round(load1, 2) if load1 is not None else None,
        "load5": round(load5, 2) if load5 is not None else None,
        "load15": round(load15, 2) if load15 is not None else None,
        "loadPerCore": round(load1 / cores, 2) if load1 is not None else None,
        "freqMhz": freq_mhz,
    }


def memory_info() -> Dict[str, Any]:
    fields: Dict[str, int] = {}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, _, rest = line.partition(":")
            parts = rest.split()
            if parts:
                fields[key] = int(parts[0])
    except (OSError, ValueError):
        return {}

    total = fields.get("MemTotal", 0)
    available = fields.get("MemAvailable", 0)
    swap_total = fields.get("SwapTotal", 0)
    swap_free = fields.get("SwapFree", 0)
    return {
        "totalMb": round(total / 1024),
        "availableMb": round(available / 1024),
        "usedMb": round((total - available) / 1024),
        "usedPct": round(100 * (total - available) / total, 1) if total else None,
        "swapTotalMb": round(swap_total / 1024),
        "swapUsedMb": round((swap_total - swap_free) / 1024),
    }


def pressure_info() -> Dict[str, Any]:
    """Linux PSI contention metrics."""
    out: Dict[str, Any] = {}
    for kind in ("cpu", "memory", "io"):
        path = Path("/proc/pressure") / kind
        try:
            first = path.read_text().splitlines()[0]
        except (OSError, IndexError):
            continue
        parsed = {}
        for token in first.split()[1:]:
            key, _, value = token.partition("=")
            try:
                parsed[key] = float(value)
            except ValueError:
                continue
        out[kind] = {"avg10": parsed.get("avg10"), "avg60": parsed.get("avg60")}
    return out


def disk_info(path: Path) -> Dict[str, Any]:
    try:
        st = os.statvfs(path)
    except OSError:
        return {}
    total = st.f_blocks * st.f_frsize
    free = st.f_bavail * st.f_frsize
    return {
        "path": str(path),
        "totalGb": round(total / 1024 ** 3, 1),
        "freeGb": round(free / 1024 ** 3, 1),
        "usedPct": round(100 * (total - free) / total, 1) if total else None,
    }


def agent_load() -> Dict[str, Any]:
    live = {}
    for key, meta in list(_active_turns.items()):
        proc = meta.get("proc")
        task = meta.get("task")
        if proc is not None:
            if proc.returncode is None:
                live[key] = meta
            else:
                _active_turns.pop(key, None)
        elif task is not None:
            if not task.done():
                live[key] = meta
            else:
                _active_turns.pop(key, None)
        else:
            if isinstance(key, int):
                if Path(f"/proc/{key}").exists():
                    live[key] = meta
                else:
                    _active_turns.pop(key, None)
            else:
                live[key] = meta

    tmux_agents = 0
    try:
        res = tmux("list-panes", "-a", "-F", "#{pane_current_command}")
        if res and res.returncode == 0:
            agent_bins = {a.binary for a in AGENTS.values() if a.binary}
            tmux_agents = sum(
                1 for line in res.stdout.split() if line.strip() in agent_bins
            )
    except Exception:
        pass

    return {
        "activeTurns": len(live),
        "maxConcurrentTurns": MAX_CONCURRENT_TURNS,
        "atCapacity": len(live) >= MAX_CONCURRENT_TURNS,
        "interactiveAgents": tmux_agents,
        "turns": [
            {
                "pid": key if isinstance(key, int) else None,
                "model": meta.get("model"),
                "agent": meta.get("agent"),
                "startedAgo": round(time.monotonic() - meta.get("started", 0), 1),
            }
            for key, meta in live.items()
        ],
    }


def uptime_seconds() -> Optional[float]:
    value = _read(Path("/proc/uptime"))
    if not value:
        return None
    try:
        return round(float(value.split()[0]), 1)
    except (ValueError, IndexError):
        return None


@router.get("/status", dependencies=[Depends(require_auth)])
async def host_status():
    battery = battery_info()
    thermal = thermal_info()
    cpu = cpu_info()
    agents = agent_load()

    alerts: List[Dict[str, str]] = []
    if battery and battery.get("psuOutrun"):
        alerts.append({
            "level": "critical",
            "title": "Running off battery while plugged in",
            "detail": "The load has outrun the power adapter; battery is discharging under AC.",
        })
    if battery and battery.get("present") and not battery.get("acOnline"):
        alerts.append({
            "level": "critical",
            "title": "On battery power",
            "detail": "Mains power disconnected.",
        })
    if (thermal.get("cpuCelsius") or 0) >= 85:
        alerts.append({
            "level": "critical",
            "title": f"CPU at {thermal['cpuCelsius']}°C",
            "detail": "High CPU temperature under load.",
        })
    elif (thermal.get("cpuCelsius") or 0) >= 75:
        alerts.append({
            "level": "warn",
            "title": f"CPU at {thermal['cpuCelsius']}°C",
            "detail": "Warm CPU temperature.",
        })
    if agents.get("atCapacity"):
        alerts.append({
            "level": "warn",
            "title": f"At concurrency cap ({MAX_CONCURRENT_TURNS})",
            "detail": "Further turns are refused until one finishes.",
        })
    if battery and battery.get("chargeEndThreshold") is not None:
        end_thresh = battery["chargeEndThreshold"]
        if end_thresh > 90:
            alerts.append({
                "level": "warn",
                "title": f"Charge limit is {end_thresh}%",
                "detail": "Battery held at high charge ceiling.",
            })
    if (cpu.get("loadPerCore") or 0) >= 1.5:
        alerts.append({
            "level": "warn",
            "title": f"Load {cpu.get('load1')} across {cpu.get('cores')} cores",
            "detail": "Oversubscribed.",
        })

    level = "ok"
    if any(a["level"] == "critical" for a in alerts):
        level = "critical"
    elif alerts:
        level = "warn"

    return {
        "sampledAt": int(time.time()),
        "level": level,
        "alerts": alerts,
        "battery": battery,
        "thermal": thermal,
        "cpu": cpu,
        "memory": memory_info(),
        "pressure": pressure_info(),
        "disk": disk_info(VAULT_PATH if VAULT_PATH.exists() else Path.home()),
        "agents": agents,
        "uptimeSeconds": uptime_seconds(),
        "hostname": os.uname().nodename,
        "kernel": os.uname().release,
    }


class ThresholdRequest(BaseModel):
    end: int
    start: Optional[int] = None


@router.post("/battery/threshold", dependencies=[Depends(require_auth)])
async def set_charge_threshold(req: ThresholdRequest):
    """
    Set hardware charge thresholds.

    Direction-aware write order with rollback (SRV-19).
    Direct sysfs writes governed by udev permissions only; no sudo fallback (SRV-23).
    """
    if not 40 <= req.end <= 100:
        raise HTTPException(status_code=400, detail="end must be between 40 and 100")
    start = req.start if req.start is not None else max(40, req.end - 5)
    if not 0 <= start < req.end:
        raise HTTPException(status_code=400, detail="start must be below end")

    if not SYS_POWER.exists():
        raise HTTPException(
            status_code=501,
            detail="Battery charge control not supported on this host",
        )

    bat_dir = next(
        (d for d in sorted(SYS_POWER.glob("*")) if _read(d / "type") == "Battery"),
        None,
    )
    if bat_dir is None:
        raise HTTPException(
            status_code=501,
            detail="Battery charge control not supported on this host",
        )

    end_file = bat_dir / "charge_control_end_threshold"
    start_file = bat_dir / "charge_control_start_threshold"

    if not end_file.exists():
        raise HTTPException(
            status_code=501,
            detail="Battery charge control not supported on this host",
        )

    current_end = _read(end_file, int)
    current_start = _read(start_file, int) if start_file.exists() else None

    # Kernel requires start <= end.
    # When raising end ceiling: write end first, then start.
    # When lowering ceiling: write start first, then end.
    is_raising = current_end is not None and req.end > current_end

    order: List[Tuple[str, Path, int, Optional[int]]] = []
    if start_file.exists():
        if is_raising:
            order = [
                ("charge_control_end_threshold", end_file, req.end, current_end),
                ("charge_control_start_threshold", start_file, start, current_start),
            ]
        else:
            order = [
                ("charge_control_start_threshold", start_file, start, current_start),
                ("charge_control_end_threshold", end_file, req.end, current_end),
            ]
    else:
        order = [("charge_control_end_threshold", end_file, req.end, current_end)]

    results = []
    written_so_far: List[Tuple[Path, Optional[int]]] = []

    for name, path, val, orig in order:
        try:
            _write_sysfs(path, str(val))
            results.append({"field": name, "value": val, "via": "direct"})
            written_so_far.append((path, orig))
        except OSError as err:
            for rollback_path, orig_val in reversed(written_so_far):
                if orig_val is not None:
                    try:
                        _write_sysfs(rollback_path, str(orig_val))
                    except OSError:
                        pass
            raise HTTPException(
                status_code=500,
                detail=f"Could not write {name}: {err}",
            )

    return {"status": "set", "written": results, "battery": battery_info()}

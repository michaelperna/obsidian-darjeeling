# Host Dashboard & Hardware Telemetry

The Host dashboard provides real-time visibility into the companion server's operating state, system load, thermals, and power subsystem. It is designed to ensure server-side agent runs and long-running builds do not overwhelm host resources or damage hardware.

---

## 1. Operating Philosophy & Lifecycle

Monitoring server hardware should never impose unnecessary overhead on the server:
- **Zero Idle Polling**: Telemetry is polled strictly on-demand. **Polling only runs while the Host tab is open and actively focused in Obsidian.** When switched to Chat, Plan, Terminal, or another leaf, polling halts immediately.
- **Direct Kernel Interfaces**: Telemetry is sampled directly from kernel `sysfs` and `procfs` without background daemons, third-party agents, or external network calls.
- **Accurate PID Tracking**: Process counts are derived from process trees spawned by the server and active tmux sessions, rather than naive pattern matching.

---

## 2. Hardware Sensors

The Host dashboard adapts to the underlying hardware architecture and only renders metric cards for sensors present on the machine:

| Metric Category | Kernel Source | Purpose |
|---|---|---|
| **CPU Usage & Frequency** | `/proc/stat`, `/proc/cpuinfo`, `/sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq` | Measures aggregate multi-core utilization and frequency scaling. |
| **System Load & Pressure** | `/proc/loadavg`, `/proc/pressure/{cpu,memory,io}` | Measures resource saturation. Pressure Stall Information (PSI) quantifies actual lost time waiting for CPU, memory, or I/O. |
| **System Memory** | `/proc/meminfo` | Tracks available RAM, active pages, buffers, and swap pressure. |
| **Thermals & Cooling** | `/sys/class/hwmon/*/temp*_input`, `/sys/class/thermal/*` | Monitors package temperatures and throttle thresholds across detected zones. |
| **Cooling Fans** | `/sys/class/hwmon/*/fan*_input` | Reports active fan RPM on supported hardware. |
| **Concurrent Turns** | Process table (`procfs`) | Tracks active agent turns and interactive tmux PTY sessions. |

---

## 3. Laptop Extras: Battery Life & Power Subsystem

When running the companion daemon on a laptop (such as a tethered workstation), power management requires specific safeguards:

### A. Preventing Battery Degradation
Continuous high state-of-charge (holding a battery at 100% while plugged into mains) is the primary cause of accelerated lithium-ion capacity loss. Darjeeling supports setting hardware charge thresholds:
- **Start Threshold (`charge_control_start_threshold`)**: The battery percentage below which charging begins (e.g. 75%).
- **Stop Threshold (`charge_control_end_threshold`)**: The battery percentage where charging stops (e.g. 80%).

On supported hardware (such as ThinkPad via `thinkpad_acpi`), the dashboard provides one-click presets (80%, 90%, 100%) and slider controls.

### B. The Unprivileged udev Rule
Writing to sysfs charge thresholds normally requires root privileges. The Darjeeling installer installs a udev rule (`/etc/udev/rules.d/99-darjeeling-battery.rules`) so the unprivileged `darjeeling` service user can write threshold values directly:

<!-- not-run: configuration example -->
```udev
# /etc/udev/rules.d/99-darjeeling-battery.rules
SUBSYSTEM=="power_supply", ATTR{charge_control_start_threshold}=="*", GROUP="darjeeling", MODE="0664"
SUBSYSTEM=="power_supply", ATTR{charge_control_end_threshold}=="*", GROUP="darjeeling", MODE="0664"
```

If the udev rule is not present, the server safely attempts a passwordless `sudo -n tee` fallback before reporting permission errors.

### C. Power Supply Outrun Warning (`psuOutrun`)
If an undersized AC adapter is connected during heavy multi-agent compilation, the laptop may pull supplementary current from the battery while plugged in (`status = Discharging` while `AC.online = 1`). The dashboard flags this condition immediately as a critical alert (`psuOutrun`), notifying the user to reduce concurrency or connect a higher-wattage power adapter.

---

## 4. Concurrency Limits & Overload Prevention

The companion server enforces a hard limit on concurrent turns (`DARJEELING_MAX_TURNS`, default: `2`):
- When the server is operating at capacity, incoming turn requests receive an immediate `429 Too Many Requests` (or WebSocket `dj.error` frame with reason `at capacity`).
- Requests are rejected immediately rather than invisibly queued, preventing unmonitored backlogs from building up while the host is under load.

---

## 5. Endpoints

The Host view interacts with two REST endpoints:
- `GET /api/host/status` (or `GET /api/telemetry`): Returns full system telemetry snapshot, sensor readings, and health status.
- `POST /api/host/battery`: Sets charge thresholds with payload `{ "start": 75, "end": 80 }`.

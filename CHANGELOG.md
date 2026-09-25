# Changelog

All notable changes to Project Darjeeling are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.4] - 2026-09-25

Patch release fixing install, pairing and release problems. Credit: the 1.0.3 review.

### Upgrading from 1.0.3
Upgrade the server with the **new** release's `install.sh`, not `sudo darjeeling upgrade`. The 1.0.3 CLI runs the installer already on the host, which is hard-coded to version `1.0.0-dev` and forces `bypassPermissions` on hosts migrated from 4.1.0.

```bash
VER=1.0.4
BASE="https://github.com/michaelperna/obsidian-darjeeling/releases/download/${VER}"
curl -fsSL -O "${BASE}/install.sh" -O "${BASE}/darjeeling-server-${VER}.tar.gz" -O "${BASE}/SHA256SUMS"
sha256sum --ignore-missing -c SHA256SUMS
sudo bash install.sh --tarball "darjeeling-server-${VER}.tar.gz" --yes
```

The upgrade keeps the host token, paired devices, `/etc/darjeeling/darjeeling.env` and an explicitly set permission ceiling.

**Upgrade order:** update the server first with the new `install.sh`, then every device. Devices still on 1.0.3 lose their synced token once any 1.0.4 device rewrites `data.json`. After updating, re-enter API keys and re-pair on devices that relied on a synced `data.json`.

### Breaking changes
- **The server no longer listens on every interface.** `DARJEELING_BIND` / `DARJEELING_HOST` set to `0.0.0.0`, `::` or a link-local address are refused at startup; 1.0.3 accepted them. The startup error names the variable and what to set instead (`interface:tailscale0`, `interface:nordlynx`, `address:<ip>` or `loopback`). The installer checks this before changing anything: with `--bind` or `--network` it rewrites the env file to your choice, with `--yes` it uses the host's only Tailscale or Meshnet address, and otherwise it stops (exit code 4) and lists the options.
- **agy resume ids are validated.** Session ids passed to agents must be UUIDs, except agy conversation ids, which must match `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`.

### Plugin
- API keys and host tokens are now stored separately on each device and are no longer synced through `data.json`. If you sync your vault, update every device to 1.0.4, then re-pair each device or re-enter your keys once. Darjeeling now tells you which device is missing what.
- Two devices sharing a vault now store each key under the same name, so a key entered on one device no longer shows as "no key" on another. Keys saved under older random names are moved over automatically.
- Typing a host token or API key no longer saves and reconnects on every keystroke. It saves once, when you leave the field or stop typing.
- Removing an API key now actually deletes it from Obsidian's secret storage. Keys are also stored in Obsidian's secret storage now, not only in the local fallback.
- New chats now honour a confirmed bypass mode, and a Notice appears whenever the mode is lowered.
- For new installs, `DARJEELING.md` is sent to direct cloud providers only if you opt in.

### Security
- **Safer default permission ceiling.** The shipped `darjeeling.env.example` set `DARJEELING_PERMISSION_CEILING=bypassPermissions`, which let any paired client run shell commands without confirmation. The default is now `acceptEdits`, and the comment lists the real values (`plan`, `acceptEdits`, `bypassPermissions`).
- **Legacy migration no longer forces `bypassPermissions`.** Migrating a 4.1.0 install overwrote the ceiling with `bypassPermissions` on every installer run. It now keeps an explicit value and otherwise uses `acceptEdits`, and prints how to raise it. On hosts the 1.0.3 installer migrated, a `bypassPermissions` ceiling is kept but flagged with a warning and the command to lower it (interactive runs ask; `--yes` keeps it). Check yours with `sudo darjeeling config get permission-ceiling`.
- **Pairing brute-force limits are per client.** Failed pairing claims are limited per client address (plus a looser global cap) and answered with `429`. A wrong guess no longer burns every live code, so nobody can lock you out of a code you are about to use.
- **DeepSeek API key kept out of the env file.** The installer and `darjeeling config set deepseek-api-key` now store the key in `/var/lib/darjeeling/secrets/deepseek_api_key` (mode `0600`, service user), which the server already read first. A key left in the env file is moved.
- **256-bit host token.** The installer now generates a 256-bit host token (64 hex characters) instead of 128-bit. Existing tokens are kept.
- **Re-running the installer on a migrated host no longer wipes paired devices.** The legacy migration rewrote `devices.json` on every run.

### Fixed
- **`darjeeling upgrade` runs the new release's installer.** It ran `/opt/darjeeling/current/install.sh`, the installer of the release being replaced. It now uses the stamped `install.sh` next to the tarball when its version matches, otherwise the one inside the tarball. Automatic rollback no longer "rolls back" to a release directory the upgrade reinstalled in place, and the replaced release is kept as `/opt/darjeeling/previous` for `darjeeling rollback`.
- **Existing clients keep working after the upgrade.** When `devices.json` exists but has no record for the host token, the server adds one at startup (not revoked) instead of refusing the token. A revoked record is left alone. An unreadable `devices.json` still refuses every token, and the log now says how to fix it.
- **DeepSeek key on re-runs.** The installer preferred the key in the old 4.1.0 `config.env` over the one in the env file; the env file now wins.
- **Installer re-runs keep your settings.** The 4.1.0 unit backup is taken once instead of being overwritten with the current unit, and `DARJEELING_VAULT` is set from the 4.1.0 config only on first migration or when converting 1.0.3's `DARJEELING_VAULT_PATH` (with a warning if the active vault changes).
- **Pairing from the server CLI works.** `darjeeling pair` and the installer ran as root and wrote `pairing.json` as `root:root 0600`, which the service could not read, so the printed code was always rejected. The CLI now loads `/etc/darjeeling/darjeeling.env` and drops to the service user before writing state; the installer runs it as the service user. Unreadable pairing files are logged instead of silently ignored.
- **Stray root-owned `/var/lib/darjeeling/token`.** Running the CLI as root no longer creates it (the default token path is now `.token`, matching the env file), and the installer removes a leftover one.
- **Legacy vault path.** Migration wrote `DARJEELING_VAULT_PATH`, which the server never read; it now writes `DARJEELING_VAULT`. `darjeeling config` keys `vault` and `vault-sync` map to `DARJEELING_VAULT` and `DARJEELING_VAULT_SYNC`.
- **Version reporting.** The installer read a hard-coded `1.0.0-dev`; it now uses the release's `VERSION` file (or the stamped value), so `/opt/darjeeling/releases/<version>`, the installer banner and `darjeeling version` agree.
- **Service `HOME`.** The units set `HOME=/home/darjeeling`, which does not exist; they now use the service user's real home (`/var/lib/darjeeling` by default, computed by the installer for other users).
- **Uninstall only removes what it installed.** `--uninstall` and `darjeeling uninstall` ran `rm -rf /opt/darjeeling`, deleting anything else there, including a repository cloned into it. They now remove only `releases/`, `current`, `backups/` and other installer-created files.
- **Release assets.** Releases now publish the reproducible server tarball, the stamped `install.sh`, and a `SHA256SUMS` covering every asset alongside `main.js`, `manifest.json` and `styles.css`.

### Documentation
- Install guide rewritten around the real flow: download `install.sh`, the server tarball and `SHA256SUMS` from the GitHub release, verify, run. Cloning `michaelperna/obsidian-darjeeling` is the alternative, to a path outside `/opt/darjeeling`. Removed a non-existent repository URL and a test-lab path.
- Pairing docs: the claim route is `POST /api/pair`, codes are valid for 10 minutes, and the non-existent `darjeeling token rotate` command is replaced by the real steps.
- Server reference: corrected environment variable names (`DARJEELING_VAULT`, `DARJEELING_PERMISSION_CEILING`) and endpoint paths.
- README: `claude login` command matches what the installer prints, the pairing QR code mention is gone (pairing uses the 8-digit code), and supported platforms are listed as tested on macOS and Linux, with Windows, iOS, Android and iPadOS supported.

---

## [1.0.0] - 2026-09-23

### Added
- **Multi-Runtime Agent Execution**:
  - Direct Provider APIs: Native Obsidian `requestUrl` integration with Anthropic Claude, Google Gemini, Ollama, and OpenAI-compatible endpoints. Supports mobile and desktop with zero server overhead.
  - Local CLI Mode: Spawns Claude Code CLI (`claude`) and native shells directly within the vault working directory on macOS and Linux desktop.
  - Remote Companion Server: Headless daemon (`darjeeling-server`) with WebSocket Protocol v2, stateful session resumption, per-turn buffer accounting, and asynchronous execution across disconnections.
- **Unified Chat Workspace**:
  - Stream-rendering markdown chat interface designed for desktop and mobile viewports.
  - Collapsible tool call cards with raw JSON inspection (Input / Output tabs).
  - Multi-agent turn switching with session persistence across client restarts.
  - Mid-turn interrupt controls and responsive accessory action bar for mobile touch devices.
- **Architectural Plan Engine**:
  - Phase-gated multi-stage planning surface with interactive checkbox state management.
  - Structured Markdown export with Dataview-compatible task metadata.
  - Native 2D interactive canvas export conforming to Obsidian JSON Canvas 1.0 specification.
- **Embedded PTY Terminal**:
  - High-performance terminal powered by xterm.js supporting truecolor, bracketed paste, and URL reassembly.
  - Mobile virtual accessory key bar featuring sticky Ctrl, Alt, Esc, Tab, PgUp, PgDn, and arrow navigation.
  - Clean separation of local PTY (desktop) and remote tmux session streams (companion server).
- **Host Dashboard & Hardware Telemetry**:
  - Lightweight hardware monitor tracking CPU load, memory usage, pressure stall information (PSI), and thermal sensors.
  - Battery charge threshold controls (`start_threshold` and `stop_threshold`) for supported laptop hardware (e.g. ThinkPad ACPI) via unprivileged udev rules.
  - Automated power outrun warnings (`psuOutrun`) alerting when power draw exceeds AC adapter rating.
  - Zero-overhead lifecycle: Telemetry polling only runs when the Host tab is open and active.
- **Secure Device Pairing**:
  - 8-digit temporary code pairing exchange and desktop-to-mobile QR code flow.
  - Cryptographically secure 256-bit token authentication stored exclusively in device-local storage (`SecretStorage`).
  - Strict rejection of query string tokens and instantaneous socket termination on token revocation.
- **Design System**:
  - Adaptive semantic token system (`--dj-*`) integrating with standard Obsidian light and dark themes.
  - Dynamic WCAG AA contrast calibration for light themes using CSS `color-mix()`.
  - Opt-in tea terroir palette (`.dj-palette-tea`) and procedural vector illustration factories.
  - Container-query responsive layouts adapting smoothly from mobile phone screens to wide desktop split leaves.

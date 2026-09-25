# Changelog

All notable changes to Project Darjeeling are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.4] - 2026-09-25

Patch release fixing install, pairing and release problems. Credit: the 1.0.3 review.

### Security
- **Safer default permission ceiling.** The shipped `darjeeling.env.example` set `DARJEELING_PERMISSION_CEILING=bypassPermissions`, which let any paired client run shell commands without confirmation. The default is now `acceptEdits`, and the comment lists the real values (`plan`, `acceptEdits`, `bypassPermissions`).
- **Legacy migration no longer forces `bypassPermissions`.** Migrating a 4.1.0 install overwrote the ceiling with `bypassPermissions` on every installer run. It now keeps an explicit value and otherwise uses `acceptEdits`, and prints how to raise it. If you migrated with 1.0.3 or earlier, check yours with `sudo darjeeling config get permission-ceiling`.
- **Pairing brute-force limits are per client.** Failed pairing claims are limited per client address (plus a looser global cap) and answered with `429`. A wrong guess no longer burns every live code, so nobody can lock you out of a code you are about to use.
- **DeepSeek API key kept out of the env file.** The installer and `darjeeling config set deepseek-api-key` now store the key in `/var/lib/darjeeling/secrets/deepseek_api_key` (mode `0600`, service user), which the server already read first. A key left in the env file is moved.
- **256-bit host token.** The installer now generates a 256-bit host token (64 hex characters) instead of 128-bit. Existing tokens are kept.
- **Re-running the installer on a migrated host no longer wipes paired devices.** The legacy migration rewrote `devices.json` on every run.

### Fixed
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

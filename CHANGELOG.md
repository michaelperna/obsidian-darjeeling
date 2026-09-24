# Changelog

All notable changes to Project Darjeeling are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **ADR-20 Design System**:
  - Adaptive semantic token system (`--dj-*`) integrating with standard Obsidian light and dark themes.
  - Dynamic WCAG AA contrast calibration for light themes using CSS `color-mix()`.
  - Opt-in tea terroir palette (`.dj-palette-tea`) and procedural vector illustration factories.
  - Container-query responsive layouts adapting smoothly from mobile phone screens to wide desktop split leaves.

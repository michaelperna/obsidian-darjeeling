<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/darjeeling-dark-squircle.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/darjeeling-logo-squircle.png">
    <img alt="Project Darjeeling" src="assets/darjeeling-dark-squircle.png" width="160" height="160">
  </picture>
</p>

<h1 align="center">Project Darjeeling</h1>

<p align="center">
  <strong>Run Claude Code and other AI agents on your own Linux server and pick up the same sessions on desktop or phone.</strong><br>
  <em>Includes chat, phase-gated plans saved as notes, a remote terminal, and direct chat with AI providers.</em>
</p>

---

## What is Darjeeling?

Project Darjeeling is an Obsidian plugin and companion server daemon designed to integrate AI coding agents and large language models seamlessly into your personal knowledge base.

- **Persistent Sessions**: Start an agent turn on your laptop, close the lid, and pick up the stream or interrupt it from your phone.
- **Architectural Plans as Notes**: Decompose complex tasks into phase-gated plans, track task checkboxes, and export directly to Markdown notes and 2D visual Obsidian Canvases (`.canvas`).
- **Mobile-First Ergonomics**: Touch-calibrated 44px hit targets, virtual terminal accessory keys, and responsive layouts that fit mobile sidebars.
- **Privacy & Ownership**: Your notes stay in your vault. Server connections run over encrypted private overlay networks (Tailscale, Meshnet, WireGuard) with zero third-party telemetry.

---

## Who It Is For (and Not For)

### Who It Is For
* **Developers & Technical Writers**: You work inside an Obsidian vault alongside git repositories and want agents like Claude Code to inspect files, run tests, and refactor code without leaving your notes.
* **Self-Hosters & Homelabbers**: You run a dedicated Linux machine, VPS, or tethered workstation and want to offload heavy agent compilation and turn processing.
* **Multi-Device Thinkers**: You plan initiatives on desktop and review or follow up on progress from your phone or tablet on the go.

### Who It Is NOT For
* If you only want to converse with Claude on your phone and do not use Obsidian or have a repository to inspect, you do not need Darjeeling. Use the official [Claude iOS/Android app](https://claude.ai) or Anthropic's Remote Control feature.

---

## How It Works

Darjeeling provides three distinct runtime modes:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Obsidian Client (Any Device)                     │
│               Chat Surface  •  Plan Engine  •  Terminal                 │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
      ┌──────────────────────────────┼──────────────────────────────┐
      ▼                              ▼                              ▼
┌──────────────┐              ┌──────────────┐              ┌──────────────┐
│  Direct API  │              │  Local Mode  │              │ Remote Server│
│(Zero Server) │              │(Desktop Only)│              │ (Companion)  │
└──────┬───────┘              └──────┬───────┘              └──────┬───────┘
       │                             │                             │
       ▼                             ▼                             ▼
Google Gemini / Anthropic     Local CLI (`claude`)          Headless Linux
Claude / DeepSeek / Ollama    & PTY in Vault Root           Daemon (Port 8765)
```

1. **Remote Companion Server**: A headless Python daemon (`darjeeling-server`) running on your Linux host. Runs Claude Code and tmux terminal sessions, streaming bidirectional Protocol v2 WebSocket events to your desktop or mobile Obsidian app over private overlay networks.
2. **Desktop Local Mode**: Spawns local CLI agents (`claude`, `agy`) and an embedded Python PTY terminal directly on macOS or Linux desktop within your vault working directory.
3. **Direct Provider API**: Connects Obsidian directly to Google Gemini, Anthropic Claude, DeepSeek, Ollama, or OpenAI-compatible endpoints with zero server requirements.

---

## Runtime Compatibility Matrix

| Runtime Mode | Supported Platforms | Shell & Tools | Session Resumption | Notes & Canvas Export | Status |
|---|---|---|---|---|---|
| **Remote Companion Server** | Linux Host<br>(Client: macOS, Linux, Windows, iOS, iPadOS, Android) | Yes (Full bash & tmux) | Yes (Protocol v2 async turn recovery) | Yes | **Stable** (v1.0) |
| **Desktop Local Mode** | macOS, Linux Desktop | Yes (Local PTY) | Process lifetime | Yes | **Stable** (v1.0) |
| **Direct Provider API** | macOS, Linux, Windows, iOS, iPadOS, Android | No (Completion only) | No | Yes | **Stable** (v1.0) |

> [!NOTE]
> **Agent Support**: Claude Code (`claude`, tested versions `0.2.29`–`0.2.32`) is the primary supported agent CLI. Support for Google Antigravity (`agy`) and DeepSeek CLI is **Experimental**.
> **Platforms**: Tested on macOS and Linux. Windows, iOS, Android and iPadOS are supported.

---

## Quick Starts

### Option 1: Remote Companion Server (4 Steps)

1. **Install Server Daemon** on your Linux host (Debian 12/13 or Ubuntu 22.04/24.04). Download the installer, the server tarball and `SHA256SUMS` from the [latest release](https://github.com/michaelperna/obsidian-darjeeling/releases/latest), verify, then run:
```bash
VER=1.0.4
BASE=https://github.com/michaelperna/obsidian-darjeeling/releases/download/$VER
curl -fsSL -O "$BASE/install.sh" -O "$BASE/darjeeling-server-$VER.tar.gz" -O "$BASE/SHA256SUMS"
sha256sum --ignore-missing -c SHA256SUMS
sudo bash install.sh --yes --network auto
```
2. **Authenticate Agent** as the service user (the installer prints this command, with the full path to `claude` if it is not on the service user's `PATH`):
```bash
sudo runuser -u darjeeling -- claude login
```
3. **Pair Device**: Run `sudo darjeeling pair` on the server (the installer also prints a code), then enter the 8-digit code in Obsidian under **Settings > Darjeeling > Connections**. A paired desktop can generate codes for your other devices.
4. **Synchronize Vault**: Configure Syncthing, git, or Obsidian Headless Sync between your devices and `/var/lib/darjeeling/vault` (remembering to **exclude `.obsidian/` in both directions**).

*Full installation details: [Server Installation Guide](docs/install-server.md).*

### Option 2: Direct API Mode (No Server Required)

1. Install and enable the Darjeeling plugin in Obsidian.
2. Navigate to **Settings > Darjeeling > Providers**.
3. Select your provider (**Google Gemini**, **Anthropic Claude**, **DeepSeek**, or **Ollama**) and enter your API key.
4. Open the Darjeeling leaf from the ribbon or command palette and start chatting immediately.

*Full details: [Direct API Guide](docs/direct-api.md).*

---

## Security, Privacy & Network Egress

Darjeeling is designed specifically for sensitive personal and professional knowledge vaults:

- **Strict Permission Sandboxing**: By default, agents operate in `plan` mode (read-only analysis). Modifying workspace files requires `acceptEdits`, and autonomous commands require `bypassPermissions` (subject to the host server's permission ceiling).
- **Protected Bearer Tokens**: Tokens are stored exclusively in device-local storage (`SecretStorage`). Revoking a device terminates active WebSockets immediately.
- **No Third-Party Telemetry**: Hardware metrics stay on your host machine. Telemetry polling only runs when the Host tab is open and active.

### Network use and data

Every outbound network call site is audited and accounted for. Outbound network traffic is strictly restricted to configured endpoints, direct LLM providers, or user-clicked hyperlinks:

| ID | Destination | Protocol | Purpose | Data Sent |
|---|---|---|---|---|
| `host-ws` | Configured Darjeeling host | WebSocket | Agent event streaming & interactive turns | Prompts, permission responses, session inputs |
| `host-http` | Configured Darjeeling host | HTTP/HTTPS | Health checks, agent listing, async turn management | Authentication token in header, turn options |
| `host-pairing` | Configured Darjeeling host | HTTP/HTTPS | Device token exchange & pairing verification | 8-digit pairing code, device metadata |
| `host-sync` | Configured Darjeeling host | HTTP/HTTPS | Vault note sync to remote host workspace | Selected markdown note content & relative path |
| `host-terminal` | Configured Darjeeling host | WebSocket | Remote interactive PTY terminal session | Keystrokes, terminal dimensions, auth token in protocol header |
| `provider-anthropic` | Anthropic API (`api.anthropic.com`) | HTTPS | Direct LLM completions & model listing | User prompts, optional system prompt, api key in header |
| `provider-gemini` | Google Gemini API (`generativelanguage.googleapis.com`) | HTTPS | Direct LLM completions & model listing | User prompts, optional system prompt, api key in header |
| `provider-deepseek` | DeepSeek API (`api.deepseek.com`) | HTTPS | Direct LLM completions & model listing | User prompts, optional system prompt, api key in header |
| `provider-ollama` | Local or configured Ollama instance | HTTP/HTTPS | Direct LLM completions & model listing | User prompts, optional system prompt |
| `provider-openai` | OpenAI-compatible endpoint | HTTP/HTTPS | Direct LLM completions & model listing | User prompts, optional system prompt, api key in header |
| `browser-open` | External browser target | OS URL Handler | Opening terminal hyperlinks in external browser | Destination URL clicked by user |

---

## Accounts, Pricing & Billing

* **100% Free & Open Source**: Project Darjeeling is free software released under the MIT License. There are no subscriptions, hidden fees, seat charges, or token markups.
* **Bring Your Own Keys / Accounts**: All API usage is billed directly to your own account with each respective model provider (Google Cloud, Anthropic, DeepSeek, OpenRouter, etc.).
* **Self-Hosted Infrastructure**: You provide your own server or compute instance (e.g., local home computer, spare laptop, Raspberry Pi 5, or private cloud VM).

---

## Processes & Filesystem Access

* **Local Mode**: Runs child processes directly under your personal user account. Subprocesses have access to your vault directory according to the selected permission mode.
* **Companion Server Mode**: Runs as an unprivileged dedicated service user (`darjeeling`) with systemd hardening (`NoNewPrivileges=yes`, `ProtectSystem=full`).
* **Vault Code Path Isolation**: Sync engines must exclude `.obsidian/` in both directions so that server-side file edits can never write untrusted plugins or snippets to connected client devices.

---

## Documentation

* **Setup & Operations**:
  * [Server Installation & Lifecycle Guide](docs/install-server.md)
  * [Networking & Private Overlays](docs/networking.md)
  * [Device Pairing & Security](docs/pairing.md)
  * [Vault Synchronization & File Safety](docs/vault-sync.md)
* **Agent Execution & Workflows**:
  * [AI Agents & CLI Integration](docs/agents.md)
  * [Direct Provider API Mode](docs/direct-api.md)
  * [Desktop Local Mode](docs/local-mode.md)
  * [Architectural Plans & Visual Canvases](docs/plans.md)
* **Monitoring & Reference**:
  * [Host Dashboard & Hardware Telemetry](docs/host-dashboard.md)
  * [Troubleshooting Guide by Symptom](docs/troubleshooting.md)
  * [Server Reference Manual (Env & Endpoints)](docs/server-reference.md)
  * [Protocol v2 Specification](docs/protocol.md)
* **Contributing & Policies**:
  * [Security Policy & Threat Model](SECURITY.md)
  * [Changelog](CHANGELOG.md)
  * [Contributing Guide](CONTRIBUTING.md)
  * [Design System Architecture](docs/contributing/design.md)
  * [Release Verification Checklist](docs/qa/release-checklist.md)
  * [Third-Party Software Notices](THIRD_PARTY_NOTICES.md)

---

## Credits & Acknowledgements

Project Darjeeling is built on open standards and open-source software:
- [Obsidian](https://obsidian.md) by Dynalist Inc.
- [xterm.js](https://github.com/xtermjs/xterm.js) by SourceLair and Christopher Jeffrey (MIT)
- Model APIs provided by Anthropic, Google, DeepSeek, and Ollama.

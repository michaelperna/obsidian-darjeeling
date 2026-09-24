# Server Reference Manual

This document provides a comprehensive technical reference for the Project Darjeeling companion server daemon (`darjeeling-server`), including configuration variables, security controls, and API endpoints.

---

## 1. Environment Variables & Configuration

The server configuration file is located at `/etc/darjeeling/darjeeling.env` (or `~/.config/darjeeling/darjeeling.env` in user-level mode). Changes require restarting the service (`sudo systemctl restart darjeeling.service`).

| Variable | Type | Default | Description |
|---|---|---|---|
| `DARJEELING_BIND` | string | `127.0.0.1` (or overlay IP) | The network interface IP address the server binds to. Set to your Tailscale, Meshnet, or WireGuard IP. |
| `DARJEELING_PORT` | integer | `8765` | TCP port for HTTP REST and WebSocket connections. |
| `DARJEELING_TOKEN_FILE` | string | `/var/lib/darjeeling/.token` | Path to the 256-bit server authentication master token file. |
| `DARJEELING_VAULT_PATH` | string | `/var/lib/darjeeling/vault` | Default root directory for agent command execution and workspace syncing. |
| `DARJEELING_MAX_TURNS` | integer | `2` | Maximum concurrent AI agent turns allowed. Excess turns are refused with HTTP 429. |
| `DARJEELING_MAX_SESSIONS` | integer | `10` | Maximum concurrent tmux PTY terminal sessions. |
| `DARJEELING_DEFAULT_PERMISSION_CEILING` | string | `acceptEdits` | System-wide maximum permission ceiling (`plan`, `acceptEdits`, or `bypassPermissions`). |
| `DARJEELING_LOG_LEVEL` | string | `INFO` | Logging verbosity (`DEBUG`, `INFO`, `WARNING`, `ERROR`). |
| `ANTHROPIC_API_KEY` | string | *(empty)* | Optional API key supplied to Claude Code for headless authentication. |

---

## 2. HTTP REST Endpoints

All endpoints except `GET /health` and `POST /api/pair/claim` require an `Authorization: Bearer <token>` header.

### Health & Pairing
* `GET /health`
  * **Auth**: Unauthenticated.
  * **Description**: Lightweight health probe for load balancers and network checks.
  * **Response**: `200 OK` `{ "status": "ok", "version": "1.0.0" }`.
* `POST /api/pair/code`
  * **Auth**: Authenticated (master or paired device token).
  * **Description**: Generates an 8-digit temporary pairing code valid for 5 minutes.
  * **Response**: `200 OK` `{ "code": "48291038", "expires_in": 300 }`.
* `POST /api/pair/claim`
  * **Auth**: Unauthenticated (secured by one-time 8-digit code).
  * **Payload**: `{ "code": "48291038", "device_name": "iPhone 16" }`.
  * **Response**: `200 OK` `{ "token": "dj_tok_...", "device_id": "dev_..." }`.
* `GET /api/pair/devices`
  * **Auth**: Authenticated.
  * **Description**: Lists all active paired devices and pairing metadata.
* `POST /api/pair/devices/revoke`
  * **Auth**: Authenticated.
  * **Payload**: `{ "device_id": "dev_..." }`.
  * **Description**: Revokes a device token and immediately closes open WebSockets for that device.

### Agent & Turn Management
* `GET /api/agents`
  * **Auth**: Authenticated.
  * **Description**: Returns installed agent runners (`claude`, `agy`), capabilities, and supported models.
* `GET /api/turns`
  * **Auth**: Authenticated.
  * **Description**: Lists active and completed agent turns.
* `POST /api/turns`
  * **Auth**: Authenticated.
  * **Payload**: `{ "agent": "claude", "prompt": "...", "permission_mode": "plan" }`.
  * **Description**: Initiates a new background or buffered turn.
* `GET /api/turns/<turn_id>`
  * **Auth**: Authenticated.
  * **Description**: Returns turn status, token metrics, and buffered output blocks.
* `POST /api/turns/<turn_id>/interrupt`
  * **Auth**: Authenticated.
  * **Description**: Halts execution of an active agent turn.

### Host Telemetry & Hardware
* `GET /api/host/status` (or `GET /api/telemetry`)
  * **Auth**: Authenticated.
  * **Description**: Returns hardware sensor metrics: CPU load, PSI pressure, memory, temperatures, and fan speed.
* `POST /api/host/battery`
  * **Auth**: Authenticated.
  * **Payload**: `{ "start": 75, "end": 80 }`.
  * **Description**: Sets hardware battery charge thresholds on supported laptop systems.

---

## 3. WebSocket Endpoints

Authentication is passed via the `Sec-WebSocket-Protocol: darjeeling.token.<token>` header or `Authorization: Bearer <token>`.

### `WS /ws/agent`
Interactive agent streaming channel implementing **Protocol v2**. Supports bidirectional turn execution, real-time token streaming, tool call approval prompts, and session reattachment.

### `WS /ws/terminal`
Interactive terminal streaming channel. Multiplexes raw PTY byte streams to and from dedicated host `tmux` sessions. Supports window resize events, binary data frames, and terminal signals (`SIGINT`, `SIGTERM`).

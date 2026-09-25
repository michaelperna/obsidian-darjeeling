# Server Reference Manual

This document provides a comprehensive technical reference for the Project Darjeeling companion server daemon (`darjeeling-server`), including configuration variables, security controls, and API endpoints.

---

## 1. Environment Variables & Configuration

The server configuration file is `/etc/darjeeling/darjeeling.env` (`root:darjeeling`, mode `0640`). Changes require restarting the service (`sudo systemctl restart darjeeling.service`). The management CLI reads the same file, and `sudo darjeeling config set <key> <value>` edits it.

| Variable | Type | Default | Description |
|---|---|---|---|
| `DARJEELING_BIND` | string | `127.0.0.1` | Listen address: `loopback`, an IP, `address:<ip>` or `interface:<name>`. Non-private addresses are refused unless `DARJEELING_ALLOW_PUBLIC_BIND=1`; `0.0.0.0`, `::` and link-local addresses are refused at startup since 1.0.4. `DARJEELING_HOST` is an alias. |
| `DARJEELING_PORT` | integer | `8765` | TCP port for HTTP REST and WebSocket connections. |
| `DARJEELING_STATE_DIR` | string | `/var/lib/darjeeling` | Token, paired devices, pairing codes, secrets and runtime files. |
| `DARJEELING_TOKEN_FILE` | string | `/var/lib/darjeeling/.token` | Host authentication token file (mode `0600`). The installer writes a 256-bit token (64 hex characters). |
| `DARJEELING_VAULT` | string | `/var/lib/darjeeling/vault` | Vault root on the server; agents run here. |
| `DARJEELING_VAULT_SYNC` | string | `none` | `none` or `obsidian-sync`. |
| `DARJEELING_SESSION` | string | `darjeeling` | Default terminal session name. |
| `DARJEELING_TMUX_SOCKET` | string | `darjeeling` | Dedicated tmux socket name. |
| `DARJEELING_TURN_TIMEOUT` | integer | `1800` | Maximum seconds for a single agent turn. |
| `DARJEELING_MAX_CONCURRENT_TURNS` | integer | `2` | Concurrent agent turns (the installer sets `1` on hosts with less than 4 GB RAM). |
| `DARJEELING_PERMISSION_CEILING` | string | `acceptEdits` | Highest permission mode a client may request: `plan`, `acceptEdits` or `bypassPermissions`. |
| `DARJEELING_ACCESS_LOG` | `0`/`1` | `0` | HTTP access logging to journald. |
| `DARJEELING_SERVER_NAME` | string | hostname | Name returned to clients when they pair. |
| `DEEPSEEK_BASE_URL` | string | `https://api.deepseek.com` | DeepSeek endpoint. |
| `ANTHROPIC_API_KEY` | string | *(empty)* | Optional API key passed to Claude Code for headless authentication. |

The DeepSeek API key is read from `/var/lib/darjeeling/secrets/deepseek_api_key` (mode `0600`); set it with `sudo darjeeling config set deepseek-api-key` (prompts, or reads stdin). `DEEPSEEK_API_KEY` in the env file still works as a fallback.

---

## 2. HTTP REST Endpoints

All endpoints except `GET /health` and `POST /api/pair` require an `Authorization: Bearer <token>` header.

### Health & Pairing
* `GET /health`
  * **Auth**: Unauthenticated.
  * **Description**: Lightweight health probe for load balancers and network checks.
  * **Response**: `200 OK` with `status` and the server `version`.
* `POST /api/pair/code`
  * **Auth**: Authenticated (host token or paired device token).
  * **Description**: Generates an 8-digit single-use pairing code, valid for 10 minutes.
  * **Response**: `200 OK` `{ "code": "48291038", "formatted_code": "4829 1038", "expires_in": 600 }`.
* `POST /api/pair`
  * **Auth**: Unauthenticated (secured by the one-time 8-digit code; failed claims are rate limited per client address, `429` when exceeded).
  * **Payload**: `{ "code": "48291038", "device_name": "iPhone 16", "platform": "ios" }`.
  * **Response**: `200 OK` `{ "token": "...", "device_id": "dev_...", "server_name": "...", "api": "1.0.0" }`. The device token is 256-bit.
* `GET /api/devices`
  * **Auth**: Authenticated.
  * **Description**: Lists active paired devices (never returns token hashes).
* `DELETE /api/devices/{device_id}`
  * **Auth**: Authenticated.
  * **Description**: Revokes a device token and closes its open WebSockets with close code `4401`.

### Agent & Turn Management
* `GET /api/agents`
  * **Auth**: Authenticated.
  * **Description**: Returns installed agent runners (`claude`, `agy`), capabilities, and supported models.
* `GET /api/turns`
  * **Auth**: Authenticated.
  * **Description**: Lists active and completed agent turns.
* `POST /api/agent/turn`
  * **Auth**: Authenticated.
  * **Description**: Starts a buffered agent turn that keeps running if the client disconnects.
* `GET /api/turns/{turn_id}/events`
  * **Auth**: Authenticated.
  * **Description**: Returns buffered events for a turn (long-poll with `wait`).
* `POST /api/turns/{turn_id}/interrupt`
  * **Auth**: Authenticated.
  * **Description**: Halts execution of an active agent turn.

### Host Telemetry & Hardware
* `GET /api/host/status`
  * **Auth**: Authenticated.
  * **Description**: Returns hardware sensor metrics: CPU load, PSI pressure, memory, temperatures, and fan speed.
* `POST /api/host/battery/threshold`
  * **Auth**: Authenticated.
  * **Description**: Sets hardware battery charge thresholds on supported laptop systems (laptop profile only).

---

## 3. WebSocket Endpoints

Authentication is passed via the `Sec-WebSocket-Protocol: darjeeling.token.<token>` header or `Authorization: Bearer <token>`.

### `WS /ws/agent`
Interactive agent streaming channel implementing **Protocol v2**. Supports bidirectional turn execution, real-time token streaming, tool call approval prompts, and session reattachment.

### `WS /ws/terminal`
Interactive terminal streaming channel. Multiplexes raw PTY byte streams to and from dedicated host `tmux` sessions. Supports window resize events, binary data frames, and terminal signals (`SIGINT`, `SIGTERM`).

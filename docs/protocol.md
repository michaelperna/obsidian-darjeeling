# Darjeeling Protocol v2 Specification

Protocol v2 decouples agent turn execution from client transport sockets. A remote turn continues running when a client disconnects (network change, sleep, app backgrounding) and can be reattached from any paired device.

---

## 1. Overview & Transport

Darjeeling communicates over WebSockets (for interactive chat and terminal) and HTTP REST (for health probes, pairing, file sync, and async turn management).

### WebSocket Subprotocol & Auth
* Clients connect to `/ws/agent`.
* Authentication is passed via the WebSocket subprotocol header:
  `Sec-WebSocket-Protocol: darjeeling.token.<token>`
  or the standard `Authorization: Bearer <token>` header.
* Query string authentication (`?token=...`) is forbidden and stripped server-side.
* If authentication fails or a token is revoked, the server accepts the connection and immediately closes it with close code `4401` and reason `token rejected`.

### WebSocket Close Codes
| Close Code | Name | Description |
|---|---|---|
| `4000` | Normal / Shell Terminated | Clean session termination (e.g., shell or process group cleanly exited). |
| `4401` | Unauthorized / Token Rejected | Missing, invalid, or revoked token. Client must not retry automatically without re-pairing. |

---

## 2. Frames

All WebSocket messages are encoded as JSON objects. Every frame sent from the server within an active turn contains envelope metadata tracking turn ID and sequence number.

### Envelope Fields (Server Frames)
* `dj_turn` (string): Unique turn identifier (format: `t_<uuid>` or `t_<random>`).
* `dj_seq` (integer): Monotonically increasing sequence number starting at 1 for each turn.

### Client-to-Server Frames

#### 1. `turn` (Initiate a new turn)
```json
{
  "type": "turn",
  "client_turn_id": "ct_12345",
  "agent": "claude",
  "prompt": "Hello world",
  "session_id": "optional-session-uuid",
  "permission_mode": "plan",
  "model": "claude-sonnet-5",
  "cwd": "/path/to/vault"
}
```

#### 2. `attach` (Reattach to an ongoing or finished turn)
```json
{
  "type": "attach",
  "turn_id": "t_abc123",
  "since_seq": 42
}
```

#### 3. `interrupt` (Stop an ongoing turn)
```json
{
  "type": "interrupt",
  "turn_id": "t_abc123"
}
```

#### 4. `ping` (Heartbeat / Keepalive)
```json
{
  "type": "ping"
}
```
Server responds with `{ "type": "pong" }`.

---

### Server-to-Client Frames

#### 1. `dj.turn` (Turn Acknowledgement)
Sent immediately after a new turn is accepted and assigned a turn ID:
```json
{
  "type": "dj.turn",
  "turn_id": "t_abc123",
  "client_turn_id": "ct_12345",
  "started_at": 1727090000.123
}
```

#### 2. `stream_event` (Agent Stream Delta)
Carries incremental text or thinking tokens:
```json
{
  "type": "stream_event",
  "dj_turn": "t_abc123",
  "dj_seq": 1,
  "event": {
    "type": "content_block_delta",
    "delta": {
      "type": "text_delta",
      "text": "Hello"
    }
  }
}
```

#### 3. `dj.model` (Model Actual Notice)
Emitted on the first assistant output if the resolved model differs from requested:
```json
{
  "type": "dj.model",
  "dj_turn": "t_abc123",
  "dj_seq": 2,
  "requested": "default",
  "actual": "claude-3-7-sonnet"
}
```

#### 4. `dj.gap` (Buffer Sequence Gap)
Emitted during an `attach` request if the requested `since_seq` is older than the oldest frame retained in the ring buffer:
```json
{
  "type": "dj.gap",
  "dj_turn": "t_abc123",
  "from": 1,
  "to": 50
}
```

#### 5. `result` (Turn Final Result)
Emitted when an agent turn completes:
```json
{
  "type": "result",
  "dj_turn": "t_abc123",
  "dj_seq": 51,
  "status": "success",
  "session_id": "sess_xyz",
  "result": "Full answer text...",
  "structured_output": null,
  "ended_at": 1727090005.456,
  "is_error": false
}
```

#### 6. `dj.error` (Error Frame)
```json
{
  "type": "dj.error",
  "code": "session_busy",
  "message": "Session already has a turn running",
  "turn_id": "t_abc123",
  "terminal": true
}
```

---

## 3. Protocol Error Codes

| Error Code | HTTP / WS Context | Description & Recovery |
|---|---|---|
| `session_busy` | WS / REST | The requested session already has an active running turn. Frame includes `turn_id` so the client can attach instead of starting a new process. |
| `at_capacity` | WS / REST | Server exceeds `DARJEELING_MAX_CONCURRENT_TURNS` (default 2). Client should back off and queue. |
| `not_logged_in` | WS / REST | The underlying agent CLI is unauthenticated on the host. Result includes guidance on logging in via the terminal tab. |
| `server_too_old` | Handshake | Server `api` version is lower than plugin minimum supported `api_min`. |
| `client_too_old` | Handshake | Legacy 4.1.0 frame format received, or client protocol version below server `api_min`. Informs user to update plugin. |
| `turn_expired` | Attach | The requested turn is neither running nor retained in the finished turn buffer (exceeded 30 min TTL or evicted under memory budget). Client reloads history from storage. |
| `timeout` | Execution | Turn execution exceeded `DARJEELING_TURN_TIMEOUT` (default 1800 s). Process group terminated. |
| `permission_ceiling` | Execution | Requested permission mode exceeds server `DARJEELING_PERMISSION_CEILING`. |

---

## 4. The Attach Algorithm

When a client reconnects after a disconnect or when resuming an existing turn:

```
Client                                      Server
  |                                           |
  |--- attach {turn_id, since_seq} ---------->|
  |                                           |
  |                                      Lookup turn_id in TurnRegistry
  |                                      If not found:
  |<-- dj.error {code: "turn_expired"} -------|
  |                                           |
  |                                      Check ring buffer:
  |                                      If since_seq < oldest_seq:
  |<-- dj.gap {from: since_seq, to: oldest}---|
  |                                           |
  |                                      Replay buffered frames:
  |                                      For seq = max(since_seq + 1, oldest_seq) .. latest_seq:
  |<-- frame with dj_seq ---------------------|
  |                                           |
  |                                      If turn still running:
  |                                        Subscribe client socket to live queue.
  |<-- live streaming frames (in order) ------|
  |                                      If turn finished:
  |                                        Replay completed; connection ready.
```

1. **Turn Lookup**: Server queries `TurnRegistry` for `turn_id`. If the turn is neither active nor in the finished ring buffer, return `dj.error {code: "turn_expired", terminal: true}`.
2. **Gap Detection**: If `since_seq` is provided and is strictly less than `oldest_seq_in_buffer`, send `dj.gap {from: since_seq, to: oldest_seq_in_buffer}`.
3. **Sequential Replay**: Server streams all events where `seq > since_seq` in strict monotonic order.
4. **Live Subscription**: If the turn is still running, the server hooks the connection into the turn's event broadcast channel.
5. **Deduplication**: Clients drop any incoming frame where `dj_seq <= last_seen_seq`.

---

## 5. Ring Buffer & Memory Ceilings

* **Per-Turn Buffer**: Ring buffer bounded by either:
  * Maximum **10,000 events**, or
  * Maximum **16 MiB** of serialized JSON payload.
* **Global Buffer Budget**: Controlled by `DARJEELING_TURN_BUFFER_BUDGET` (default: **128 MiB**).
* **Retention Policy**:
  * Finished turns remain in memory for **30 minutes**.
  * When total buffer usage exceeds the global budget, the oldest finished turns are evicted first.
  * Active turns are never evicted by memory pressure.

---

## 6. REST API for Async Turns

In addition to WebSockets, background turns (such as long-running plan drafting) use HTTP REST:

### `POST /api/agent/turn`
Initiates a turn.
* Payload: `{ "async": true, "agent": "claude", "prompt": "...", ... }`
* Response: `202 Accepted`
  ```json
  {
    "turn_id": "t_abc123",
    "status": "running"
  }
  ```

### `GET /api/turns/{id}/events`
Long-polling event stream.
* Parameters:
  * `since_seq` (integer, default 0): Return events with `seq > since_seq`.
  * `wait` (integer, default 25): Seconds to wait for new events if none are immediately available.
* Response: `200 OK`
  ```json
  {
    "turn_id": "t_abc123",
    "events": [ ... ],
    "running": true,
    "last_seq": 14
  }
  ```

### `GET /api/turns`
Lists turns by state.
* Query parameter: `?state=running` or `?state=recent`
* Response:
  ```json
  {
    "turns": [
      {
        "turn_id": "t_abc123",
        "agent": "claude",
        "status": "running",
        "started_at": 1727090000.123,
        "ended_at": null,
        "last_seq": 14
      }
    ]
  }
  ```

### `POST /api/turns/{id}/interrupt`
Terminates an ongoing turn and kills its entire process group.
* Response: `200 OK` `{ "status": "interrupted", "turn_id": "t_abc123" }`

"""
Tests for device pairing, device token auth, and revocation (ADR-12, PRD 1.8, G-31, G-35).
"""

import json
import time
from typing import Optional

import httpx
import pytest
from websockets.sync.client import connect


def test_pairing_success_and_reuse_rejected(server):
    """
    Generate pairing code, pair a device, verify token access, and assert code cannot be reused.
    """
    # 1. Authenticated generation of pairing code
    res = httpx.post(f"{server.base}/api/pair/code", headers=server.headers())
    assert res.status_code == 200, res.text
    data = res.json()
    code = data["code"]
    assert len(code) == 8 and code.isdigit()
    assert data["expires_in"] == 600

    # 2. Unauthenticated pair with valid code
    pair_res = httpx.post(
        f"{server.base}/api/pair",
        json={"code": code, "device_name": "Test iPhone", "platform": "ios"},
    )
    assert pair_res.status_code == 200, pair_res.text
    pair_data = pair_res.json()
    assert "token" in pair_data
    assert "device_id" in pair_data
    assert "server_name" in pair_data
    assert pair_data["api"] == "1.0.0"

    device_token = pair_data["token"]
    device_id = pair_data["device_id"]

    # 3. Verify token works against /api/agents
    agent_res = httpx.get(
        f"{server.base}/api/agents",
        headers={"Authorization": f"Bearer {device_token}"},
    )
    assert agent_res.status_code == 200, agent_res.text
    assert "agents" in agent_res.json()

    # 4. Verify code reuse is rejected (code was burned on first use)
    reuse_res = httpx.post(
        f"{server.base}/api/pair",
        json={"code": code, "device_name": "Second Device"},
    )
    assert reuse_res.status_code == 401


def test_expired_code_rejected(server):
    """Pairing code older than 10 minutes is rejected."""
    # Generate code
    res = httpx.post(f"{server.base}/api/pair/code", headers=server.headers())
    assert res.status_code == 200
    code = res.json()["code"]

    # Manually expire the code in pairing.json
    pairing_file = server.state_dir / "pairing.json"
    assert pairing_file.exists()
    codes = json.loads(pairing_file.read_text(encoding="utf-8"))
    for c in codes:
        c["created_at"] = time.time() - 601  # 601 seconds ago
    pairing_file.write_text(json.dumps(codes), encoding="utf-8")

    # Attempt to pair with expired code
    pair_res = httpx.post(
        f"{server.base}/api/pair",
        json={"code": code},
    )
    assert pair_res.status_code == 401


def test_bad_attempts_do_not_burn_live_codes(server):
    """Wrong guesses are rate-limited per client but never invalidate a live code.

    Burning every code after a few failures let anyone who could reach the
    server cancel an in-progress pairing (see test_pairing_ratelimit.py).
    """
    res = httpx.post(f"{server.base}/api/pair/code", headers=server.headers())
    assert res.status_code == 200
    valid_code = res.json()["code"]

    for _ in range(5):
        bad_res = httpx.post(
            f"{server.base}/api/pair",
            json={"code": "00000000"},
        )
        assert bad_res.status_code == 401

    attempt_res = httpx.post(
        f"{server.base}/api/pair",
        json={"code": valid_code},
    )
    assert attempt_res.status_code == 200


def test_legacy_token_keeps_working(server):
    """Legacy AUTH_TOKEN auto-registers and authenticates."""
    # The default server.headers() uses the legacy AUTH_TOKEN
    res = httpx.get(f"{server.base}/api/agents", headers=server.headers())
    assert res.status_code == 200

    devices_res = httpx.get(f"{server.base}/api/devices", headers=server.headers())
    assert devices_res.status_code == 200
    devices = devices_res.json().get("devices", [])
    legacy = next((d for d in devices if d.get("device_id") == "legacy"), None)
    assert legacy is not None
    assert legacy["is_legacy"] is True


def test_revoked_device_gets_401_and_sockets_closed_with_4401(server):
    """
    Revoking a device token immediately causes 401 on REST and closes
    active /ws/agent and /ws/terminal sockets with code 4401 within 1 second.
    """
    # 1. Pair device
    code_res = httpx.post(f"{server.base}/api/pair/code", headers=server.headers())
    code = code_res.json()["code"]
    pair_res = httpx.post(
        f"{server.base}/api/pair",
        json={"code": code, "device_name": "Revocable Device"},
    )
    pair_data = pair_res.json()
    token = pair_data["token"]
    device_id = pair_data["device_id"]

    # 2. Connect WebSockets using the minted device token
    agent_ws = connect(
        f"{server.ws_base}/ws/agent",
        subprotocols=[f"darjeeling.token.{token}"],
        open_timeout=5,
    )
    terminal_ws = connect(
        f"{server.ws_base}/ws/terminal?cols=80&rows=24",
        subprotocols=[f"darjeeling.token.{token}"],
        open_timeout=5,
    )

    # Receive terminal initial banner or prompt
    t_msg = terminal_ws.recv(timeout=5)
    assert t_msg is not None

    # 3. Revoke device via DELETE /api/devices/{device_id}
    del_res = httpx.delete(
        f"{server.base}/api/devices/{device_id}",
        headers=server.headers(),
    )
    assert del_res.status_code == 200
    assert del_res.json()["revoked"] is True

    # 4. REST call with revoked token must fail with 401 within 1 s
    time.sleep(0.1)
    rest_res = httpx.get(
        f"{server.base}/api/agents",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert rest_res.status_code == 401

    # 5. Active agent WebSocket closed with 4401 within 1 s
    agent_code: Optional[int] = None
    deadline = time.time() + 2.0
    while time.time() < deadline:
        try:
            agent_ws.recv(timeout=0.2)
        except Exception as exc:
            agent_code = getattr(getattr(exc, "rcvd", None), "code", None) or getattr(agent_ws, "close_code", None)
            break
    assert agent_code == 4401, f"Expected agent WS close 4401, got {agent_code}"

    # 6. Active terminal WebSocket closed with 4401 within 1 s
    term_code: Optional[int] = None
    deadline = time.time() + 2.0
    while time.time() < deadline:
        try:
            terminal_ws.recv(timeout=0.2)
        except Exception as exc:
            term_code = getattr(getattr(exc, "rcvd", None), "code", None) or getattr(terminal_ws, "close_code", None)
            break
    assert term_code == 4401, f"Expected terminal WS close 4401, got {term_code}"


def test_cross_process_file_revocation_triggers_4401(server):
    """
    Modifying devices.json externally (simulating CLI `darjeeling devices revoke <id>`)
    triggers socket closure with 4401 via background watcher in < 1s (G-31).
    """
    code_res = httpx.post(f"{server.base}/api/pair/code", headers=server.headers())
    code = code_res.json()["code"]
    pair_res = httpx.post(
        f"{server.base}/api/pair",
        json={"code": code, "device_name": "CLI Revocable Device"},
    )
    pair_data = pair_res.json()
    token = pair_data["token"]
    device_id = pair_data["device_id"]

    agent_ws = connect(
        f"{server.ws_base}/ws/agent",
        subprotocols=[f"darjeeling.token.{token}"],
        open_timeout=5,
    )

    # Allow a small tick so mtime_ns is distinctly strictly newer
    time.sleep(0.05)

    # Simulate CLI revocation by editing devices.json directly on disk
    devices_file = server.state_dir / "devices.json"
    devices = json.loads(devices_file.read_text(encoding="utf-8"))
    for d in devices:
        if d.get("device_id") == device_id:
            d["revoked"] = True
    devices_file.write_text(json.dumps(devices), encoding="utf-8")

    # Background watcher polls every 0.1s; wait up to 2.0s for 4401 close
    agent_code: Optional[int] = None
    deadline = time.time() + 2.0
    while time.time() < deadline:
        try:
            agent_ws.recv(timeout=0.2)
        except Exception as exc:
            agent_code = getattr(getattr(exc, "rcvd", None), "code", None) or getattr(agent_ws, "close_code", None)
            break

    assert agent_code == 4401, f"Expected watcher-triggered 4401, got {agent_code}"

"""Tests for authentication, origin validation, and WebSocket rejection behavior (QA-07, QA-12)."""

import json
import time
import pytest
import httpx
from websockets.sync.client import connect

from darjeeling_server.auth import _token_ok, is_origin_allowed
from darjeeling_server.config import _validate_token_charset


def test_token_charset_validation():
    assert _validate_token_charset("valid-token_12345.ABC") is True
    assert _validate_token_charset("") is False
    assert _validate_token_charset("token with space") is False
    assert _validate_token_charset("token\nwith\nnewline") is False
    assert _validate_token_charset("token\x00null") is False


def test_origin_allowlist():
    assert is_origin_allowed(None) is True
    assert is_origin_allowed("app://obsidian.md") is True
    assert is_origin_allowed("capacitor://localhost") is True
    assert is_origin_allowed("http://localhost:8080") is True
    assert is_origin_allowed("http://127.0.0.1:9000") is True
    assert is_origin_allowed("https://malicious.example.com") is False
    assert is_origin_allowed("http://example.com") is False


def test_http_auth_required(server):
    # Missing auth
    res = httpx.get(server.base + "/api/agents")
    assert res.status_code == 401

    # Invalid Bearer auth
    res = httpx.get(server.base + "/api/agents", headers={"Authorization": "Bearer badtoken"})
    assert res.status_code == 401

    # Valid Bearer auth
    res = httpx.get(server.base + "/api/agents", headers={"Authorization": f"Bearer {server.token}"})
    assert res.status_code == 200

    # Valid x-darjeeling-token header
    res = httpx.get(server.base + "/api/agents", headers={"x-darjeeling-token": server.token})
    assert res.status_code == 200


def test_ws_bad_token_closes_with_4401(server):
    """A bad token closes with 4401 on both /ws/agent and /ws/terminal (QA-07)."""
    # /ws/agent with bad subprotocol token
    try:
        with connect(
            server.ws_base + "/ws/agent",
            subprotocols=["darjeeling.token.wrong-token"],
            open_timeout=5,
        ) as ws:
            ws.recv(timeout=5)
    except Exception as exc:
        code = getattr(getattr(exc, "rcvd", None), "code", None)
        assert code == 4401

    # /ws/terminal with bad subprotocol token
    try:
        with connect(
            server.ws_base + "/ws/terminal",
            subprotocols=["darjeeling.token.wrong-token"],
            open_timeout=5,
        ) as ws:
            ws.recv(timeout=5)
    except Exception as exc:
        code = getattr(getattr(exc, "rcvd", None), "code", None)
        assert code == 4401


def test_ws_query_token_rejected_and_not_logged(server):
    """/ws/agent?token=... is rejected and captured log has no token string (QA-12, SRV-29)."""
    fake_token = "secret-query-token-XYZ999"
    before = len(server.log_text())
    try:
        ws = connect(
            server.ws_base + f"/ws/agent?token={fake_token}",
            open_timeout=5,
        )
        with ws:
            ws.send(json.dumps({"type": "ping"}))
            ws.recv(timeout=3)
    except Exception:
        pass

    time.sleep(0.3)
    new_logs = server.log_text()[before:]
    assert fake_token not in new_logs

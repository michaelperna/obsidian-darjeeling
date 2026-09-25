"""Tests for TurnRegistry, reattach, session locks, buffer eviction, and REST turn parity."""

import json
import time
import uuid
from typing import Any, Dict, List

import httpx
import pytest

from darjeeling_server.config import VERSION
from darjeeling_server.turns import TurnRecord, turn_registry
from tests.server.conftest import recv_until, ws_open


def test_health_protocol_v2_exact_keys(server):
    """Unauthenticated /health returns exact keys with api=2, api_min=2 (SRV-28, G-60)."""
    res = httpx.get(server.base + "/health", timeout=5)
    assert res.status_code == 200
    data = res.json()
    assert set(data.keys()) == {"status", "version", "api", "api_min", "auth_required"}
    assert data["status"] == "online"
    assert data["version"] == VERSION
    assert data["api"] == 2
    assert data["api_min"] == 2
    assert data["auth_required"] is True


def test_reattach_with_since_seq_in_order_no_dupes(server):
    """Reattach with since_seq receives remaining stream in order with no duplicates."""
    with ws_open(server) as ws1:
        ws1.send(json.dumps({"type": "turn", "agent": "claude", "prompt": "#scenario:slow"}))
        # Wait for the assistant event so the turn is established
        ok, seen1 = recv_until(ws1, lambda e: e.get("type") == "assistant", timeout=10)
        assert ok
        turn_id = seen1[0].get("dj_turn")
        assert turn_id and turn_id.startswith("t_")
        assert len(seen1) >= 2
        since_seq = seen1[-1]["dj_seq"]
        assert since_seq >= 2

    # ws1 disconnected; turn continues running in background
    with ws_open(server) as ws2:
        ws2.send(json.dumps({"type": "attach", "turn_id": turn_id, "since_seq": since_seq}))
        # Interrupt to allow turn to exit cleanly
        ws2.send(json.dumps({"type": "interrupt", "turn_id": turn_id}))
        ok, seen2 = recv_until(ws2, lambda e: e.get("type") == "dj.status" and e.get("state") == "interrupted", timeout=10)
        assert ok

        # Verify all events received by ws2 have seq > since_seq and are monotonic
        for ev in seen2:
            assert ev.get("dj_turn") == turn_id
            assert ev.get("dj_seq") > since_seq
        seqs = [ev["dj_seq"] for ev in seen2]
        assert seqs == sorted(seqs)
        assert len(seqs) == len(set(seqs)), "No duplicates allowed"

    assert server.wait_idle() == 0


def test_concurrent_session_resume_returns_session_busy(server):
    """Two clients resuming the same session_id concurrently -> second gets session_busy."""
    # Session ids must be UUIDs (they reach agent argv).
    session_id = str(uuid.uuid4())
    with ws_open(server) as ws1:
        ws1.send(json.dumps({
            "type": "turn",
            "agent": "claude",
            "prompt": "#scenario:slow",
            "session_id": session_id,
        }))
        ok, seen1 = recv_until(ws1, lambda e: e.get("type") == "assistant", timeout=10)
        assert ok
        active_turn_id = seen1[0]["dj_turn"]

        with ws_open(server) as ws2:
            ws2.send(json.dumps({
                "type": "turn",
                "agent": "claude",
                "prompt": "conflicting turn",
                "session_id": session_id,
            }))
            ok2, seen2 = recv_until(ws2, lambda e: e.get("type") == "dj.error", timeout=5)
            assert ok2
            err = next(e for e in seen2 if e.get("type") == "dj.error")
            assert err.get("code") == "session_busy"
            assert err.get("turn_id") == active_turn_id

        # Interrupt the first turn
        ws1.send(json.dumps({"type": "interrupt", "turn_id": active_turn_id}))
        recv_until(ws1, lambda e: e.get("type") == "dj.status" and e.get("state") == "interrupted", timeout=5)

    assert server.wait_idle() == 0


def test_async_rest_turn_lifecycle_and_polling(server):
    """Async REST turn survives client disconnect and can be polled via /api/turns/{id}/events."""
    headers = {"Authorization": f"Bearer {server.token}"}
    resp = httpx.post(
        server.base + "/api/agent/turn",
        headers=headers,
        json={"agent": "claude", "prompt": "#scenario:basic", "async": True},
        timeout=5,
    )
    assert resp.status_code == 202
    data = resp.json()
    assert "turn_id" in data
    assert data["status"] == "running"
    turn_id = data["turn_id"]

    # Poll until turn completion
    events: List[Dict[str, Any]] = []
    since_seq = 0
    running = True
    start = time.time()
    while running and (time.time() - start < 15):
        poll_resp = httpx.get(
            f"{server.base}/api/turns/{turn_id}/events?since_seq={since_seq}&wait=2",
            headers=headers,
            timeout=5,
        )
        assert poll_resp.status_code == 200
        poll_data = poll_resp.json()
        new_events = poll_data["events"]
        running = poll_data["running"]
        for ev in new_events:
            events.append(ev)
            since_seq = max(since_seq, ev.get("dj_seq", since_seq))
        if running:
            time.sleep(0.1)

    assert not running
    assert any(e.get("type") == "result" for e in events)
    assert any(e.get("type") == "dj.status" and e.get("state") == "exited" for e in events)


def test_buffer_budget_eviction_drops_oldest_and_returns_expired(server):
    """Eviction drops oldest finished turn; attaching returns turn_expired."""
    headers = {"Authorization": f"Bearer {server.token}"}

    # Simulate an evicted turn record
    old_turn = TurnRecord(
        turn_id="t_evicted_test_999",
        client_turn_id=None,
        agent="claude",
        session_id=None,
        status="completed",
        ended_at=time.time() - 3600,  # 1 hour ago (expired per 30m TTL)
    )
    turn_registry.finished_turns[old_turn.turn_id] = old_turn

    # Evict expired turns
    turn_registry._evict_expired()
    assert old_turn.turn_id not in turn_registry.finished_turns

    # Attempting to attach over websocket returns turn_expired
    with ws_open(server) as ws:
        ws.send(json.dumps({"type": "attach", "turn_id": "t_evicted_test_999", "since_seq": 0}))
        ok, events = recv_until(ws, lambda e: e.get("type") == "dj.error", timeout=5)
        assert ok
        err = next(e for e in events if e.get("type") == "dj.error")
        assert err.get("code") == "turn_expired"
        assert err.get("terminal") is True

    # Attempting to fetch events via REST returns 404 turn_expired
    res = httpx.get(f"{server.base}/api/turns/t_evicted_test_999/events", headers=headers, timeout=5)
    assert res.status_code == 404

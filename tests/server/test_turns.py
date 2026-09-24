"""Tests for agent turn execution, limits, process lifecycle, and safety."""

import json
import time

from tests.server.conftest import recv_until, run_turn, types, ws_open


def test_big_line_stream_overrun_fixed(server):
    """Test that a >64 KiB NDJSON line (200 KB) does not crash the reader."""
    with ws_open(server) as ws:
        events = run_turn(ws, {"agent": "claude", "prompt": "#scenario:big-line"}, timeout=10)
        ws.send(json.dumps({"type": "interrupt"}))
    assert any(e.get("type") == "result" for e in events), types(events)
    assert not any(e.get("type") == "dj.error" for e in events), types(events)
    assert server.wait_idle() == 0


def test_leading_dash_prompt_via_stdin(server):
    """Test that a prompt starting with -h is not treated as a CLI flag."""
    r = server.post("/api/agent/turn", {"agent": "claude", "prompt": "-h"})
    assert r.status_code == 200
    events = r.json()["events"]
    assert any(e.get("type") == "result" for e in events), types(events)
    assert not any(e.get("type") == "dj.error" for e in events), types(events)


def test_huge_prompt_via_stdin(server):
    """Test that a 150 KiB prompt streams successfully via stdin."""
    prompt = "A" * (150 * 1024)
    r = server.post("/api/agent/turn", {"agent": "claude", "prompt": prompt})
    assert r.status_code == 200
    events = r.json()["events"]
    assert any(e.get("type") == "result" for e in events), types(events)


def test_missing_cwd_emits_error(server):
    """Test that a non-existent cwd emits missing_cwd error and does not fallback to HOME."""
    missing_dir = "/tmp/darjeeling-missing-cwd-" + str(time.time_ns())
    with ws_open(server) as ws:
        ws.send(json.dumps({
            "type": "turn",
            "agent": "claude",
            "prompt": "hello",
            "cwd": missing_dir,
        }))
        ok, events = recv_until(ws, lambda e: e.get("type") == "dj.status" and e.get("state") == "exited", timeout=5)
        assert ok
        errs = [e for e in events if e.get("type") == "dj.error"]
        assert len(errs) == 1
        assert errs[0].get("code") == "missing_cwd"
        assert errs[0].get("terminal") is True
    assert server.wait_idle() == 0


def test_permission_ceiling_enforced(server):
    """Test that requesting permission mode above ceiling is rejected."""
    # Host default ceiling is acceptEdits. Requesting bypassPermissions must be refused.
    with ws_open(server) as ws:
        ws.send(json.dumps({
            "type": "turn",
            "agent": "claude",
            "prompt": "hello",
            "permission_mode": "bypassPermissions",
        }))
        ok, events = recv_until(ws, lambda e: e.get("type") == "dj.error", timeout=5)
        assert ok
        err = [e for e in events if e.get("type") == "dj.error"][0]
        assert err.get("code") == "permission_ceiling"
        assert err.get("terminal") is True
    assert server.wait_idle() == 0


def test_agy_prompt_cap_enforced(server):
    """Test that AGY rejects prompts > 100 KiB."""
    prompt = "B" * (101 * 1024)
    r = server.post("/api/agent/turn", {"agent": "agy", "prompt": prompt})
    assert r.status_code == 200
    events = r.json()["events"]
    errs = [e for e in events if e.get("type") == "dj.error"]
    assert len(errs) == 1
    assert "exceeds" in errs[0].get("message", "")
    assert errs[0].get("terminal") is True


def test_structured_output_returned_in_result(server):
    """Test that json_schema parameter returns structured output."""
    schema = {
        "type": "object",
        "properties": {"summary": {"type": "string"}},
        "required": ["summary"],
    }
    r = server.post("/api/agent/turn", {
        "agent": "claude",
        "prompt": "summarize",
        "json_schema": schema,
    })
    assert r.status_code == 200
    events = r.json()["events"]
    results = [e for e in events if e.get("type") == "result"]
    assert len(results) == 1
    assert "structured_output" in results[0]

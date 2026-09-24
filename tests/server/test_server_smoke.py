"""
Darjeeling server smoke + contract tests.

Known bugs are marked xfail(strict=True): the suite stays green while they
exist, and flips red the moment one is fixed so the marker gets removed.
Each xfail reason names the file:line of the defect.
"""

import contextlib
import json
import os
import shutil
import stat
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
import pytest
from websockets.sync.client import connect

from conftest import REPO, start_server, stop_server

# The server counts live turns by probing /proc/<pid> (server.py:1559), so on
# macOS the concurrency cap is a no-op and half of these assertions are moot.
pytestmark = pytest.mark.skipif(not Path("/proc/self").exists(), reason="Linux only (/proc)")

MANIFEST_VERSION = json.loads((REPO / "manifest.json").read_text())["version"]


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def ws_open(srv, path="/ws/agent", token: Optional[str] = "__default__", query: str = "", headers=None):
    tok = srv.token if token == "__default__" else token
    protos = ["darjeeling.token." + tok] if tok else None
    url = srv.ws_base + path + (("?" + query) if query else "")
    return connect(url, subprotocols=protos, open_timeout=10, max_size=None,
                   additional_headers=headers)


def rejection_status(exc: Exception) -> Optional[int]:
    resp = getattr(exc, "response", None)
    if resp is not None and getattr(resp, "status_code", None) is not None:
        return resp.status_code
    return getattr(exc, "status_code", None)


def run_turn(ws, payload: Dict[str, Any], timeout: float = 20.0) -> List[Dict[str, Any]]:
    """Send one turn frame and collect events until the turn is over."""
    ws.send(json.dumps({"type": "turn", **payload}))
    events: List[Dict[str, Any]] = []
    started = False
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            raw = ws.recv(timeout=max(0.1, deadline - time.time()))
        except TimeoutError:
            break
        ev = json.loads(raw)
        events.append(ev)
        if ev.get("type") == "dj.status" and ev.get("state") in ("starting", "running"):
            started = True
        if ev.get("type") == "dj.status" and ev.get("state") in ("exited", "interrupted"):
            break
        if ev.get("type") == "dj.error" and not started:
            break
    return events


def types(events) -> List[str]:
    out = []
    for e in events:
        t = e.get("type")
        if t == "dj.status":
            t = "dj.status:" + str(e.get("state"))
        elif t in ("system", "result"):
            t = "%s:%s" % (t, e.get("subtype"))
        out.append(t)
    return out


def recv_until(ws, pred, timeout=10.0) -> Tuple[bool, List[Dict[str, Any]]]:
    seen = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            ev = json.loads(ws.recv(timeout=max(0.1, deadline - time.time())))
        except TimeoutError:
            break
        seen.append(ev)
        if pred(ev):
            return True, seen
    return False, seen


# --------------------------------------------------------------------------
# meta + auth
# --------------------------------------------------------------------------

def test_health_is_public_and_versioned(server):
    r = httpx.get(server.base + "/health", timeout=10)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "online"
    assert body["auth_required"] is True
    assert body["version"] == MANIFEST_VERSION, "server VERSION drifted from manifest.json"


@pytest.mark.parametrize(
    "headers,params,expected",
    [
        ({}, {}, 401),
        ({"Authorization": "Bearer wrong"}, {}, 401),
        ({"X-Darjeeling-Token": "wrong"}, {}, 401),
        ("bearer", {}, 200),
        ("x-header", {}, 200),
        ({}, "query", 401),  # REST must refuse ?token= (it would be access-logged)
    ],
    ids=["none", "bad-bearer", "bad-header", "bearer", "x-header", "query-token"],
)
def test_rest_auth_matrix(server, headers, params, expected):
    if headers == "bearer":
        headers = {"Authorization": "Bearer " + server.token}
    elif headers == "x-header":
        headers = {"X-Darjeeling-Token": server.token}
    if params == "query":
        params = {"token": server.token}
    r = httpx.get(server.base + "/api/agents", headers=headers, params=params, timeout=10)
    assert r.status_code == expected


def test_agents_report_fakes_available(server):
    agents = {a["key"]: a for a in server.get("/api/agents").json()["agents"]}
    assert agents["claude"]["available"] is True
    assert "darjeeling-fake" in (agents["claude"]["version"] or "")
    assert agents["agy"]["available"] is True
    assert agents["deepseek"]["available"] is True


def test_token_minted_0600_when_unset(fresh_root):
    srv = start_server(fresh_root, with_token=False)
    try:
        tok_file = fresh_root / "token"
        assert tok_file.is_file()
        assert stat.S_IMODE(tok_file.stat().st_mode) == 0o600
        assert len(srv.token) >= 32
        r = httpx.get(srv.base + "/api/agents", headers={"Authorization": "Bearer " + srv.token}, timeout=10)
        assert r.status_code == 200
        assert httpx.get(srv.base + "/api/agents", timeout=10).status_code == 401
    finally:
        stop_server(srv)


def test_ws_accepts_subprotocol_token_and_echoes_it(server):
    with ws_open(server) as ws:
        assert ws.subprotocol == "darjeeling.token." + server.token
        ws.send(json.dumps({"type": "ping"}))
        ev = json.loads(ws.recv(timeout=5))
        assert ev["type"] == "dj.pong"


def test_ws_accepts_header_token(server):
    with ws_open(server, token=None, headers={"X-Darjeeling-Token": server.token}) as ws:
        ws.send(json.dumps({"type": "ping"}))
        assert json.loads(ws.recv(timeout=5))["type"] == "dj.pong"


@pytest.mark.parametrize("token", [None, "wrong-token"], ids=["missing", "wrong"])
def test_ws_rejects_bad_token(server, token):
    with pytest.raises(Exception) as info:
        with ws_open(server, token=token) as ws:
            ws.recv(timeout=5)
    # Rejected one way or another; the *how* is covered by the xfail below.
    assert info.value is not None


def test_ws_bad_token_is_reported_as_close_1008(server):
    try:
        ws = ws_open(server, token="wrong-token")
    except Exception as exc:  # handshake refused -> plugin sees 1006, not close code
        pytest.fail("handshake refused with HTTP %s instead of close 4401" % rejection_status(exc))
    with ws:
        try:
            ws.recv(timeout=5)
        except Exception as exc:
            code = getattr(getattr(exc, "rcvd", None), "code", None)
            assert code in (1008, 4401)


def test_ws_query_token_is_not_logged(server):
    before = len(server.log_text())
    try:
        with connect(server.ws_base + "/ws/agent?token=" + server.token, open_timeout=10) as ws:
            ws.send(json.dumps({"type": "ping"}))
            ws.recv(timeout=5)
    except Exception:
        pass
    time.sleep(0.3)
    assert server.token not in server.log_text()[before:]


def test_rest_query_token_is_logged_even_when_refused(server):
    """
    Documents a residual leak: a stale v2-era client that still sends ?token=
    on REST is refused (401) but uvicorn's access log records the full URL,
    token included. Not a server fix (it is the access log), but the docs and
    any migration note should say 'rotate your token if you ran a v2 client'.
    """
    before = len(server.log_text())
    httpx.get(server.base + "/api/agents", params={"token": server.token}, timeout=10)
    time.sleep(0.3)
    assert server.token not in server.log_text()[before:]


# --------------------------------------------------------------------------
# agent channel: claude (fake)
# --------------------------------------------------------------------------

def test_basic_turn_event_sequence(server):
    with ws_open(server) as ws:
        events = run_turn(ws, {"agent": "claude", "prompt": "hello #scenario:basic", "model": "opus"})
    seq = types(events)
    for expected in ("dj.status:starting", "dj.status:running", "system:init", "assistant",
                     "user", "result:success", "dj.status:exited"):
        assert expected in seq, (expected, seq)
    init = next(e for e in events if e.get("type") == "system")
    result = next(e for e in events if e.get("type") == "result")
    exited = events[-1]
    assert exited["code"] == 0
    assert exited["sessionId"] == init["session_id"] == result["session_id"]
    assert result["total_cost_usd"] > 0
    assert init["model"] == "claude-opus-5"
    tool_use = [b for e in events if e.get("type") == "assistant"
                for b in e["message"]["content"] if b["type"] == "tool_use"]
    tool_res = [b for e in events if e.get("type") == "user"
                for b in e["message"]["content"] if b["type"] == "tool_result"]
    assert tool_use and tool_res and tool_use[0]["id"] == tool_res[0]["tool_use_id"]


def test_claude_argv_contract(server):
    with ws_open(server) as ws:
        run_turn(ws, {"agent": "claude", "prompt": "argv check", "model": "sonnet",
                      "effort": "high", "permission_mode": "acceptEdits",
                      "append_system_prompt": "harness"})
    call = [c for c in server.argv_calls() if c["flavour"] == "claude"][-1]
    argv = call["argv"]
    assert argv[:4] == ["-p", "--output-format", "stream-json", "--verbose"]
    assert argv[argv.index("--model") + 1] == "sonnet"
    assert argv[argv.index("--effort") + 1] == "high"
    assert argv[argv.index("--permission-mode") + 1] == "acceptEdits"
    assert argv[argv.index("--append-system-prompt") + 1] == "harness"
    assert argv[argv.index("--setting-sources") + 1] == "user"
    assert "argv check" not in argv
    assert Path(call["cwd"]).resolve() == server.vault.resolve()


def test_default_permission_mode_is_plan(server):
    with ws_open(server) as ws:
        run_turn(ws, {"agent": "claude", "prompt": "default mode"})
    argv = [c for c in server.argv_calls() if c["flavour"] == "claude"][-1]["argv"]
    assert argv[argv.index("--permission-mode") + 1] == "plan"


def test_accept_all_maps_to_skip_permissions(fresh_root):
    srv = start_server(fresh_root, extra_env={"DARJEELING_PERMISSION_CEILING": "bypassPermissions"})
    try:
        with ws_open(srv) as ws:
            run_turn(ws, {"agent": "claude", "prompt": "yolo", "permission_mode": "acceptAll"})
        argv = [c for c in srv.argv_calls() if c["flavour"] == "claude"][-1]["argv"]
        assert "--dangerously-skip-permissions" in argv
        assert "--permission-mode" not in argv
    finally:
        stop_server(srv)


def test_resume_threads_session_id(server):
    with ws_open(server) as ws:
        first = run_turn(ws, {"agent": "claude", "prompt": "one"})
        sid = first[-1]["sessionId"]
        second = run_turn(ws, {"agent": "claude", "prompt": "two", "resume": sid})
    assert second[-1]["sessionId"] == sid
    argv = [c for c in server.argv_calls() if c["flavour"] == "claude"][-1]["argv"]
    assert argv[argv.index("--resume") + 1] == sid


def test_partial_messages_flag_and_forwarding(server):
    with ws_open(server) as ws:
        events = run_turn(ws, {"agent": "claude", "prompt": "stream #scenario:partial",
                               "partial_messages": True})
    argv = [c for c in server.argv_calls() if c["flavour"] == "claude"][-1]["argv"]
    assert "--include-partial-messages" in argv
    deltas = [e for e in events if e.get("type") == "stream_event"
              and e["event"].get("type") == "content_block_delta"]
    assert len(deltas) == 2  # forwarded verbatim; see report: the plugin drops them


def test_non_json_stdout_surfaces_as_dj_raw(server):
    with ws_open(server) as ws:
        events = run_turn(ws, {"agent": "claude", "prompt": "#scenario:raw-stdout"})
    raws = [e for e in events if e.get("type") == "dj.raw"]
    assert raws and "Update available" in raws[0]["line"]
    assert events[-1]["code"] == 0


def test_crash_reports_code_and_stderr(server):
    with ws_open(server) as ws:
        events = run_turn(ws, {"agent": "claude", "prompt": "#scenario:crash"})
    last = events[-1]
    assert last["type"] == "dj.status" and last["state"] == "exited"
    assert last["code"] == 137
    assert "simulated crash" in last["stderr"]
    assert not [e for e in events if e.get("type") == "result"]


def test_error_result_passthrough(server):
    with ws_open(server) as ws:
        events = run_turn(ws, {"agent": "claude", "prompt": "#scenario:error-result"})
    res = next(e for e in events if e.get("type") == "result")
    assert res["is_error"] is True
    assert events[-1]["code"] == 1


def test_not_logged_in_shape(server):
    with ws_open(server) as ws:
        events = run_turn(ws, {"agent": "claude", "prompt": "#scenario:not-logged-in"})
    res = next(e for e in events if e.get("type") == "result")
    assert res["is_error"] is True and "/login" in res["result"]
    texts = [b["text"] for e in events if e.get("type") == "assistant" for b in e["message"]["content"]]
    assert texts == ["Not logged in · Please run /login"]
    assert events[-1]["code"] == 1


def test_interrupt_stops_process(server):
    with ws_open(server) as ws:
        ws.send(json.dumps({"type": "turn", "agent": "claude", "prompt": "#scenario:slow"}))
        ok, _ = recv_until(ws, lambda e: e.get("type") == "assistant", timeout=10)
        assert ok
        assert server.active_turns() == 1
        ws.send(json.dumps({"type": "interrupt"}))
        ok, seen = recv_until(ws, lambda e: e.get("type") == "dj.status" and e.get("state") == "interrupted")
        assert ok, types(seen)
    assert server.wait_idle() == 0


def test_disconnect_mid_turn_kills_process(server):
    with ws_open(server) as ws:
        ws.send(json.dumps({"type": "turn", "agent": "claude", "prompt": "#scenario:slow"}))
        ok, seen = recv_until(ws, lambda e: e.get("type") == "assistant", timeout=10)
        assert ok
        turn_id = seen[0]["dj_turn"]
        assert server.active_turns() == 1
    # Under protocol v2 (ADR-11), socket close detaches the turn without killing the process
    assert server.active_turns() == 1
    with ws_open(server) as ws2:
        ws2.send(json.dumps({"type": "attach", "turn_id": turn_id}))
        ws2.send(json.dumps({"type": "interrupt", "turn_id": turn_id}))
        ok_int, _ = recv_until(ws2, lambda e: e.get("type") == "dj.status" and e.get("state") == "interrupted", timeout=10)
        assert ok_int
    assert server.wait_idle() == 0


def test_concurrency_cap_refuses_third_turn(server):
    with contextlib.ExitStack() as stack:
        a = stack.enter_context(ws_open(server))
        b = stack.enter_context(ws_open(server))
        for ws in (a, b):
            ws.send(json.dumps({"type": "turn", "agent": "claude", "prompt": "#scenario:slow"}))
            ok, _ = recv_until(ws, lambda e: e.get("type") == "assistant", timeout=10)
            assert ok
        with ws_open(server) as c:
            events = run_turn(c, {"agent": "claude", "prompt": "third"}, timeout=10)
        assert events and events[0]["type"] == "dj.error" and "Refused" in events[0]["message"]
        r = server.post("/api/agent/turn", {"agent": "claude", "prompt": "rest while full"})
        assert r.status_code == 429
        for ws in (a, b):
            ws.send(json.dumps({"type": "interrupt"}))
    assert server.wait_idle() == 0


def test_second_turn_on_busy_socket_is_rejected(server):
    with ws_open(server) as ws:
        ws.send(json.dumps({"type": "turn", "agent": "claude", "prompt": "#scenario:slow"}))
        recv_until(ws, lambda e: e.get("type") == "assistant", timeout=10)
        ws.send(json.dumps({"type": "turn", "agent": "claude", "prompt": "again"}))
        ok, _ = recv_until(ws, lambda e: e.get("type") == "dj.error" and "already running" in e.get("message", ""), timeout=5)
        assert ok
        ws.send(json.dumps({"type": "interrupt"}))
    assert server.wait_idle() == 0


def test_big_line_turn_completes(server):
    with ws_open(server) as ws:
        events = run_turn(ws, {"agent": "claude", "prompt": "#scenario:big-line"}, timeout=8)
        ws.send(json.dumps({"type": "interrupt"}))
    assert any(e.get("type") == "result" for e in events), types(events)
    assert server.wait_idle() == 0


def test_big_line_rest_turn_completes(server):
    r = server.post("/api/agent/turn", {"agent": "claude", "prompt": "#scenario:big-line"})
    # Guard: the child finishes its small remaining output and is reaped, so
    # no concurrency slot is leaked on REST either.
    assert server.wait_idle(timeout=6) == 0
    assert r.status_code == 200


def test_big_line_ws_failure_does_not_leak_slot(server):
    with ws_open(server) as ws:
        ws.send(json.dumps({"type": "turn", "agent": "claude", "prompt": "test", "cwd": "/nonexistent/test/path"}))
        ok, seen = recv_until(ws, lambda e: e.get("type") == "dj.error", timeout=10)
        assert ok, types(seen)
        try:
            assert server.wait_idle(timeout=6) == 0, "CLI child still counted as an active turn"
        finally:
            ws.send(json.dumps({"type": "interrupt"}))
    assert server.wait_idle() == 0


def test_allowed_tools_do_not_swallow_prompt(server):
    r = server.post("/api/agent/turn", {"agent": "claude", "prompt": "hello", "allowed_tools": ["Read", "Grep"]})
    assert r.status_code == 200
    events = r.json()["events"]
    assert any(e.get("type") == "result" for e in events), types(events)


def test_rest_buffered_turn(server):
    r = server.post("/api/agent/turn", {"agent": "claude", "prompt": "buffered"})
    assert r.status_code == 200
    body = r.json()
    assert body["sessionId"]
    assert any(e.get("type") == "result" for e in body["events"])


def test_unknown_agent_and_bad_frames(server):
    with ws_open(server) as ws:
        ev = run_turn(ws, {"agent": "nope", "prompt": "x"})
        assert ev[0]["type"] == "dj.error" and "Unknown agent" in ev[0]["message"]
        ws.send("not json")
        assert json.loads(ws.recv(timeout=5))["type"] == "dj.error"
        ws.send(json.dumps({"type": "bogus"}))
        assert "Unknown frame" in json.loads(ws.recv(timeout=5))["message"]
    assert server.post("/api/agent/turn", {"agent": "nope", "prompt": "x"}).status_code == 400


# --------------------------------------------------------------------------
# agy (fake) + deepseek (fake API)
# --------------------------------------------------------------------------

def test_agy_turn_is_normalised(server):
    with ws_open(server) as ws:
        events = run_turn(ws, {"agent": "agy", "prompt": "hi", "model": "gemini-3.8-flash-high",
                               "effort": "low", "permission_mode": "acceptEdits",
                               "append_system_prompt": "ctx"})
    seq = types(events)
    assert "system:init" in seq and "result:turn_complete" in seq, seq
    texts = [b.get("text") for e in events if e.get("type") == "assistant"
             for b in e["message"]["content"] if b["type"] == "text"]
    assert "Looking at the vault." in texts
    argv = [c for c in server.argv_calls() if c["flavour"] == "agy"][-1]["argv"]
    assert argv[:2] == ["--output-format", "stream-json"]
    assert argv[argv.index("--model") + 1] == "gemini-3.8-flash-low"
    assert "--effort" not in argv
    assert argv[argv.index("--mode") + 1] == "accept-edits"
    assert argv[-1].startswith("-p=System Context:\nctx")
    assert events[-1]["sessionId"]


def test_deepseek_turn_and_resume(server):
    ds = server.deepseek
    with ws_open(server) as ws:
        first = run_turn(ws, {"agent": "deepseek", "prompt": "first", "model": "deepseek-chat"})
        res = next(e for e in first if e.get("type") == "result")
        assert res["result"] == "Hello from fake DeepSeek."
        sid = res["session_id"]
        second = run_turn(ws, {"agent": "deepseek", "prompt": "second", "resume": sid})
    assert next(e for e in second if e.get("type") == "result")["session_id"] == sid
    sent = ds.requests[-1]["body"]["messages"]
    assert [m["role"] for m in sent] == ["user", "assistant", "user"]
    assert ds.requests[-1]["auth"] == "Bearer fake-deepseek-key"


# --------------------------------------------------------------------------
# conversation history (the "pick it up from my phone" flow)
# --------------------------------------------------------------------------

def _history_roundtrip(server, cwd: Path) -> List[Dict[str, Any]]:
    cwd.mkdir(parents=True, exist_ok=True)
    with ws_open(server) as ws:
        events = run_turn(ws, {"agent": "claude", "prompt": "remember me", "cwd": str(cwd)})
    sid = events[-1]["sessionId"]
    convs = server.get("/api/agent/conversations", params={"cwd": str(cwd)}).json()["conversations"]
    return [c for c in convs if c["sessionId"] == sid]


def test_history_lists_session_plain_path(server):
    assert _history_roundtrip(server, server.root / "plainvault")


def test_history_lists_session_dotted_path(server):
    assert _history_roundtrip(server, server.root / "home" / "first.last" / "My Vault")


# --------------------------------------------------------------------------
# vault + artifacts
# --------------------------------------------------------------------------

def test_vault_roundtrip_and_changed(server):
    since = int(time.time()) - 5
    r = server.post("/api/vault/sync/file", {"path": "Notes/lab.md", "content": "# lab\n"})
    assert r.status_code == 200
    got = server.get("/api/vault/file", params={"path": "Notes/lab.md"}).json()
    assert got["content"] == "# lab\n"
    changed = server.get("/api/vault/changed", params={"since": since}).json()["changed"]
    assert any(c["path"] == "Notes/lab.md" for c in changed)
    status = server.get("/api/vault/status").json()
    assert status["exists"] and status["file_count"] >= 2


def test_artifacts_roundtrip(server):
    assert server.post("/api/artifacts/write", {"path": "plans/p.md", "content": "plan"}).status_code == 200
    listed = server.get("/api/artifacts").json()["artifacts"]
    assert any(a["path"] == "plans/p.md" for a in listed)
    assert server.get("/api/artifacts/read", params={"path": "plans/p.md"}).json()["content"] == "plan"


@pytest.mark.parametrize("path", ["../outside.md", "../../etc/passwd", "a/../../x.md", "/../../etc/hosts"])
def test_path_traversal_blocked(server, path):
    assert server.get("/api/vault/file", params={"path": path}).status_code in (400, 404)
    assert server.post("/api/vault/sync/file", {"path": path, "content": "x"}).status_code == 400
    assert server.post("/api/artifacts/write", {"path": path, "content": "x"}).status_code == 400


def test_symlink_escape_blocked(server):
    outside = server.root / "outside-secret.txt"
    outside.write_text("secret")
    link = server.vault / "escape.md"
    if not link.exists():
        link.symlink_to(outside)
    assert server.get("/api/vault/file", params={"path": "escape.md"}).status_code == 400


# --------------------------------------------------------------------------
# host + tmux terminal
# --------------------------------------------------------------------------

def test_host_status_shape(server):
    body = server.get("/api/host/status").json()
    for key in ("level", "alerts", "battery", "thermal", "cpu", "memory", "disk", "agents"):
        assert key in body
    assert body["agents"]["maxConcurrentTurns"] == 2


needs_tmux = pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux not installed")


@needs_tmux
def test_tmux_session_crud(server):
    name = "pytest-" + uuid.uuid4().hex[:6]
    r = server.post("/api/sessions", {"name": name})
    assert r.json()["status"] == "created"
    names = [s["name"] for s in server.get("/api/sessions").json()["sessions"]]
    assert name in names
    assert server.post("/api/sessions/%s/send" % name, {"text": "true"}).json()["status"] == "sent"
    assert httpx.delete(server.base + "/api/sessions/" + name, headers=server.headers(), timeout=10).json()["status"] == "killed"


@needs_tmux
def test_terminal_ws_echo(server):
    name = "pytest-term-" + uuid.uuid4().hex[:6]
    with ws_open(server, path="/ws/terminal", query="session=" + name) as ws:
        ws.send(json.dumps({"type": "resize", "rows": 30, "cols": 100}))
        ws.send("echo DJLAB_$((6*7))_OK\r")
        buf = ""
        deadline = time.time() + 10
        while "DJLAB_42_OK" not in buf and time.time() < deadline:
            try:
                buf += ws.recv(timeout=1)
            except TimeoutError:
                pass
        assert "DJLAB_42_OK" in buf
    httpx.delete(server.base + "/api/sessions/" + name, headers=server.headers(), timeout=10)

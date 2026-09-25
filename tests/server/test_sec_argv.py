"""Regression tests: agent argv flag injection and permission-mode allow-list (1.0.4)."""

import json
import uuid

import pytest
from pydantic import ValidationError

from darjeeling_server.agents import AGENTS
from darjeeling_server.agents.base import ArgvError, is_uuid
from darjeeling_server.config import permission_rank
from darjeeling_server.turns import PermissionError_, TurnRequest, resolve_turn_permission

CLAUDE = AGENTS["claude"]
AGY = AGENTS["agy"]
DEEPSEEK = AGENTS["deepseek"]

SID = str(uuid.uuid4())


def req(**kw):
    kw.setdefault("prompt", "hello")
    return TurnRequest(**kw)


# --------------------------------------------------------------------------
# Leading-dash values are refused
# --------------------------------------------------------------------------

@pytest.mark.parametrize(
    "field,value",
    [
        ("model", "--dangerously-skip-permissions"),
        ("fallback_model", "--permission-mode=bypassPermissions"),
        ("effort", "-p"),
        ("allowed_tools", ["Read", "--dangerously-skip-permissions"]),
        ("disallowed_tools", ["-x"]),
        ("add_dirs", ["--add-dir=/"]),
        ("add_dirs", ["/tmp", "-r"]),
    ],
)
def test_claude_rejects_dash_values(field, value):
    with pytest.raises(ArgvError):
        CLAUDE.build_argv(req(**{field: value}))


def test_claude_rejects_control_chars():
    with pytest.raises(ArgvError):
        CLAUDE.build_argv(req(model="opus\n--verbose"))


@pytest.mark.parametrize("field", ["resume", "session_id"])
@pytest.mark.parametrize("value", ["--dangerously-skip-permissions", "-r", "not-a-uuid", "sess_123", "../x"])
def test_session_ids_must_be_uuids(field, value):
    with pytest.raises(ValidationError):
        req(**{field: value})


@pytest.mark.parametrize("field", ["resume", "session_id"])
def test_build_argv_rechecks_session_ids(field):
    # Defence in depth: a request built without validation is still refused.
    r = TurnRequest.model_construct(prompt="x", **{field: "--dangerously-skip-permissions"})
    with pytest.raises(ArgvError):
        CLAUDE.build_argv(r)


def test_uuid_forms_accepted():
    assert is_uuid(SID)
    assert is_uuid(uuid.uuid4().hex)  # DeepSeek session ids
    assert not is_uuid("{" + SID + "}")
    assert not is_uuid("urn:uuid:" + SID)
    assert req(resume=SID).resume == SID
    assert req(resume="").resume is None


def test_claude_valid_argv_shape():
    argv = CLAUDE.build_argv(
        req(
            model="sonnet",
            resume=SID,
            permission_mode="acceptEdits",
            allowed_tools=["Read", "Bash(git diff:*)"],
            add_dirs=["/tmp"],
        )
    )
    assert argv[argv.index("--model") + 1] == "sonnet"
    assert argv[argv.index("--resume") + 1] == SID
    assert argv[argv.index("--permission-mode") + 1] == "acceptEdits"
    assert "Bash(git diff:*)" in argv
    assert "hello" not in argv  # prompt goes via stdin


def test_claude_system_prompt_leading_dash_cannot_become_flag():
    argv = CLAUDE.build_argv(req(append_system_prompt="--dangerously-skip-permissions"))
    val = argv[argv.index("--append-system-prompt") + 1]
    assert not val.startswith("-")
    assert val.strip() == "--dangerously-skip-permissions"
    assert "--dangerously-skip-permissions" not in argv


def test_agy_rejects_dash_values():
    with pytest.raises(ArgvError):
        AGY.build_argv(req(model="--dangerously-skip-permissions"))
    with pytest.raises(ArgvError):
        AGY.build_argv(req(effort="--x"))
    r = TurnRequest.model_construct(prompt="x", resume="--dangerously-skip-permissions")
    with pytest.raises(ArgvError):
        AGY.build_argv(r)


def test_agy_prompt_stays_attached():
    argv = AGY.build_argv(req(prompt="--dangerously-skip-permissions"))
    assert argv[-1] == "-p=--dangerously-skip-permissions"
    assert "--dangerously-skip-permissions" not in argv[:-1]


# --------------------------------------------------------------------------
# Permission modes: allow-list, fail closed, always explicit
# --------------------------------------------------------------------------

def test_accept_all_is_not_advertised():
    ids = [m["id"] for m in CLAUDE.permission_modes]
    assert "acceptAll" not in ids
    assert ids[0] == "plan"
    assert set(ids) <= {"plan", "acceptEdits", "dontAsk", "bypassPermissions", "auto", "manual"}


@pytest.mark.parametrize("spec", [CLAUDE, AGY, DEEPSEEK])
@pytest.mark.parametrize("mode", ["acceptAll", "yolo", "", "PLAN", "default"])
def test_unknown_modes_rejected(spec, mode):
    r = req(permission_mode=mode)
    with pytest.raises(PermissionError_) as exc:
        resolve_turn_permission(spec, r)
    assert exc.value.code == "invalid_permission_mode"
    if not spec.is_api:
        with pytest.raises(ValueError):
            spec.build_argv(req(permission_mode=mode))


@pytest.mark.parametrize("spec", [CLAUDE, AGY, DEEPSEEK])
def test_explicit_null_mode_rejected(spec):
    r = TurnRequest(prompt="x", permission_mode=None)
    with pytest.raises(PermissionError_) as exc:
        resolve_turn_permission(spec, r)
    assert exc.value.code == "invalid_permission_mode"


def test_absent_mode_uses_most_restrictive_explicitly():
    r = req()
    assert resolve_turn_permission(CLAUDE, r) == "plan"
    argv = CLAUDE.build_argv(req())
    assert argv[argv.index("--permission-mode") + 1] == "plan"
    argv = AGY.build_argv(req())
    assert argv[argv.index("--mode") + 1] == "plan"
    assert resolve_turn_permission(DEEPSEEK, req()) == "n/a"


def test_agy_aliases():
    argv = AGY.build_argv(req(permission_mode="acceptEdits"))
    assert argv[argv.index("--mode") + 1] == "accept-edits"
    argv = AGY.build_argv(req(permission_mode="bypassPermissions"))
    assert "--dangerously-skip-permissions" in argv


def test_claude_bypass_uses_real_mode_flag():
    argv = CLAUDE.build_argv(req(permission_mode="bypassPermissions"))
    assert argv[argv.index("--permission-mode") + 1] == "bypassPermissions"
    assert "--dangerously-skip-permissions" not in argv


def test_ceiling_enforced_on_canonical_mode(monkeypatch):
    import darjeeling_server.turns as turns

    monkeypatch.setattr(turns, "PERMISSION_CEILING", "acceptEdits")
    with pytest.raises(PermissionError_) as exc:
        resolve_turn_permission(CLAUDE, req(permission_mode="bypassPermissions"))
    assert exc.value.code == "permission_ceiling"
    with pytest.raises(PermissionError_):
        resolve_turn_permission(AGY, req(permission_mode="bypassPermissions"))
    # DeepSeek has no tools: every real mode collapses to n/a.
    assert resolve_turn_permission(DEEPSEEK, req(permission_mode="bypassPermissions")) == "n/a"


def test_permission_rank_fails_closed():
    assert permission_rank("plan") == 0
    assert permission_rank("somethingNew") > permission_rank("bypassPermissions")
    assert permission_rank(None) >= permission_rank("bypassPermissions")


# --------------------------------------------------------------------------
# End to end against the fake CLI
# --------------------------------------------------------------------------

def _recv_error(ws, timeout=5.0):
    from tests.server.conftest import recv_until

    ok, events = recv_until(ws, lambda e: e.get("type") == "dj.error", timeout=timeout)
    assert ok, events
    return next(e for e in events if e.get("type") == "dj.error")


def test_ws_flag_injection_never_spawns(server):
    from tests.server.conftest import ws_open

    before = len(server.argv_calls())
    with ws_open(server) as ws:
        ws.send(json.dumps({"type": "turn", "agent": "claude", "prompt": "x",
                            "model": "--dangerously-skip-permissions"}))
        err = _recv_error(ws)
        assert "must not start with '-'" in err["message"]
    with ws_open(server) as ws:
        ws.send(json.dumps({"type": "turn", "agent": "claude", "prompt": "x",
                            "resume": "--dangerously-skip-permissions"}))
        err = _recv_error(ws)
        assert err.get("code") == "bad_request"
    assert len(server.argv_calls()) == before
    assert server.wait_idle() == 0


def test_ws_unknown_mode_rejected(server):
    from tests.server.conftest import ws_open

    with ws_open(server) as ws:
        ws.send(json.dumps({"type": "turn", "agent": "claude", "prompt": "x", "permission_mode": "acceptAll"}))
        assert _recv_error(ws).get("code") == "invalid_permission_mode"
    with ws_open(server) as ws:
        ws.send(json.dumps({"type": "turn", "agent": "claude", "prompt": "x", "permission_mode": None}))
        assert _recv_error(ws).get("code") == "invalid_permission_mode"


def test_rest_unknown_mode_and_bad_session(server):
    r = server.post("/api/agent/turn", {"agent": "claude", "prompt": "x", "permission_mode": "acceptAll"})
    assert r.status_code == 400
    r = server.post("/api/agent/turn", {"agent": "claude", "prompt": "x", "session_id": "-r"})
    assert r.status_code == 422


# --------------------------------------------------------------------------
# agy resume ids: not documented as UUIDs, so a conservative token is allowed
# --------------------------------------------------------------------------

@pytest.mark.parametrize("value", [SID, uuid.uuid4().hex, "conv_123", "cascade:abc.def-9", "A" * 128])
def test_agy_resume_accepts_safe_ids(value):
    r = req(agent="agy", resume=value)
    assert r.resume == value
    argv = AGY.build_argv(r)
    assert argv[argv.index("--conversation") + 1] == value


@pytest.mark.parametrize(
    "value",
    ["--dangerously-skip-permissions", "-r", "_x", ".hidden", "../x", "a/b", "a b", "a\nb", "A" * 129, "é1"],
)
def test_agy_resume_refuses_unsafe_ids(value):
    with pytest.raises(ValidationError):
        req(agent="agy", resume=value)
    r = TurnRequest.model_construct(prompt="x", agent="agy", resume=value)
    with pytest.raises(ArgvError):
        AGY.build_argv(r)


def test_non_agy_agents_still_require_uuid_resume():
    with pytest.raises(ValidationError):
        req(agent="claude", resume="conv_123")
    r = TurnRequest.model_construct(prompt="x", resume="conv_123")
    with pytest.raises(ArgvError):
        CLAUDE.build_argv(r)

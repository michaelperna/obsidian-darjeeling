"""Regression tests: concurrency slots, child env, stderr drain, terminal buffer, auth (1.0.4)."""

import asyncio
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List
from unittest.mock import patch

import pytest

import darjeeling_server.host as host
import darjeeling_server.terminal as terminal
from darjeeling_server.agents.base import AgentSpec
from darjeeling_server.turns import (
    AgentTurn,
    AtCapacityError,
    TurnRegistry,
    TurnRequest,
    drain_lines,
)


@pytest.fixture(autouse=True)
def _clean_slots(monkeypatch):
    monkeypatch.setattr(host, "MAX_CONCURRENT_TURNS", 2)
    saved = dict(host._active_turns)
    host._active_turns.clear()
    yield
    host._active_turns.clear()
    host._active_turns.update(saved)


class SlowApiSpec(AgentSpec):
    """An is_api agent (like DeepSeek) that blocks until released."""

    is_api = True

    def __init__(self):
        super().__init__("slowapi", "Slow API", "", [], [], [{"id": "n/a", "label": "n/a"}])
        self.release = asyncio.Event()
        self.started = 0

    @property
    def available(self) -> bool:
        return True

    async def run_api(self, req, emit):
        self.started += 1
        await self.release.wait()
        await emit({"type": "result", "subtype": "success", "is_error": False, "result": "ok"})


class PyCliSpec(AgentSpec):
    """A CLI agent whose 'binary' is this Python interpreter running a script."""

    def __init__(self, script: str):
        super().__init__("pycli", "Py CLI", sys.executable, [], [], [{"id": "plan", "label": "plan"}])
        self.script = script

    def build_argv(self, req):
        return [sys.executable, "-c", self.script]


# --------------------------------------------------------------------------
# 4. Concurrency: slot reserved atomically before spawn; API turns count
# --------------------------------------------------------------------------

def test_reserve_slot_is_atomic_and_bounded():
    assert host.try_reserve_turn_slot("a", {"agent": "x"})
    assert host.try_reserve_turn_slot("b", {"agent": "x"})
    assert not host.try_reserve_turn_slot("c", {"agent": "x"})
    assert host.agent_load()["activeTurns"] == 2
    host.release_turn_slot("a")
    assert host.try_reserve_turn_slot("c", {"agent": "x"})


def test_burst_of_turns_cannot_exceed_cap(tmp_path):
    async def main():
        reg = TurnRegistry()
        spec = SlowApiSpec()
        records, refused = [], 0
        # No awaits between these calls: the old check-then-spawn let all of
        # them through because nothing was registered until after spawn.
        for _ in range(5):
            try:
                records.append(reg.create_turn(spec, TurnRequest(prompt="x", cwd=str(tmp_path))))
            except AtCapacityError:
                refused += 1
        assert len(records) == 2 and refused == 3
        assert host.agent_load()["activeTurns"] == 2
        await asyncio.sleep(0.05)
        assert spec.started == 2
        spec.release.set()
        await asyncio.gather(*(r.task for r in records))
        await asyncio.sleep(0)
        assert host.agent_load()["activeTurns"] == 0
        # Slots are free again.
        spec.release = asyncio.Event()
        r = reg.create_turn(spec, TurnRequest(prompt="x", cwd=str(tmp_path)))
        spec.release.set()
        await r.task

    asyncio.run(main())


def test_slot_released_when_task_cancelled_before_start(tmp_path):
    async def main():
        reg = TurnRegistry()
        spec = SlowApiSpec()
        rec = reg.create_turn(spec, TurnRequest(prompt="x", cwd=str(tmp_path)))
        rec.task.cancel()  # before the task body ever runs
        with pytest.raises(asyncio.CancelledError):
            await rec.task
        await asyncio.sleep(0)
        assert host.agent_load()["activeTurns"] == 0

    asyncio.run(main())


def test_failed_turn_releases_slot(tmp_path):
    async def main():
        reg = TurnRegistry()
        spec = SlowApiSpec()
        rec = reg.create_turn(spec, TurnRequest(prompt="x", cwd=str(tmp_path / "missing")))
        await rec.task
        assert host.agent_load()["activeTurns"] == 0

    asyncio.run(main())


# --------------------------------------------------------------------------
# 6. child_env: DARJEELING_* and DEEPSEEK_API_KEY never reach children
# --------------------------------------------------------------------------

ENV_DUMP = (
    "import json, os, sys; "
    "print(json.dumps({'type': 'envdump', 'env': dict(os.environ)})); sys.stdout.flush()"
)


def _run_turn(spec, req) -> List[Dict[str, Any]]:
    events: List[Dict[str, Any]] = []

    async def emit(ev):
        events.append(ev)

    asyncio.run(AgentTurn(spec, req).run(emit))
    return events


def test_cli_child_env_is_scrubbed(tmp_path, monkeypatch):
    monkeypatch.setenv("DARJEELING_TOKEN", "sekrit-token")
    monkeypatch.setenv("DARJEELING_SOMETHING", "x")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-deepseek")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-keep")
    events = _run_turn(PyCliSpec(ENV_DUMP), TurnRequest(prompt="x", cwd=str(tmp_path)))
    dump = next(e for e in events if e.get("type") == "envdump")["env"]
    assert not [k for k in dump if k.startswith("DARJEELING_")]
    assert "DEEPSEEK_API_KEY" not in dump
    assert dump.get("ANTHROPIC_API_KEY") == "sk-ant-keep"
    assert dump.get("CLAUDE_CODE_NON_INTERACTIVE") == "1"


def test_tmux_env_is_scrubbed(monkeypatch):
    monkeypatch.setenv("DARJEELING_TOKEN", "sekrit-token")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-deepseek")
    seen = {}

    def fake_run(cmd, **kw):
        seen.update(kw["env"])

        class R:
            returncode = 0
            stdout = ""
            stderr = ""
        return R()

    with patch.object(terminal.subprocess, "run", fake_run):
        terminal.tmux("list-sessions")
    assert seen
    assert not [k for k in seen if k.startswith("DARJEELING_")]
    assert "DEEPSEEK_API_KEY" not in seen


def test_terminal_attach_uses_child_env():
    src = Path(terminal.__file__).read_text()
    assert "os.environ.copy()" not in src
    assert src.count("child_env()") >= 2


# --------------------------------------------------------------------------
# 9. stderr drain survives an oversize line
# --------------------------------------------------------------------------

def test_drain_lines_survives_oversize_line():
    async def main():
        reader = asyncio.StreamReader(limit=1024)
        out: List[str] = []
        task = asyncio.create_task(drain_lines(reader, out.append, max_line=100))
        reader.feed_data(b"first\n")
        reader.feed_data(b"x" * 5000)
        reader.feed_data(b"y" * 5000 + b"\nafter\n")
        reader.feed_data(b"tail-no-newline")
        reader.feed_eof()
        await asyncio.wait_for(task, 5)
        return out

    out = asyncio.run(main())
    assert out[0] == "first"
    assert out[1].startswith("x") and out[1].endswith("[line truncated]")
    assert out[2:] == ["after", "tail-no-newline"]


def test_cli_turn_with_17mib_stderr_line_completes(tmp_path):
    script = (
        "import sys, json\n"
        "sys.stderr.write('E' * (17 * 1024 * 1024))\n"
        "sys.stderr.write('\\nlast stderr line\\n'); sys.stderr.flush()\n"
        "print(json.dumps({'type': 'result', 'subtype': 'success', 'result': 'ok'}))\n"
        "sys.stdout.flush()\n"
        "sys.exit(3)\n"
    )
    t0 = time.monotonic()
    events = _run_turn(PyCliSpec(script), TurnRequest(prompt="x", cwd=str(tmp_path)))
    assert time.monotonic() - t0 < 30
    assert any(e.get("type") == "result" for e in events)
    exited = [e for e in events if e.get("type") == "dj.status" and e.get("state") == "exited"][-1]
    assert exited["code"] == 3
    assert "last stderr line" in exited["stderr"]


# --------------------------------------------------------------------------
# 7. Terminal output buffer is bounded and applies backpressure
# --------------------------------------------------------------------------

def test_bounded_pty_reader_backpressure():
    total = 4 * 1024 * 1024
    limit = 256 * 1024

    async def main():
        r_fd, w_fd = os.pipe()
        os.set_blocking(r_fd, False)
        loop = asyncio.get_running_loop()
        reader = terminal.BoundedPtyReader(loop, r_fd, max_bytes=limit)
        reader.start()

        def writer():
            data = b"z" * total
            view = memoryview(data)
            while view:
                n = os.write(w_fd, view[:65536])
                view = view[n:]
            os.close(w_fd)

        th = threading.Thread(target=writer, daemon=True)
        th.start()
        # Nobody consumes: the reader must pause at the limit, not buffer 4 MiB.
        await asyncio.sleep(0.5)
        assert reader.paused
        assert reader.buffered <= limit + terminal.PTY_READ_CHUNK
        assert th.is_alive()  # writer is blocked by the full pipe

        got = 0
        while True:
            chunk = await asyncio.wait_for(reader.get(), 10)
            if chunk is None:
                break
            got += len(chunk)
            assert reader.buffered <= limit + terminal.PTY_READ_CHUNK
        th.join(5)
        os.close(r_fd)
        return got

    assert asyncio.run(main()) == total


# --------------------------------------------------------------------------
# 9. create_session never falls back to $HOME
# --------------------------------------------------------------------------

class _Res:
    def __init__(self, rc=0, out="", err=""):
        self.returncode, self.stdout, self.stderr = rc, out, err


def _fake_tmux(calls):
    state = {"created": False}

    def fake(*args, **kw):
        calls.append(args)
        if args[0] == "has-session":
            return _Res(0 if state["created"] else 1)
        if args[0] == "new-session":
            state["created"] = True
        return _Res(0)
    return fake


def test_create_session_falls_back_to_vault_not_home(tmp_path, monkeypatch):
    vault = tmp_path / "vault"
    vault.mkdir()
    monkeypatch.setattr(terminal, "VAULT_PATH", vault)
    calls: list = []
    monkeypatch.setattr(terminal, "tmux", _fake_tmux(calls))
    req = terminal.CreateSessionRequest(name="s1", agent="bash", cwd=str(tmp_path / "nope"))
    res = asyncio.run(terminal.create_session(req))
    assert res["cwd"] == str(vault)
    new = next(c for c in calls if c[0] == "new-session")
    assert new[new.index("-c") + 1] == str(vault)
    assert str(Path.home()) != res["cwd"]


def test_create_session_missing_vault_is_400(tmp_path, monkeypatch):
    from fastapi import HTTPException

    monkeypatch.setattr(terminal, "VAULT_PATH", tmp_path / "no-vault")
    calls: list = []
    monkeypatch.setattr(terminal, "tmux", _fake_tmux(calls))
    req = terminal.CreateSessionRequest(name="s2", agent="bash", cwd=str(tmp_path / "nope"))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(terminal.create_session(req))
    assert exc.value.status_code == 400
    assert not [c for c in calls if c[0] == "new-session"]


# --------------------------------------------------------------------------
# 9. Legacy token fails closed when devices.json is unreadable
# --------------------------------------------------------------------------

LEGACY = "legacy-token-for-tests-0123456789"


@pytest.fixture
def auth_mod(monkeypatch, tmp_path):
    import darjeeling_server.auth as auth
    import darjeeling_server.pairing as pairing

    monkeypatch.setattr(auth, "AUTH_TOKEN", LEGACY)
    monkeypatch.setattr(pairing, "DEVICES_FILE", tmp_path / "devices.json")
    monkeypatch.setattr(pairing, "touch_device_last_seen", lambda *_a, **_k: None)
    return auth, pairing


def test_legacy_token_refused_when_device_list_raises(auth_mod, monkeypatch):
    auth, pairing = auth_mod

    def boom():
        raise OSError("permission denied")

    monkeypatch.setattr(pairing, "load_devices", boom)
    assert auth.verify_token(LEGACY) == (False, None)


def test_legacy_token_refused_when_devices_file_unreadable(auth_mod, monkeypatch):
    auth, pairing = auth_mod
    pairing.DEVICES_FILE.write_text("{ not json")
    # pairing swallows the read error and returns []; auth must not treat
    # that as "no devices yet".
    monkeypatch.setattr(pairing, "load_devices", lambda: [])
    assert auth.verify_token(LEGACY) == (False, None)


def test_legacy_token_honoured_by_record_or_fresh_install(auth_mod, monkeypatch):
    auth, pairing = auth_mod
    monkeypatch.setattr(pairing, "load_devices", lambda: [{"device_id": "legacy", "token_hash": "x"}])
    assert auth.verify_token(LEGACY) == (True, "legacy")
    monkeypatch.setattr(pairing, "load_devices", lambda: [{"device_id": "legacy", "revoked": True}])
    assert auth.verify_token(LEGACY) == (False, None)
    # devices.json does not exist at all (could not be initialised): legacy ok.
    assert not pairing.DEVICES_FILE.exists()
    monkeypatch.setattr(pairing, "load_devices", lambda: [])
    assert auth.verify_token(LEGACY) == (True, "legacy")
    assert auth.verify_token("wrong") == (False, None)


# --------------------------------------------------------------------------
# 10. Upgrade: devices.json without a legacy record is seeded at startup
# --------------------------------------------------------------------------

def _load(path):
    import json as _json

    return _json.loads(path.read_text())


def test_startup_seeds_legacy_record_when_missing(auth_mod, monkeypatch):
    import hashlib

    auth, pairing = auth_mod
    monkeypatch.setattr(pairing, "AUTH_TOKEN", LEGACY)
    paired = {"device_id": "phone", "token_hash": "abc", "revoked": False}
    pairing.DEVICES_FILE.write_text(__import__("json").dumps([paired]))
    # Before the startup check the host token is refused (fail closed).
    assert auth.verify_token(LEGACY) == (False, None)

    assert pairing.ensure_legacy_record() == "seeded"
    devices = _load(pairing.DEVICES_FILE)
    assert devices[0] == paired  # existing devices untouched
    legacy = [d for d in devices if d["device_id"] == "legacy"]
    assert len(legacy) == 1 and legacy[0]["revoked"] is False
    assert legacy[0]["token_hash"] == hashlib.sha256(LEGACY.encode()).hexdigest()
    assert auth.verify_token(LEGACY) == (True, "legacy")
    # Idempotent.
    assert pairing.ensure_legacy_record() == "present"
    assert len(_load(pairing.DEVICES_FILE)) == 2


def test_startup_never_unrevokes_legacy(auth_mod, monkeypatch):
    auth, pairing = auth_mod
    monkeypatch.setattr(pairing, "AUTH_TOKEN", LEGACY)
    pairing.DEVICES_FILE.write_text('[{"device_id": "legacy", "token_hash": "x", "revoked": true}]')
    assert pairing.ensure_legacy_record() == "present"
    assert _load(pairing.DEVICES_FILE)[0]["revoked"] is True
    assert auth.verify_token(LEGACY) == (False, None)


@pytest.mark.parametrize("content", ["{ not json", '{"device_id": "legacy"}'])
def test_startup_unreadable_devices_fails_closed_with_clear_error(auth_mod, monkeypatch, caplog, content):
    auth, pairing = auth_mod
    monkeypatch.setattr(pairing, "AUTH_TOKEN", LEGACY)
    pairing.DEVICES_FILE.write_text(content)
    with caplog.at_level("ERROR", logger="darjeeling.pairing"):
        assert pairing.ensure_legacy_record() == "unreadable"
    assert pairing.DEVICES_FILE.read_text() == content  # never overwritten
    msg = " ".join(r.getMessage() for r in caplog.records)
    assert str(pairing.DEVICES_FILE) in msg and "chmod 600" in msg and "restart" in msg
    assert auth.verify_token(LEGACY) == (False, None)


def test_startup_creates_devices_file_on_fresh_install(auth_mod, monkeypatch):
    auth, pairing = auth_mod
    monkeypatch.setattr(pairing, "AUTH_TOKEN", LEGACY)
    assert pairing.ensure_legacy_record() == "created"
    assert [d["device_id"] for d in _load(pairing.DEVICES_FILE)] == ["legacy"]

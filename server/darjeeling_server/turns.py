"""Agent turn execution, process lifecycle, and streaming endpoints (Protocol v2 / ADR-11)."""

import asyncio
import collections
import contextlib
import json
import os
import shlex
import signal
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional, Set

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationInfo, field_validator

from darjeeling_server.agents import AGENTS
from darjeeling_server.agents.agy import normalize_agy_event
from darjeeling_server.agents.base import AgentSpec, is_safe_resume_id, is_uuid
from darjeeling_server.auth import require_auth, unregister_ws, ws_auth
from darjeeling_server.config import (
    MAX_CONCURRENT_TURNS,
    PERMISSION_CEILING,
    TURN_BUFFER_BUDGET,
    TURN_TIMEOUT,
    VAULT_PATH,
    child_env,
    log,
    permission_rank,
)
from darjeeling_server.host import (
    agent_load,
    register_turn,
    release_turn_slot,
    try_reserve_turn_slot,
    unregister_turn,
    update_turn_slot,
)

router = APIRouter(tags=["turns"])


class TurnRequest(BaseModel):
    agent: str = "claude"
    prompt: str
    client_turn_id: Optional[str] = None
    model: Optional[str] = None
    fallback_model: Optional[str] = None
    effort: Optional[str] = None
    # Absent -> the agent's most restrictive mode; explicit null or an
    # unknown mode -> rejected (see resolve_turn_permission).
    permission_mode: Optional[str] = None
    resume: Optional[str] = None
    session_id: Optional[str] = None
    fork: bool = False
    cwd: Optional[str] = None
    append_system_prompt: Optional[str] = None
    allowed_tools: List[str] = []
    disallowed_tools: List[str] = []
    add_dirs: List[str] = []
    partial_messages: bool = False
    # Structured output. The plan and verification passes need parseable
    # JSON back, not prose we would have to scrape out of the transcript.
    json_schema: Optional[Dict[str, Any]] = None
    async_: bool = Field(default=False, alias="async")

    model_config = {"populate_by_name": True}

    @field_validator("resume", "session_id", mode="before")
    @classmethod
    def _uuid_session(cls, v: Any, info: ValidationInfo) -> Any:
        # Session ids reach agent argv (--resume/--session-id/--conversation);
        # only UUIDs are accepted so a value can never be read as a flag.
        # agy does not document its conversation id format, so it gets a
        # conservative token (no leading '-', no '/', no whitespace).
        if v is None or v == "":
            return None
        if (info.data or {}).get("agent") == "agy":
            if not is_safe_resume_id(v):
                raise ValueError("must be a safe session id (letters, digits, _ . : -; no leading '-')")
            return v
        if not isinstance(v, str) or not is_uuid(v):
            raise ValueError("must be a UUID")
        return v


class PermissionError_(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def resolve_turn_permission(spec: AgentSpec, req: TurnRequest) -> str:
    """
    Allow-list the requested permission mode against the agent descriptor,
    then enforce the host ceiling (ADR-07). Writes the canonical mode back to
    req.permission_mode so build_argv always passes an explicit flag.
    Raises PermissionError_ on unknown/null modes or a ceiling breach.
    """
    explicit = "permission_mode" in req.model_fields_set
    try:
        mode = spec.resolve_permission_mode(req.permission_mode, explicit=explicit)
    except ValueError as err:
        raise PermissionError_("invalid_permission_mode", str(err))
    if permission_rank(mode) > permission_rank(PERMISSION_CEILING):
        raise PermissionError_(
            "permission_ceiling",
            f"Permission mode '{mode}' exceeds host ceiling '{PERMISSION_CEILING}'. "
            f"Raise the ceiling by setting DARJEELING_PERMISSION_CEILING={mode} "
            "in the host environment.",
        )
    req.permission_mode = mode
    return mode


class AtCapacityError(Exception):
    pass


async def drain_lines(reader: asyncio.StreamReader, sink, max_line: int = 4000) -> None:
    """
    Read newline-delimited output until EOF without ever giving up.

    `async for line in reader` raises ValueError on a line longer than the
    reader's limit and stops draining; the child then blocks on a full pipe.
    Here an oversize line is truncated to max_line chars and the rest of it
    is discarded chunk by chunk.
    """
    skipping = False
    while True:
        try:
            raw = await reader.readuntil(b"\n")
        except asyncio.IncompleteReadError as e:
            if e.partial and not skipping:
                sink(e.partial.decode("utf-8", errors="replace").rstrip()[:max_line])
            return
        except asyncio.LimitOverrunError as e:
            chunk = await reader.read(max(e.consumed, 1))
            if not chunk:
                return
            if not skipping:
                text = chunk.decode("utf-8", errors="replace")[:max_line]
                sink(text + " [line truncated]")
                skipping = True
            continue
        if skipping:
            # Tail of the oversize line.
            skipping = False
            continue
        line = raw.decode("utf-8", errors="replace").rstrip()
        if line:
            sink(line[:max_line])


class AgentTurn:
    """One agent invocation: spawn, stream NDJSON out, allow interruption."""

    def __init__(self, spec: AgentSpec, req: TurnRequest):
        self.spec = spec
        self.req = req
        self.proc: Optional[asyncio.subprocess.Process] = None
        self.session_id: Optional[str] = None
        self.started = time.monotonic()
        self.exited_emitted = False
        # Concurrency slot reserved by TurnRegistry.create_turn before spawn.
        self.slot_key: Optional[str] = None

    async def run(self, emit) -> None:
        if not self.spec.available:
            reason = (
                "no API key set on the host"
                if self.spec.is_api
                else f"{self.spec.binary} not found on PATH"
            )
            await emit(
                {
                    "type": "dj.error",
                    "message": f"{self.spec.label} is not available ({reason}).",
                    "terminal": True,
                }
            )
            return

        # Permission allow-list + ceiling (ADR-07). Fail closed.
        try:
            resolve_turn_permission(self.spec, self.req)
        except PermissionError_ as perr:
            await emit(
                {
                    "type": "dj.error",
                    "code": perr.code,
                    "message": perr.message,
                    "terminal": True,
                }
            )
            return

        # Validate working directory (SRV-14, QA-08)
        cwd = Path(self.req.cwd).expanduser().resolve() if self.req.cwd else VAULT_PATH
        if not cwd.is_dir():
            await emit(
                {
                    "type": "dj.error",
                    "code": "missing_cwd",
                    "message": f"Working directory does not exist or is not a directory: {self.req.cwd or cwd}",
                    "terminal": True,
                }
            )
            await emit(
                {
                    "type": "dj.status",
                    "state": "exited",
                    "code": 1,
                    "sessionId": self.session_id,
                    "durationMs": int((time.monotonic() - self.started) * 1000),
                    "stderr": "Directory does not exist",
                }
            )
            return

        if self.spec.is_api:
            await self._run_api_wrapped(emit)
            return

        await self._run_cli(emit)

    async def _run_api_wrapped(self, emit) -> None:
        await emit(
            {
                "type": "dj.status",
                "state": "starting",
                "agent": self.spec.key,
                "model": self.req.model or "(default)",
                "effort": self.req.effort or "(default)",
                "permissionMode": self.req.permission_mode,
                "cwd": self.req.cwd or str(VAULT_PATH),
                "command": f"{self.spec.label} API call <prompt>",
            }
        )
        await emit({"type": "dj.status", "state": "running", "pid": None})

        async def capturing_emit(event: Dict[str, Any]) -> None:
            if isinstance(event, dict):
                sid = (
                    event.get("session_id")
                    or event.get("conversation_id")
                    or (event.get("result", {}).get("conversation_id") if isinstance(event.get("result"), dict) else None)
                )
                if sid:
                    self.session_id = sid
            await emit(event)

        turn_key = f"api_{id(self)}"
        if self.slot_key is None:
            register_turn(
                turn_key,
                {
                    "agent": self.spec.key,
                    "model": self.req.model or "(default)",
                    "task": asyncio.current_task(),
                    "started": time.monotonic(),
                },
            )
        exit_code = 0
        try:
            await self.spec.run_api(self.req, capturing_emit)
        except asyncio.CancelledError:
            exit_code = 1
            raise
        except Exception as err:
            exit_code = 1
            log.exception("API turn failed")
            await emit({"type": "dj.error", "message": str(err), "terminal": True})
        finally:
            unregister_turn(turn_key)
            if not self.exited_emitted:
                self.exited_emitted = True
                await emit(
                    {
                        "type": "dj.status",
                        "state": "exited",
                        "code": exit_code,
                        "sessionId": self.session_id,
                        "durationMs": int((time.monotonic() - self.started) * 1000),
                        "stderr": "",
                    }
                )

    async def _run_cli(self, emit) -> None:
        cwd = Path(self.req.cwd).expanduser().resolve() if self.req.cwd else VAULT_PATH

        try:
            argv = self.spec.build_argv(self.req)
        except ValueError as err:
            await emit({"type": "dj.error", "message": str(err), "terminal": True})
            if not self.exited_emitted:
                self.exited_emitted = True
                await emit(
                    {
                        "type": "dj.status",
                        "state": "exited",
                        "code": 1,
                        "sessionId": self.session_id,
                        "durationMs": int((time.monotonic() - self.started) * 1000),
                        "stderr": str(err),
                    }
                )
            return

        # child_env strips DARJEELING_* (incl. the token) and DEEPSEEK_API_KEY.
        env = child_env()
        env.setdefault("TERM", "dumb")
        env["CLAUDE_CODE_NON_INTERACTIVE"] = "1"

        def _sanitize_argv_for_echo(args: list[str]) -> list[str]:
            sanitized: list[str] = []
            skip_next = False
            for arg in args:
                if skip_next:
                    skip_next = False
                    continue
                if arg == "--append-system-prompt":
                    sanitized.append(arg)
                    sanitized.append("<elided>")
                    skip_next = True
                elif arg.startswith("--append-system-prompt="):
                    sanitized.append("--append-system-prompt=<elided>")
                elif arg == "--json-schema":
                    sanitized.append(arg)
                    sanitized.append("<elided>")
                    skip_next = True
                elif arg.startswith("--json-schema="):
                    sanitized.append("--json-schema=<elided>")
                else:
                    sanitized.append(arg)
            return sanitized

        cmd_echo = " ".join(shlex.quote(a) for a in _sanitize_argv_for_echo(argv)) + " <prompt>"

        await emit(
            {
                "type": "dj.status",
                "state": "starting",
                "agent": self.spec.key,
                "model": self.req.model or "(default)",
                "effort": self.req.effort or "(default)",
                "permissionMode": self.req.permission_mode,
                "cwd": str(cwd),
                "command": cmd_echo,
            }
        )

        try:
            self.proc = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.PIPE if self.spec.key == "claude" else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(cwd),
                env=env,
                limit=16 * 1024 * 1024,
                start_new_session=True,
            )
        except FileNotFoundError:
            await emit({"type": "dj.error", "message": f"{self.spec.binary} not found", "terminal": True})
            if not self.exited_emitted:
                self.exited_emitted = True
                await emit(
                    {
                        "type": "dj.status",
                        "state": "exited",
                        "code": 1,
                        "sessionId": self.session_id,
                        "durationMs": int((time.monotonic() - self.started) * 1000),
                        "stderr": f"{self.spec.binary} not found",
                    }
                )
            return

        if self.spec.key == "claude" and self.proc.stdin:
            self.proc.stdin.write(self.req.prompt.encode("utf-8"))
            await self.proc.stdin.drain()
            self.proc.stdin.close()
            await self.proc.stdin.wait_closed()

        if self.slot_key is not None:
            update_turn_slot(self.slot_key, pid=self.proc.pid)
        else:
            register_turn(
                self.proc.pid,
                {
                    "agent": self.spec.key,
                    "model": self.req.model or "(default)",
                    "proc": self.proc,
                    "started": time.monotonic(),
                },
            )

        await emit({"type": "dj.status", "state": "running", "pid": self.proc.pid})

        stderr_buf: collections.deque = collections.deque(maxlen=100)

        def _stderr_sink(line: str) -> None:
            stderr_buf.append(line)
            log.debug("[%s stderr] %s", self.spec.key, line)

        async def drain_stderr() -> None:
            assert self.proc and self.proc.stderr
            await drain_lines(self.proc.stderr, _stderr_sink)

        err_task = asyncio.create_task(drain_stderr())

        rc = None
        try:
            assert self.proc.stdout
            async for raw in self.proc.stdout:
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    await emit({"type": "dj.raw", "line": line[:4000]})
                    continue

                if isinstance(event, dict):
                    sid = (
                        event.get("session_id")
                        or event.get("conversation_id")
                        or (event.get("result", {}).get("conversation_id") if isinstance(event.get("result"), dict) else None)
                        or (event.get("step_update", {}).get("conversation_id") if isinstance(event.get("step_update"), dict) else None)
                    )
                    if sid:
                        self.session_id = sid

                if self.spec.key == "agy" and isinstance(event, dict):
                    for norm in normalize_agy_event(event, self.session_id, self.req.model):
                        await emit(norm)
                else:
                    await emit(event)
        except asyncio.CancelledError:
            await self.interrupt()
            raise
        except Exception as err:
            log.exception("CLI turn error")
            err_msg = str(err)
            if "Separator is found, but chunk is longer than limit" in err_msg:
                err_msg = "Stream line exceeded maximum buffer size (16 MB)"
            await emit({"type": "dj.error", "message": err_msg, "terminal": True})
        finally:
            if self.proc:
                if self.proc.returncode is None:
                    await self.interrupt()
                rc = self.proc.returncode
                unregister_turn(self.proc.pid)

            if err_task and not err_task.done():
                err_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await err_task

            if not self.exited_emitted:
                self.exited_emitted = True
                await emit(
                    {
                        "type": "dj.status",
                        "state": "exited",
                        "code": rc if rc is not None else 1,
                        "sessionId": self.session_id,
                        "durationMs": int((time.monotonic() - self.started) * 1000),
                        "stderr": "\n".join(list(stderr_buf)[-40:]) if rc != 0 else "",
                    }
                )

    async def interrupt(self) -> None:
        if self.proc and self.proc.returncode is None:
            pid = self.proc.pid
            try:
                pgid = os.getpgid(pid)
                os.killpg(pgid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except Exception as e:
                log.debug("Process group SIGTERM error on %s: %s", pid, e)
                with contextlib.suppress(ProcessLookupError):
                    self.proc.terminate()

            try:
                await asyncio.wait_for(self.proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                try:
                    pgid = os.getpgid(pid)
                    os.killpg(pgid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                except Exception as e:
                    log.debug("Process group SIGKILL error on %s: %s", pid, e)
                    with contextlib.suppress(ProcessLookupError):
                        self.proc.kill()
                with contextlib.suppress(Exception):
                    await self.proc.wait()

            unregister_turn(pid)


@dataclass
class TurnRecord:
    """Persistent turn tracking per ADR-11."""
    turn_id: str
    client_turn_id: Optional[str]
    agent: str
    session_id: Optional[str]
    status: str = "running"
    started_at: float = field(default_factory=time.time)
    ended_at: Optional[float] = None
    last_seq: int = 0
    oldest_seq: int = 1
    ring_buffer: Deque[Dict[str, Any]] = field(default_factory=lambda: collections.deque(maxlen=10000))
    buffer_bytes: int = 0
    subscribers: Set[asyncio.Queue] = field(default_factory=set)
    event_notify: asyncio.Event = field(default_factory=asyncio.Event)
    task: Optional[asyncio.Task] = None
    agent_turn: Optional[AgentTurn] = None
    model_emitted: bool = False

    @property
    def is_running(self) -> bool:
        return self.status == "running"

    def emit_sync(self, event: Dict[str, Any]) -> None:
        """Tag with envelope fields, enforce ring buffer limits, and notify subscribers."""
        self.last_seq += 1
        event["dj_turn"] = self.turn_id
        event["dj_seq"] = self.last_seq

        raw_bytes = json.dumps(event, ensure_ascii=False).encode("utf-8")
        event_size = len(raw_bytes)

        max_turn_bytes = 16 * 1024 * 1024
        while self.ring_buffer and (self.buffer_bytes + event_size > max_turn_bytes or len(self.ring_buffer) >= 10000):
            evicted = self.ring_buffer.popleft()
            self.buffer_bytes -= len(json.dumps(evicted, ensure_ascii=False).encode("utf-8"))
            if self.ring_buffer:
                self.oldest_seq = self.ring_buffer[0].get("dj_seq", 1)

        self.ring_buffer.append(event)
        self.buffer_bytes += event_size
        self.oldest_seq = self.ring_buffer[0].get("dj_seq", 1)

        for q in list(self.subscribers):
            try:
                q.put_nowait(event)
            except Exception:
                pass

        self.event_notify.set()
        self.event_notify.clear()

    async def emit(self, event: Dict[str, Any]) -> None:
        self.emit_sync(event)


class SessionBusyError(Exception):
    def __init__(self, turn_id: str, session_id: str):
        super().__init__(f"Session '{session_id}' already has an active turn.")
        self.turn_id = turn_id
        self.session_id = session_id


class TurnRegistry:
    """Manages long-lived turns, buffer retention, and per-session concurrency locks."""

    def __init__(self):
        self.active_turns: Dict[str, TurnRecord] = {}
        self.finished_turns: Dict[str, TurnRecord] = {}
        self.sessions_to_turn: Dict[str, str] = {}

    def get_turn(self, turn_id: str) -> Optional[TurnRecord]:
        self._evict_expired()
        return self.active_turns.get(turn_id) or self.finished_turns.get(turn_id)

    def list_turns(self, state: Optional[str] = None) -> List[TurnRecord]:
        self._evict_expired()
        if state == "running":
            return list(self.active_turns.values())
        elif state == "recent":
            return list(self.finished_turns.values())
        return list(self.active_turns.values()) + list(self.finished_turns.values())

    def create_turn(self, spec: AgentSpec, req: TurnRequest) -> TurnRecord:
        self._evict_expired()
        target_session = req.resume or req.session_id
        if target_session and target_session in self.sessions_to_turn:
            running_tid = self.sessions_to_turn[target_session]
            if running_tid in self.active_turns:
                raise SessionBusyError(running_tid, target_session)
            else:
                self.sessions_to_turn.pop(target_session, None)

        turn_id = "t_" + uuid.uuid4().hex[:12]
        # Reserve the concurrency slot atomically, before anything spawns.
        if not try_reserve_turn_slot(
            turn_id, {"agent": spec.key, "model": req.model or "(default)"}
        ):
            raise AtCapacityError(
                f"{agent_load()['activeTurns']} turn(s) already running, cap is {MAX_CONCURRENT_TURNS}."
            )
        record = TurnRecord(
            turn_id=turn_id,
            client_turn_id=req.client_turn_id,
            agent=spec.key,
            session_id=target_session,
            status="running",
        )
        self.active_turns[turn_id] = record
        if target_session:
            self.sessions_to_turn[target_session] = turn_id

        # Protocol v2 frame 1: dj.turn (docs/protocol.md §2)
        record.emit_sync(
            {
                "type": "dj.turn",
                "turn_id": turn_id,
                "client_turn_id": req.client_turn_id,
                "started_at": record.started_at,
            }
        )

        agent_turn = AgentTurn(spec, req)
        agent_turn.slot_key = turn_id
        record.agent_turn = agent_turn
        try:
            record.task = asyncio.create_task(self._run_guarded(record, agent_turn, spec, req))
        except BaseException:
            release_turn_slot(turn_id)
            self.active_turns.pop(turn_id, None)
            if target_session:
                self.sessions_to_turn.pop(target_session, None)
            raise
        update_turn_slot(turn_id, task=record.task)
        # Also release if the task is cancelled before its body ever runs.
        record.task.add_done_callback(lambda _t, k=turn_id: release_turn_slot(k))
        return record

    async def _run_guarded(
        self,
        record: TurnRecord,
        turn: AgentTurn,
        spec: AgentSpec,
        req: TurnRequest,
    ) -> None:
        async def wrapped_emit(event: Dict[str, Any]) -> None:
            # Model actual notice (SRV-15, DOC-07)
            if not record.model_emitted and isinstance(event, dict):
                actual_model = (
                    event.get("model")
                    or (event.get("message", {}).get("model") if isinstance(event.get("message"), dict) else None)
                )
                if actual_model:
                    record.model_emitted = True
                    record.emit_sync(
                        {
                            "type": "dj.model",
                            "requested": req.model or "default",
                            "actual": actual_model,
                        }
                    )

            # Not-logged-in status check (QA-20)
            if isinstance(event, dict):
                if event.get("type") == "result":
                    if event.get("is_error"):
                        res_text = str(event.get("result", ""))
                        if "not logged in" in res_text.lower() or "/login" in res_text.lower():
                            spec.authenticated = False
                            event["code"] = "not_logged_in"
                            event["fix"] = f"Run '{spec.binary} login' in the terminal to authenticate."
                    else:
                        spec.authenticated = True

            record.emit_sync(event)

        try:
            await asyncio.wait_for(turn.run(wrapped_emit), timeout=TURN_TIMEOUT)
            if record.status == "running":
                record.status = "completed"
        except asyncio.TimeoutError:
            await turn.interrupt()
            record.status = "error"
            record.emit_sync(
                {
                    "type": "dj.error",
                    "code": "timeout",
                    "message": f"Turn exceeded {TURN_TIMEOUT}s and was stopped.",
                    "terminal": True,
                }
            )
        except asyncio.CancelledError:
            if record.status == "running":
                record.status = "interrupted"
            raise
        except Exception as err:
            log.exception("Turn execution failed")
            record.status = "error"
            record.emit_sync({"type": "dj.error", "message": str(err), "terminal": True})
        finally:
            release_turn_slot(record.turn_id)
            record.ended_at = time.time()
            if turn.session_id:
                record.session_id = turn.session_id

            # Release session lock
            if req.resume and req.resume in self.sessions_to_turn:
                self.sessions_to_turn.pop(req.resume, None)
            if req.session_id and req.session_id in self.sessions_to_turn:
                self.sessions_to_turn.pop(req.session_id, None)
            if turn.session_id and turn.session_id in self.sessions_to_turn:
                self.sessions_to_turn.pop(turn.session_id, None)

            # Transition to finished_turns
            self.active_turns.pop(record.turn_id, None)
            self.finished_turns[record.turn_id] = record
            self._evict_expired()

    async def interrupt_turn(self, turn_id: str) -> bool:
        record = self.active_turns.get(turn_id)
        if not record:
            return False
        record.status = "interrupted"
        if record.agent_turn:
            await record.agent_turn.interrupt()
        if record.task and not record.task.done():
            record.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await record.task
        record.emit_sync({"type": "dj.status", "state": "interrupted"})
        return True

    def _evict_expired(self) -> None:
        now = time.time()
        # 1. 30-minute TTL
        expired_tids = [
            tid for tid, t in self.finished_turns.items()
            if t.ended_at and (now - t.ended_at > 1800)
        ]
        for tid in expired_tids:
            self.finished_turns.pop(tid, None)

        # 2. Global turn buffer budget
        total_finished_bytes = sum(t.buffer_bytes for t in self.finished_turns.values())
        if total_finished_bytes > TURN_BUFFER_BUDGET:
            sorted_finished = sorted(
                self.finished_turns.items(),
                key=lambda item: item[1].ended_at or 0.0,
            )
            for tid, t in sorted_finished:
                if total_finished_bytes <= TURN_BUFFER_BUDGET:
                    break
                total_finished_bytes -= t.buffer_bytes
                self.finished_turns.pop(tid, None)


turn_registry = TurnRegistry()


@router.websocket("/ws/agent")
async def agent_channel(websocket: WebSocket, token: Optional[str] = Query(None)):
    allowed, subprotocol = ws_auth(websocket, token)
    if not allowed:
        log.warning("Agent channel rejected: bad token")
        await websocket.accept()
        await websocket.close(code=4401, reason="token rejected")
        return

    await websocket.accept(subprotocol=subprotocol)
    log.info("Agent channel opened for %s", websocket.client.host if websocket.client else "unknown")

    send_queue: asyncio.Queue = asyncio.Queue()
    current_subscriber_q: Optional[asyncio.Queue] = None
    current_turn_record: Optional[TurnRecord] = None
    forwarder_task: Optional[asyncio.Task] = None

    async def sender_task():
        try:
            while True:
                msg = await send_queue.get()
                if isinstance(msg, dict):
                    msg = json.dumps(msg, ensure_ascii=False)
                await websocket.send_text(msg)
                send_queue.task_done()
        except (WebSocketDisconnect, ConnectionResetError, asyncio.CancelledError):
            pass
        except Exception as e:
            log.debug("WebSocket sender exception: %s", e)

    sender = asyncio.create_task(sender_task())

    last_sent_seq = 0

    async def forward_subscriber_events(record: TurnRecord, q: asyncio.Queue):
        nonlocal last_sent_seq
        try:
            while True:
                ev = await q.get()
                seq = ev.get("dj_seq", 0)
                if seq == 0 or seq > last_sent_seq:
                    if seq > 0:
                        last_sent_seq = seq
                    await send_queue.put(ev)
                q.task_done()
        except asyncio.CancelledError:
            pass
        finally:
            record.subscribers.discard(q)

    def attach_subscriber_to_turn(record: TurnRecord, initial_seq: int = 0):
        nonlocal current_subscriber_q, current_turn_record, forwarder_task, last_sent_seq
        last_sent_seq = initial_seq
        if forwarder_task and not forwarder_task.done():
            forwarder_task.cancel()
        if current_turn_record and current_subscriber_q:
            current_turn_record.subscribers.discard(current_subscriber_q)

        current_turn_record = record
        if record.is_running:
            current_subscriber_q = asyncio.Queue()
            record.subscribers.add(current_subscriber_q)
            forwarder_task = asyncio.create_task(forward_subscriber_events(record, current_subscriber_q))
        else:
            current_subscriber_q = None
            forwarder_task = None

    try:
        while True:
            msg = await websocket.receive_text()
            try:
                payload = json.loads(msg)
            except json.JSONDecodeError:
                await send_queue.put({"type": "dj.error", "message": "Frames must be JSON."})
                continue

            if not isinstance(payload, dict):
                await send_queue.put(
                    {
                        "type": "dj.error",
                        "code": "client_too_old",
                        "message": "Client protocol too old. Please update the Darjeeling plugin.",
                        "terminal": True,
                    }
                )
                continue

            # Check 4.1.0-style frames (OD-22)
            if payload.get("client_version") == "4.1.0" or ("type" not in payload and "prompt" in payload):
                await send_queue.put(
                    {
                        "type": "dj.error",
                        "code": "client_too_old",
                        "message": "Client protocol too old. Please update the Darjeeling plugin.",
                        "terminal": True,
                    }
                )
                continue

            kind = payload.get("type")
            if kind == "turn":
                if current_turn_record and current_turn_record.is_running:
                    await send_queue.put(
                        {
                            "type": "dj.error",
                            "message": "A turn is already running on this channel. Wait for it to finish or interrupt it.",
                        }
                    )
                    continue

                target_session = payload.get("resume") or payload.get("session_id")
                if target_session and target_session in turn_registry.sessions_to_turn:
                    active_tid = turn_registry.sessions_to_turn[target_session]
                    if active_tid in turn_registry.active_turns:
                        await send_queue.put(
                            {
                                "type": "dj.error",
                                "code": "session_busy",
                                "turn_id": active_tid,
                                "message": f"Session '{target_session}' already has an active turn.",
                                "terminal": True,
                            }
                        )
                        continue

                agent_name = payload.get("agent", "claude")
                spec = AGENTS.get(agent_name)
                if not spec:
                    await send_queue.put(
                        {"type": "dj.error", "message": f"Unknown agent '{agent_name}'", "terminal": True}
                    )
                    continue

                # Legacy escalation spellings are never honoured, but a frame
                # carrying them is still refused if it would breach the ceiling.
                legacy_perm = None
                if payload.get("dangerously_skip_permissions") or payload.get("dangerously-skip-permissions"):
                    legacy_perm = "bypassPermissions"
                elif "permission_mode" not in payload and payload.get("mode"):
                    legacy_perm = payload.get("mode")
                if legacy_perm is not None and permission_rank(legacy_perm) > permission_rank(PERMISSION_CEILING):
                    await send_queue.put(
                        {
                            "type": "dj.error",
                            "code": "permission_ceiling",
                            "message": (
                                f"Permission mode '{legacy_perm}' exceeds host ceiling '{PERMISSION_CEILING}'. "
                                f"Raise the ceiling by setting DARJEELING_PERMISSION_CEILING={legacy_perm} "
                                "in the host environment."
                            ),
                            "terminal": True,
                        }
                    )
                    continue

                try:
                    req = TurnRequest(**payload)
                except Exception as e:
                    await send_queue.put({"type": "dj.error", "code": "bad_request", "message": str(e), "terminal": True})
                    continue

                try:
                    resolve_turn_permission(spec, req)
                except PermissionError_ as perr:
                    await send_queue.put(
                        {"type": "dj.error", "code": perr.code, "message": perr.message, "terminal": True}
                    )
                    continue

                try:
                    record = turn_registry.create_turn(spec, req)
                except SessionBusyError as sbe:
                    await send_queue.put(
                        {
                            "type": "dj.error",
                            "code": "session_busy",
                            "turn_id": sbe.turn_id,
                            "message": str(sbe),
                            "terminal": True,
                        }
                    )
                    continue
                except AtCapacityError as cap:
                    await send_queue.put(
                        {
                            "type": "dj.error",
                            "code": "at_capacity",
                            "message": f"Refused: {cap}",
                            "terminal": True,
                        }
                    )
                    continue
                except Exception as e:
                    await send_queue.put({"type": "dj.error", "message": str(e), "terminal": True})
                    continue

                attach_subscriber_to_turn(record, initial_seq=0)
                for ev in list(record.ring_buffer):
                    seq = ev.get("dj_seq", 0)
                    if seq == 0 or seq > last_sent_seq:
                        if seq > 0:
                            last_sent_seq = seq
                        await send_queue.put(ev)

            elif kind == "attach":
                turn_id = payload.get("turn_id")
                since_seq = payload.get("since_seq", 0)
                record = turn_registry.get_turn(turn_id) if turn_id else None
                if not record:
                    await send_queue.put(
                        {
                            "type": "dj.error",
                            "code": "turn_expired",
                            "message": f"Turn '{turn_id}' has expired or been evicted.",
                            "terminal": True,
                        }
                    )
                    continue

                if since_seq < record.oldest_seq and record.oldest_seq > 1:
                    await send_queue.put(
                        {
                            "type": "dj.gap",
                            "turn_id": record.turn_id,
                            "from": since_seq,
                            "to": record.oldest_seq,
                        }
                    )

                attach_subscriber_to_turn(record, initial_seq=since_seq)
                replay_events = [e for e in record.ring_buffer if e.get("dj_seq", 0) > since_seq]
                for ev in replay_events:
                    seq = ev.get("dj_seq", 0)
                    if seq == 0 or seq > last_sent_seq:
                        if seq > 0:
                            last_sent_seq = seq
                        await send_queue.put(ev)

            elif kind == "interrupt":
                turn_id = payload.get("turn_id") or (current_turn_record.turn_id if current_turn_record else None)
                if turn_id:
                    await turn_registry.interrupt_turn(turn_id)
                    if not (current_turn_record and current_turn_record.turn_id == turn_id):
                        await send_queue.put({"type": "dj.status", "state": "interrupted"})
                else:
                    await send_queue.put({"type": "dj.status", "state": "interrupted"})

            elif kind == "ping":
                await send_queue.put({"type": "dj.pong", "t": int(time.time() * 1000)})

            else:
                await send_queue.put(
                    {
                        "type": "dj.error",
                        "code": "client_too_old",
                        "message": f"Unknown frame type '{kind}'",
                    }
                )

    except (WebSocketDisconnect, ConnectionResetError):
        log.info("Agent channel closed for %s", websocket.client.host if websocket.client else "unknown")
    except Exception as err:
        log.warning("Agent channel error: %s", err)
    finally:
        unregister_ws(websocket)
        if forwarder_task and not forwarder_task.done():
            forwarder_task.cancel()
        if current_turn_record and current_subscriber_q:
            current_turn_record.subscribers.discard(current_subscriber_q)
        if sender and not sender.done():
            sender.cancel()


@router.post("/api/agent/turn", dependencies=[Depends(require_auth)])
async def agent_turn_endpoint(req: TurnRequest, async_: bool = Query(False, alias="async")):
    is_async = async_ or req.async_
    spec = AGENTS.get(req.agent)
    if not spec:
        raise HTTPException(status_code=400, detail=f"Unknown agent '{req.agent}'")
    if not spec.available:
        raise HTTPException(status_code=503, detail=f"{spec.binary} not installed on host")

    # Permission allow-list + ceiling (fail closed).
    try:
        resolve_turn_permission(spec, req)
    except PermissionError_ as perr:
        raise HTTPException(
            status_code=403 if perr.code == "permission_ceiling" else 400,
            detail=perr.message,
        )

    # Session busy check
    target_session = req.resume or req.session_id
    if target_session and target_session in turn_registry.sessions_to_turn:
        active_tid = turn_registry.sessions_to_turn[target_session]
        if active_tid in turn_registry.active_turns:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "session_busy",
                    "turn_id": active_tid,
                    "message": f"Session '{target_session}' already has an active turn.",
                },
            )

    try:
        record = turn_registry.create_turn(spec, req)
    except SessionBusyError as sbe:
        raise HTTPException(
            status_code=409,
            detail={"code": "session_busy", "turn_id": sbe.turn_id, "message": str(sbe)},
        )
    except AtCapacityError as cap:
        raise HTTPException(status_code=429, detail=str(cap))

    if is_async:
        return JSONResponse(status_code=202, content={"turn_id": record.turn_id, "status": "running"})

    # Synchronous buffered response: wait for turn completion
    if record.task:
        try:
            await asyncio.wait_for(asyncio.shield(record.task), timeout=TURN_TIMEOUT)
        except asyncio.TimeoutError:
            await turn_registry.interrupt_turn(record.turn_id)
            raise HTTPException(status_code=504, detail="Turn timed out")
        except Exception:
            pass

    session_id = record.session_id or (record.agent_turn.session_id if record.agent_turn else None)
    return {"events": list(record.ring_buffer), "sessionId": session_id}


@router.get("/api/turns/{turn_id}/events", dependencies=[Depends(require_auth)])
async def get_turn_events(
    turn_id: str,
    since_seq: int = Query(0),
    wait: int = Query(25),
):
    turn = turn_registry.get_turn(turn_id)
    if not turn:
        raise HTTPException(status_code=404, detail="turn_expired")

    events = [e for e in turn.ring_buffer if e.get("dj_seq", 0) > since_seq]
    if events:
        return {
            "turn_id": turn.turn_id,
            "events": events,
            "running": turn.is_running,
            "last_seq": turn.last_seq,
        }

    if not turn.is_running:
        return {
            "turn_id": turn.turn_id,
            "events": [],
            "running": False,
            "last_seq": turn.last_seq,
        }

    if wait > 0:
        deadline = time.time() + min(wait, 30)
        while time.time() < deadline and turn.is_running:
            remaining = max(0.1, deadline - time.time())
            subscriber_q: asyncio.Queue = asyncio.Queue()
            turn.subscribers.add(subscriber_q)
            try:
                ev = await asyncio.wait_for(subscriber_q.get(), timeout=remaining)
                events.append(ev)
                while not subscriber_q.empty():
                    events.append(subscriber_q.get_nowait())
                break
            except asyncio.TimeoutError:
                break
            finally:
                turn.subscribers.discard(subscriber_q)

    return {
        "turn_id": turn.turn_id,
        "events": events,
        "running": turn.is_running,
        "last_seq": turn.last_seq,
    }


@router.get("/api/turns", dependencies=[Depends(require_auth)])
async def list_turns(state: Optional[str] = Query(None)):
    turns = turn_registry.list_turns(state=state)
    return {
        "turns": [
            {
                "turn_id": t.turn_id,
                "agent": t.agent,
                "session_id": t.session_id,
                "status": t.status,
                "started_at": t.started_at,
                "ended_at": t.ended_at,
                "last_seq": t.last_seq,
            }
            for t in turns
        ]
    }


@router.post("/api/turns/{turn_id}/interrupt", dependencies=[Depends(require_auth)])
async def interrupt_turn_endpoint(turn_id: str):
    success = await turn_registry.interrupt_turn(turn_id)
    return {"turn_id": turn_id, "status": "interrupted" if success else "not_running"}

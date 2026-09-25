"""Terminal and tmux session management over WebSocket and REST."""

import asyncio
import codecs
import collections
import contextlib
import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import termios
from pathlib import Path
from typing import Optional

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    WebSocket,
    WebSocketDisconnect,
)
from pydantic import BaseModel

from darjeeling_server.agents import AGENTS
from darjeeling_server.auth import require_auth, unregister_ws, ws_auth
from darjeeling_server.config import (
    DARJEELING_TMUX_SOCKET,
    DEFAULT_COLS,
    DEFAULT_ROWS,
    DEFAULT_SESSION,
    TMUX_TMPDIR,
    VAULT_PATH,
    child_env,
    log,
)

router = APIRouter(tags=["terminal"])

MAX_INPUT_BYTES = 64 * 1024
# PTY output buffered per terminal socket before the reader is paused.
MAX_OUTPUT_BUFFER_BYTES = 1024 * 1024
PTY_READ_CHUNK = 65536


def sanitize_session_name(name: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_\-]", "_", name).strip("_")
    return cleaned or "darjeeling"


def set_pty_size(fd: int, rows: int, cols: int) -> None:
    with contextlib.suppress(Exception):
        fcntl.ioctl(
            fd, termios.TIOCSWINSZ, struct.pack("HHHH", max(1, rows), max(1, cols), 0, 0)
        )


def tmux(*args: str, timeout: int = 10) -> subprocess.CompletedProcess:
    """Run tmux with DARJEELING_TMUX_SOCKET and TMUX_TMPDIR (ADR-15)."""
    # The tmux server inherits this env and hands it to every shell/agent it
    # spawns, so it must never carry DARJEELING_* or DEEPSEEK_API_KEY.
    env = child_env()
    if TMUX_TMPDIR:
        env["TMUX_TMPDIR"] = TMUX_TMPDIR
    cmd = ["tmux", "-L", DARJEELING_TMUX_SOCKET, *args]
    return subprocess.run(
        cmd, capture_output=True, text=True, check=False, timeout=timeout, env=env
    )


def pty_open() -> tuple[int, int]:
    master_fd, slave_fd = pty.openpty()
    flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
    fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
    return master_fd, slave_fd


def _make_controlling_tty(slave_fd: int):
    """Set process session leader and assign controlling terminal (SRV-06)."""
    def _fn():
        os.setsid()
        with contextlib.suppress(Exception):
            fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
    return _fn


def _write_all(fd: int, data: bytes) -> None:
    """Write all bytes to fd with backpressure handling (SRV-11)."""
    total = len(data)
    sent = 0
    while sent < total:
        try:
            n = os.write(fd, data[sent:])
            sent += n
        except (BlockingIOError, InterruptedError):
            _, w, _ = select.select([], [fd], [], 1.0)
            if not w:
                break
        except OSError:
            break


class BoundedPtyReader:
    """
    Reads a non-blocking fd into a byte-bounded buffer with backpressure.

    When more than `max_bytes` are buffered (the websocket is slower than
    the PTY), the fd is removed from the event loop until the consumer
    drains below half the limit. The kernel PTY buffer then fills and the
    writer (tmux) blocks, instead of the server growing without bound.
    """

    def __init__(self, loop: asyncio.AbstractEventLoop, fd: int, max_bytes: int = MAX_OUTPUT_BUFFER_BYTES):
        self.loop = loop
        self.fd = fd
        self.max_bytes = max_bytes
        self.buf: collections.deque = collections.deque()
        self.buffered = 0
        self.eof = False
        self.reading = False
        self._wake = asyncio.Event()

    @property
    def paused(self) -> bool:
        return not self.reading and not self.eof

    def start(self) -> None:
        self._resume()

    def _resume(self) -> None:
        if not self.reading and not self.eof:
            self.reading = True
            self.loop.add_reader(self.fd, self._on_readable)

    def _pause(self) -> None:
        if self.reading:
            self.reading = False
            with contextlib.suppress(Exception):
                self.loop.remove_reader(self.fd)

    def close(self) -> None:
        self._pause()
        self.eof = True
        self._wake.set()

    def _on_readable(self) -> None:
        if self.buffered >= self.max_bytes:
            self._pause()
            return
        try:
            data = os.read(self.fd, PTY_READ_CHUNK)
        except (BlockingIOError, InterruptedError):
            return
        except OSError:
            self.close()
            return
        if not data:
            self.close()
            return
        self.buf.append(data)
        self.buffered += len(data)
        self._wake.set()
        if self.buffered >= self.max_bytes:
            self._pause()

    async def get(self) -> Optional[bytes]:
        """Next chunk, or None once the fd hit EOF and the buffer is empty."""
        while not self.buf and not self.eof:
            self._wake.clear()
            await self._wake.wait()
        if not self.buf:
            return None
        chunk = self.buf.popleft()
        self.buffered -= len(chunk)
        if self.buffered <= self.max_bytes // 2:
            self._resume()
        return chunk


async def write_to_pty(fd: int, data: bytes) -> None:
    if len(data) > MAX_INPUT_BYTES:
        data = data[:MAX_INPUT_BYTES]
    await asyncio.to_thread(_write_all, fd, data)


class CreateSessionRequest(BaseModel):
    name: str
    agent: Optional[str] = "bash"
    cwd: Optional[str] = None


class SendInputRequest(BaseModel):
    text: str
    press_enter: Optional[bool] = True


@router.get("/api/sessions", dependencies=[Depends(require_auth)])
async def list_sessions():
    res = tmux(
        "list-sessions",
        "-F",
        "#{session_name}|#{session_created}|#{session_attached}|#{session_windows}",
    )
    sessions = []
    if res.returncode == 0 and res.stdout.strip():
        for line in res.stdout.strip().splitlines():
            parts = line.split("|")
            if len(parts) < 4:
                continue
            name, created, attached, windows = parts[:4]
            cmd, path = "bash", str(VAULT_PATH)
            pane = tmux(
                "list-panes", "-t", f"={name}", "-F", "#{pane_current_command}|#{pane_current_path}"
            )
            if pane.returncode == 0 and pane.stdout.strip():
                bits = pane.stdout.strip().splitlines()[0].split("|")
                if len(bits) >= 2:
                    cmd, path = bits[0], bits[1]
            sessions.append(
                {
                    "name": name,
                    "command": cmd,
                    "cwd": path,
                    "attached": attached == "1",
                    "windows": int(windows) if windows.isdigit() else 1,
                    "created": int(created) if created.isdigit() else 0,
                }
            )
    return {"sessions": sessions}


@router.post("/api/sessions", dependencies=[Depends(require_auth)])
async def create_session(req: CreateSessionRequest):
    name = sanitize_session_name(req.name)
    cwd = Path(req.cwd).expanduser() if req.cwd else VAULT_PATH
    if not cwd.is_dir():
        # Fall back to the vault, never to $HOME (which holds ~/.claude,
        # SSH keys and the rest of the account).
        cwd = VAULT_PATH
    if not cwd.is_dir():
        raise HTTPException(
            status_code=400,
            detail=f"Working directory does not exist: {req.cwd or cwd}",
        )

    if tmux("has-session", "-t", f"={name}").returncode == 0:
        return {"status": "exists", "name": name}

    requested = (req.agent or "bash").lower()
    if requested in AGENTS:
        spec = AGENTS[requested]
        # Reject API agents for interactive tmux sessions (SRV-35)
        if getattr(spec, "is_api", False):
            raise HTTPException(
                status_code=400,
                detail=f"Cannot spawn a terminal session for API agent '{requested}'.",
            )
        if not spec.available:
            raise HTTPException(
                status_code=503,
                detail=f"{spec.label} is not installed on the host ({spec.binary} not on PATH).",
            )
        command = spec.binary
    else:
        command = "bash"

    res = tmux(
        "new-session", "-d", "-s", name,
        "-x", str(DEFAULT_COLS), "-y", str(DEFAULT_ROWS),
        "-c", str(cwd), command,
    )
    if res.returncode != 0:
        raise HTTPException(status_code=500, detail=res.stderr.strip())

    # Confirm session actually survived (e.g. command didn't exit immediately)
    await asyncio.sleep(0.4)
    if tmux("has-session", "-t", f"={name}").returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=f"Session '{name}' exited immediately -- '{command}' failed to start.",
        )
    return {"status": "created", "name": name, "command": command, "cwd": str(cwd)}


@router.delete("/api/sessions/{session_name}", dependencies=[Depends(require_auth)])
async def delete_session(session_name: str):
    name = sanitize_session_name(session_name)
    res = tmux("kill-session", "-t", f"={name}")
    if res.returncode != 0:
        return {"status": "not_found", "message": res.stderr.strip()}
    return {"status": "killed", "name": name}


@router.post("/api/sessions/{session_name}/send", dependencies=[Depends(require_auth)])
async def send_to_session(session_name: str, req: SendInputRequest):
    """
    Keystrokes into a tmux pane with '--' before text and returncode check (SRV-09, SRV-33).
    """
    name = sanitize_session_name(session_name)
    if tmux("has-session", "-t", f"={name}").returncode != 0:
        raise HTTPException(status_code=404, detail="No such session")

    res = tmux("send-keys", "-t", f"={name}:", "-l", "--", req.text)
    if res.returncode != 0:
        raise HTTPException(status_code=500, detail=res.stderr.strip() or "Failed to send keystrokes")

    if req.press_enter:
        res_enter = tmux("send-keys", "-t", f"={name}:", "C-m")
        if res_enter.returncode != 0:
            raise HTTPException(status_code=500, detail=res_enter.stderr.strip() or "Failed to send enter")

    return {"status": "sent", "name": name}


@router.websocket("/ws/terminal")
async def terminal_channel(
    websocket: WebSocket,
    session: Optional[str] = Query(None),
):
    """
    Interactive terminal WebSocket channel (SRV-02, SRV-06, SRV-11, SRV-12, SRV-36, QA-07, VTH-10, VTH-11).
    """
    allowed, subprotocol = ws_auth(websocket)
    if not allowed:
        log.warning("Rejected /ws/terminal from %s", websocket.client.host if websocket.client else "unknown")
        await websocket.accept()
        await websocket.close(code=4401, reason="token rejected")
        return

    await websocket.accept(subprotocol=subprotocol)
    name = sanitize_session_name(session or DEFAULT_SESSION)
    cwd = VAULT_PATH if VAULT_PATH.is_dir() else Path.home()

    if tmux("has-session", "-t", f"={name}").returncode != 0:
        log.info("Spawning shell session '%s' in %s", name, cwd)
        tmux(
            "new-session", "-d", "-s", name,
            "-x", str(DEFAULT_COLS), "-y", str(DEFAULT_ROWS),
            "-c", str(cwd), "bash",
        )

    master_fd, slave_fd = pty_open()
    set_pty_size(master_fd, DEFAULT_ROWS, DEFAULT_COLS)

    env = child_env()
    if TMUX_TMPDIR:
        env["TMUX_TMPDIR"] = TMUX_TMPDIR
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    env.setdefault("LANG", "en_US.UTF-8")

    proc = await asyncio.create_subprocess_exec(
        "tmux", "-L", DARJEELING_TMUX_SOCKET, "attach-session", "-t", f"={name}",
        stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
        preexec_fn=_make_controlling_tty(slave_fd), env=env,
    )
    os.close(slave_fd)

    loop = asyncio.get_running_loop()
    reader = BoundedPtyReader(loop, master_fd)
    reader.start()

    async def monitor_proc() -> None:
        with contextlib.suppress(Exception):
            await proc.wait()
            # Let the reader drain what tmux wrote before it exited.
            await asyncio.sleep(0.05)
            reader.close()

    proc_monitor = asyncio.create_task(monitor_proc())

    # Incremental UTF-8 decoder buffers incomplete multi-byte code points (SRV-12, VTH-11)
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    shell_ended = False

    async def pump_out() -> None:
        nonlocal shell_ended
        while True:
            chunk = await reader.get()
            if chunk is None:
                shell_ended = True
                break
            text = decoder.decode(chunk, final=False)
            if text:
                await websocket.send_text(text)
        tail = decoder.decode(b"", final=True)
        if tail:
            with contextlib.suppress(Exception):
                await websocket.send_text(tail)
        with contextlib.suppress(Exception):
            await websocket.close(code=4000, reason="shell ended")

    pump = asyncio.create_task(pump_out())

    try:
        while True:
            msg = await websocket.receive_text()
            if msg.startswith("{") and msg.endswith("}"):
                try:
                    payload = json.loads(msg)
                except json.JSONDecodeError:
                    payload = None
                if isinstance(payload, dict):
                    kind = payload.get("type")
                    if kind == "resize":
                        try:
                            rows = max(1, min(500, int(payload.get("rows", DEFAULT_ROWS))))
                            cols = max(1, min(1000, int(payload.get("cols", DEFAULT_COLS))))
                            set_pty_size(master_fd, rows, cols)
                            # Ensure resize reaches tmux client
                            tmux("refresh-client", "-C", f"{cols},{rows}")
                        except (ValueError, TypeError):
                            pass
                        continue
                    elif kind == "input":
                        input_text = payload.get("data")
                        if isinstance(input_text, str):
                            await write_to_pty(master_fd, input_text.encode("utf-8", errors="replace"))
                        continue

            # Raw text input fallback
            await write_to_pty(master_fd, msg.encode("utf-8", errors="replace"))
    except (WebSocketDisconnect, ConnectionResetError):
        pass
    except Exception as err:
        log.warning("Terminal channel error: %s", err)
    finally:
        unregister_ws(websocket)
        reader.close()
        proc_monitor.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await pump
        with contextlib.suppress(OSError):
            os.close(master_fd)

        if proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=2)
            except asyncio.TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()

        if shell_ended:
            with contextlib.suppress(Exception):
                await websocket.close(code=4000, reason="shell ended")

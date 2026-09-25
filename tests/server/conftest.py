"""
Fixtures for the Darjeeling server smoke suite.

Every test talks to a real `python server/server.py` process bound to
127.0.0.1 on a free port, with everything that could touch a real machine
redirected into one throwaway directory:

  HOME          -> <root>/home      (no ~/.claude, no ~/.local/bin lookups)
  TMUX_TMPDIR   -> <root>/tmux      (private tmux server, never the host's)
  vault         -> <root>/vault
  PATH          -> tests/fakes/bin first, so `claude` and `agy` are the fakes
  DeepSeek      -> a local fake SSE endpoint, fake key

Runs the same on the Mac, in the lab CI container, or anywhere with Python
3.9+ and server/requirements.txt installed.
"""

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
import pytest
from websockets.sync.client import connect

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))
if str(REPO / "server") not in sys.path:
    sys.path.insert(0, str(REPO / "server"))

# In-process imports of darjeeling_server.config resolve STATE_DIR and mint a
# token at import time; keep that out of the developer's real ~/.local/state.
if not os.environ.get("DARJEELING_STATE_DIR"):
    import tempfile as _tempfile

    os.environ["DARJEELING_STATE_DIR"] = _tempfile.mkdtemp(prefix="djstate")

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
pytest_plugins = [
    f"tests.server.fixtures.{p.stem}"
    for p in sorted(FIXTURES_DIR.glob("*.py"))
    if p.stem != "__init__" and not p.name.startswith(".")
]

SERVER_PY = REPO / "server" / "server.py"
FAKES_BIN = REPO / "tests" / "fakes" / "bin"
TOKEN = "lab-token-" + uuid.uuid4().hex


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def make_root() -> Path:
    # Hex-only name on purpose: Claude Code slugs every non-alphanumeric path
    # character to '-', so the tests control exactly which characters appear.
    root = Path("/tmp") / ("djlab" + uuid.uuid4().hex[:12])
    root.mkdir(parents=True)
    return root.resolve()


# --------------------------------------------------------------------------
# Fake DeepSeek (OpenAI-compatible chat completions, SSE)
# --------------------------------------------------------------------------

class FakeDeepSeek:
    def __init__(self) -> None:
        self.requests: List[Dict[str, Any]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # silence
                pass

            def do_POST(self):
                length = int(self.headers.get("content-length", "0"))
                body = json.loads(self.rfile.read(length) or b"{}")
                outer.requests.append({"path": self.path, "auth": self.headers.get("authorization"), "body": body})
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.end_headers()
                for piece in ("Hello ", "from fake DeepSeek."):
                    chunk = {"choices": [{"delta": {"content": piece}}]}
                    self.wfile.write(("data: %s\n\n" % json.dumps(chunk)).encode())
                    self.wfile.flush()
                usage = {"choices": [{"delta": {}}], "usage": {"prompt_tokens": 11, "completion_tokens": 4}}
                self.wfile.write(("data: %s\n\n" % json.dumps(usage)).encode())
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()

        self.port = free_port()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", self.port), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.httpd.shutdown()


# --------------------------------------------------------------------------
# Server under test
# --------------------------------------------------------------------------

@dataclass
class Server:
    root: Path
    port: int
    token: str
    vault: Path
    log_path: Path
    argv_log: Path
    proc: subprocess.Popen
    env: Dict[str, str] = field(default_factory=dict)
    deepseek: Optional[FakeDeepSeek] = None
    state_dir: Optional[Path] = None

    @property
    def base(self) -> str:
        return "http://127.0.0.1:%d" % self.port

    @property
    def ws_base(self) -> str:
        return "ws://127.0.0.1:%d" % self.port

    def headers(self) -> Dict[str, str]:
        return {"Authorization": "Bearer " + self.token}

    def get(self, path: str, **kw) -> httpx.Response:
        kw.setdefault("headers", self.headers())
        return httpx.get(self.base + path, timeout=30, **kw)

    def post(self, path: str, body: Any, **kw) -> httpx.Response:
        kw.setdefault("headers", self.headers())
        return httpx.post(self.base + path, json=body, timeout=60, **kw)

    def log_text(self) -> str:
        return self.log_path.read_text(errors="replace") if self.log_path.exists() else ""

    def argv_calls(self) -> List[Dict[str, Any]]:
        if not self.argv_log.exists():
            return []
        return [json.loads(l) for l in self.argv_log.read_text().splitlines() if l.strip()]

    def active_turns(self) -> int:
        return self.get("/api/host/status").json()["agents"]["activeTurns"]

    def wait_idle(self, timeout: float = 8.0) -> int:
        deadline = time.time() + timeout
        n = self.active_turns()
        while n and time.time() < deadline:
            time.sleep(0.25)
            n = self.active_turns()
        return n


def start_server(root: Path, extra_env: Optional[Dict[str, str]] = None, with_token: bool = True,
                 deepseek: Optional[FakeDeepSeek] = None) -> Server:
    home = root / "home"
    vault = root / "vault"
    tmux_dir = root / "tmux"
    for d in (home, vault, tmux_dir):
        d.mkdir(parents=True, exist_ok=True)
    (vault / "README.md").write_text("# Test vault\n\nHello.\n")
    port = free_port()
    log_path = root / "server.log"
    argv_log = root / "argv.log"
    env = {
        "PATH": "%s:/usr/local/bin:/usr/bin:/bin" % FAKES_BIN,
        "HOME": str(home),
        "LANG": "C.UTF-8",
        "PYTHONUNBUFFERED": "1",
        "TMUX_TMPDIR": str(tmux_dir),
        "DARJEELING_HOST": "127.0.0.1",
        "DARJEELING_PORT": str(port),
        "DARJEELING_VAULT": str(vault),
        "DARJEELING_STATE_DIR": str(root / "state"),
        "DARJEELING_TOKEN_FILE": str(root / "token"),
        "DARJEELING_MAX_CONCURRENT_TURNS": "2",
        "DARJEELING_TURN_TIMEOUT": "60",
        "FAKE_AGENT_ARGV_LOG": str(argv_log),
        "FAKE_AGENT_TRANSCRIPTS": "1",
    }
    if with_token:
        env["DARJEELING_TOKEN"] = TOKEN
    if deepseek is not None:
        env["DEEPSEEK_API_KEY"] = "fake-deepseek-key"
        env["DEEPSEEK_BASE_URL"] = "http://127.0.0.1:%d" % deepseek.port
    env.update(extra_env or {})

    log_fh = log_path.open("wb")
    env["PYTHONPATH"] = str(REPO / "server") + (
        os.pathsep + env["PYTHONPATH"] if "PYTHONPATH" in env else ""
    )
    proc = subprocess.Popen(
        [sys.executable, "-m", "darjeeling_server"], env=env, cwd=str(root),
        stdout=log_fh, stderr=subprocess.STDOUT, start_new_session=True,
    )
    base = "http://127.0.0.1:%d" % port
    deadline = time.time() + 30
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("server exited early:\n" + log_path.read_text(errors="replace"))
        try:
            if httpx.get(base + "/health", timeout=1).status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.2)
    else:
        proc.kill()
        raise RuntimeError("server did not come up:\n" + log_path.read_text(errors="replace"))

    token = TOKEN if with_token else (root / "token").read_text().strip()
    return Server(root=root, port=port, token=token, vault=vault, log_path=log_path,
                  argv_log=argv_log, proc=proc, env=env, deepseek=deepseek, state_dir=root / "state")


def stop_server(srv: Server) -> None:
    with_pg = True
    try:
        os.killpg(srv.proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        with_pg = False
    try:
        srv.proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        if with_pg:
            os.killpg(srv.proc.pid, signal.SIGKILL)
    if shutil.which("tmux"):
        subprocess.run(["tmux", "kill-server"], env={**srv.env}, capture_output=True, check=False)


@pytest.fixture(scope="session")
def server():
    root = make_root()
    ds = FakeDeepSeek()
    srv = start_server(root, deepseek=ds)
    yield srv
    stop_server(srv)
    ds.close()
    shutil.rmtree(root, ignore_errors=True)


@pytest.fixture()
def fresh_root():
    root = make_root()
    yield root
    shutil.rmtree(root, ignore_errors=True)


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


def types(events, include_dj_turn: bool = False) -> List[str]:
    out = []
    for e in events:
        t = e.get("type")
        if t == "dj.turn" and not include_dj_turn:
            continue
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


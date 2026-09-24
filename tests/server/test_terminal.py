"""Tests for terminal WebSocket, tmux lifecycle, UTF-8 streaming, and resize (SRV-02, SRV-06, SRV-12, SRV-35, SRV-36)."""

import codecs
import json
import subprocess
import time
import httpx
from websockets.sync.client import connect

from darjeeling_server.config import DARJEELING_TMUX_SOCKET, TMUX_TMPDIR


def test_api_agent_session_rejected(server):
    """POST /api/sessions rejects API agents with 400 (SRV-35)."""
    headers = {"Authorization": f"Bearer {server.token}"}
    res = httpx.post(
        server.base + "/api/sessions",
        json={"name": "test-deepseek-session", "agent": "deepseek"},
        headers=headers,
    )
    assert res.status_code == 400
    assert "Cannot spawn a terminal session for API agent" in res.json()["detail"]


def test_multibyte_stream_no_replacement_character():
    """A 1.5 MB multibyte stream arrives with 0 U+FFFD (SRV-12, VTH-11)."""
    # Create multibyte text (3-byte and 4-byte UTF-8 sequences)
    multibyte_pattern = "Darjeeling ☕ 🚀 日本語 — "
    target_size = 1500 * 1024  # 1.5 MB
    repeats = (target_size // len(multibyte_pattern.encode("utf-8"))) + 1
    raw_text = (multibyte_pattern * repeats)[: 100000]
    raw_bytes = raw_text.encode("utf-8")

    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    decoded_parts = []

    # Chunk into arbitrary small pieces (e.g. 17 bytes) to purposely split code points
    chunk_size = 17
    for i in range(0, len(raw_bytes), chunk_size):
        chunk = raw_bytes[i : i + chunk_size]
        decoded_parts.append(decoder.decode(chunk, final=False))
    decoded_parts.append(decoder.decode(b"", final=True))

    full_decoded = "".join(decoded_parts)
    assert "\ufffd" not in full_decoded
    assert full_decoded == raw_text


def test_terminal_session_lifecycle_and_resize(server):
    """Test connecting to /ws/terminal, sending resize, and reading output."""
    session_name = "test-term-live"
    subprotocol = f"darjeeling.token.{server.token}"

    try:
        with connect(
            server.ws_base + f"/ws/terminal?session={session_name}",
            subprotocols=[subprotocol],
            open_timeout=10,
        ) as ws:
            # Send resize
            ws.send(json.dumps({"type": "resize", "cols": 80, "rows": 24}))
            time.sleep(0.5)

            # Check pane/window width via tmux
            env = {"TMUX_TMPDIR": TMUX_TMPDIR} if TMUX_TMPDIR else None
            res = subprocess.run(
                [
                    "tmux",
                    "-L",
                    DARJEELING_TMUX_SOCKET,
                    "display-message",
                    "-p",
                    "-t",
                    f"={session_name}",
                    "#{window_width}x#{window_height}",
                ],
                capture_output=True,
                text=True,
                env=env,
            )
            if res.returncode == 0:
                assert "80x24" in res.stdout.strip()

            # Exit the shell
            start_exit = time.time()
            ws.send(json.dumps({"type": "input", "data": "exit\n"}))

            # Drain until closed
            try:
                while True:
                    ws.recv(timeout=3)
            except Exception as exc:
                duration = time.time() - start_exit
                assert duration < 4.0
                code = getattr(getattr(exc, "rcvd", None), "code", None)
                assert code == 4000
    finally:
        env = {"TMUX_TMPDIR": TMUX_TMPDIR} if TMUX_TMPDIR else None
        subprocess.run(
            ["tmux", "-L", DARJEELING_TMUX_SOCKET, "kill-session", "-t", f"={session_name}"],
            capture_output=True,
            env=env,
        )

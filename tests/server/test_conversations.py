"""Tests for conversation history discovery, slugging, and reading."""

from pathlib import Path

from darjeeling_server.conversations import project_store
from tests.server.conftest import run_turn, ws_open


def test_project_store_slugging():
    """Verify that project_store matches Claude Code's slugging regex [^A-Za-z0-9] -> '-'."""
    p1 = Path("/home/testuser/My Vault (Work)")
    slug1 = project_store(p1).name
    # All non-alphanumeric chars become '-'
    assert "." not in slug1
    assert " " not in slug1
    assert "(" not in slug1
    assert ")" not in slug1
    assert slug1 == "-home-testuser-My-Vault--Work-"


def test_conversation_listing_and_read(server):
    """Test creating a conversation, listing it, and reading its message content."""
    cwd = server.root / "work_vault"
    cwd.mkdir(parents=True, exist_ok=True)
    with ws_open(server) as ws:
        events = run_turn(ws, {"agent": "claude", "prompt": "test conv", "cwd": str(cwd)})
    sid = events[-1]["sessionId"]
    assert sid

    # List conversations
    r = server.get("/api/agent/conversations", params={"cwd": str(cwd)})
    assert r.status_code == 200
    convs = r.json().get("conversations", [])
    matching = [c for c in convs if c["sessionId"] == sid]
    assert len(matching) == 1

    # Read specific conversation
    r2 = server.get(f"/api/agent/conversations/{sid}", params={"cwd": str(cwd)})
    assert r2.status_code == 200
    data = r2.json()
    assert data["sessionId"] == sid
    assert "messages" in data
    assert len(data["messages"]) > 0


def test_conversation_fallback_glob(server):
    """Test reading a conversation using glob fallback when cwd is different or omitted."""
    cwd = server.root / "vault_a"
    cwd.mkdir(parents=True, exist_ok=True)
    with ws_open(server) as ws:
        events = run_turn(ws, {"agent": "claude", "prompt": "glob test", "cwd": str(cwd)})
    sid = events[-1]["sessionId"]
    assert sid

    # Read conversation with a completely different cwd; glob fallback across projects finds it
    other_cwd = server.root / "other_vault"
    r = server.get(f"/api/agent/conversations/{sid}", params={"cwd": str(other_cwd)})
    assert r.status_code == 200
    assert r.json()["sessionId"] == sid

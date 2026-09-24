"""Tests for vault sync, hash conflict detection, and data safety (SRV-05, G-30, ADR-13)."""

import concurrent.futures
import hashlib
from pathlib import Path


def test_sync_file_create_and_update(server):
    """Test initial sync creates file and subsequent sync with matching base_sha256 updates it."""
    # 1. Fresh file creation
    res1 = server.post("/api/vault/sync/file", {
        "path": "Research/Notes.md",
        "content": "# Research\nInitial thoughts.",
    })
    assert res1.status_code == 200
    data1 = res1.json()
    assert data1["status"] == "synced"
    assert data1["path"] == "Research/Notes.md"
    sha1 = data1["sha256"]
    assert sha1 == hashlib.sha256(b"# Research\nInitial thoughts.").hexdigest()

    # Verify on host
    host_file = server.vault / "Research" / "Notes.md"
    assert host_file.is_file()
    assert host_file.read_text(encoding="utf-8") == "# Research\nInitial thoughts."

    # 2. Update with valid base_sha256
    res2 = server.post("/api/vault/sync/file", {
        "path": "Research/Notes.md",
        "content": "# Research\nUpdated thoughts.",
        "base_sha256": sha1,
    })
    assert res2.status_code == 200
    data2 = res2.json()
    assert data2["sha256"] == hashlib.sha256(b"# Research\nUpdated thoughts.").hexdigest()
    assert host_file.read_text(encoding="utf-8") == "# Research\nUpdated thoughts."


def test_sync_file_stale_base_returns_409(server):
    """Stale base_sha256 returns 409 conflict and leaves host file unchanged (G-30, SRV-05)."""
    # Create file
    initial_content = "# Protected Note\nOriginal text."
    res1 = server.post("/api/vault/sync/file", {
        "path": "Protected.md",
        "content": initial_content,
    })
    assert res1.status_code == 200
    host_file = server.vault / "Protected.md"
    assert host_file.read_text(encoding="utf-8") == initial_content

    # Attempt to overwrite with stale base hash
    wrong_sha = "0000000000000000000000000000000000000000000000000000000000000000"
    res2 = server.post("/api/vault/sync/file", {
        "path": "Protected.md",
        "content": "Malicious or stale overwrite attempt.",
        "base_sha256": wrong_sha,
    })
    assert res2.status_code == 409
    data2 = res2.json()
    assert data2["error"] == "conflict"
    expected_host_sha = hashlib.sha256(initial_content.encode("utf-8")).hexdigest()
    assert data2["host_sha256"] == expected_host_sha
    assert "host_mtime" in data2

    # CRITICAL: Host file must remain completely unchanged!
    assert host_file.read_text(encoding="utf-8") == initial_content


def test_sync_file_protected_directories_refused(server):
    """Writing to .obsidian, .git, .claude or .trash is strictly forbidden (403)."""
    forbidden_paths = [
        ".obsidian/plugins/x/main.js",
        ".obsidian/config",
        ".git/HEAD",
        ".git/config",
        ".claude/settings.json",
        ".trash/deleted.md",
    ]
    for path in forbidden_paths:
        res = server.post("/api/vault/sync/file", {
            "path": path,
            "content": "alert('hacked')",
        })
        assert res.status_code == 403, f"Expected 403 for {path}, got {res.status_code}"


def test_sync_file_binary_refused(server):
    """Binary files and binary content are refused (400)."""
    # Binary extension
    res1 = server.post("/api/vault/sync/file", {
        "path": "images/photo.png",
        "content": "not really png text",
    })
    assert res1.status_code == 400

    # Content with null bytes
    res2 = server.post("/api/vault/sync/file", {
        "path": "Notes/bad.md",
        "content": "hello \x00 world",
    })
    assert res2.status_code == 400


def test_sync_file_concurrent_writes_atomic(server):
    """Concurrent writes never produce a partial or corrupted file."""
    path = "Concurrent/test.md"
    versions = [f"Content version {i:04d}\n" + ("x" * 2000) for i in range(20)]

    def write_version(content: str):
        return server.post("/api/vault/sync/file", {"path": path, "content": content})

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        futures = [executor.submit(write_version, v) for v in versions]
        for f in concurrent.futures.as_completed(futures):
            res = f.result()
            assert res.status_code in (200, 409)

    host_file = server.vault / "Concurrent" / "test.md"
    assert host_file.is_file()
    final_content = host_file.read_text(encoding="utf-8")

    # Content must match exactly one of the versions, never a partial blend
    assert final_content in versions

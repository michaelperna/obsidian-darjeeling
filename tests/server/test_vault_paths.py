"""Tests for vault safe_join and path traversal security (SRV-19, SRV-20, SRV-34)."""

import pytest
from fastapi import HTTPException
from pathlib import Path

from darjeeling_server.vault import safe_join


def test_safe_join_valid(tmp_path: Path):
    vault = tmp_path / "vault"
    vault.mkdir()
    note = vault / "Notes" / "test.md"
    note.parent.mkdir()
    note.write_text("hello")

    target = safe_join(vault, "Notes/test.md")
    assert target == note.resolve()


def test_safe_join_empty_path(tmp_path: Path):
    vault = tmp_path / "vault"
    vault.mkdir()
    for empty in ["", "   ", "\t"]:
        with pytest.raises(HTTPException) as exc:
            safe_join(vault, empty)
        assert exc.value.status_code == 400


def test_safe_join_absolute_path(tmp_path: Path):
    vault = tmp_path / "vault"
    vault.mkdir()
    for abs_path in ["/etc/passwd", "/tmp/secret", "\\Windows\\System32"]:
        with pytest.raises(HTTPException) as exc:
            safe_join(vault, abs_path)
        assert exc.value.status_code == 400


def test_safe_join_escaping_root(tmp_path: Path):
    vault = tmp_path / "vault"
    vault.mkdir()
    for escape in ["../secret.md", "sub/../../secret.md", ".."]:
        with pytest.raises(HTTPException) as exc:
            safe_join(vault, escape)
        assert exc.value.status_code == 400


def test_safe_join_forbidden_meta_directories(tmp_path: Path):
    vault = tmp_path / "vault"
    vault.mkdir()
    forbidden = [
        ".obsidian",
        ".obsidian/app.json",
        ".obsidian/plugins/evil.js",
        ".git",
        ".git/config",
        ".trash",
        ".trash/deleted.md",
        ".claude",
        ".claude/settings.json",
    ]
    for path in forbidden:
        with pytest.raises(HTTPException) as exc:
            safe_join(vault, path)
        assert exc.value.status_code == 403


def test_vault_endpoint_path_safety(server):
    import httpx

    headers = {"Authorization": f"Bearer {server.token}"}

    # Absolute path rejected
    res = httpx.get(server.base + "/api/vault/file", params={"path": "/etc/passwd"}, headers=headers)
    assert res.status_code == 400

    # Escaping path rejected
    res = httpx.get(server.base + "/api/vault/file", params={"path": "../outside.md"}, headers=headers)
    assert res.status_code == 400

    # Protected meta directory forbidden
    res = httpx.get(server.base + "/api/vault/file", params={"path": ".obsidian/app.json"}, headers=headers)
    assert res.status_code == 403

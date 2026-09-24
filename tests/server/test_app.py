"""Tests for app configuration, /health data minimization, docs disabling, and CORS."""

import os
import time
import httpx
from darjeeling_server.config import child_env, VERSION


def test_docs_and_openapi_disabled(server):
    for endpoint in ["/docs", "/redoc", "/openapi.json"]:
        res = httpx.get(server.base + endpoint, timeout=5)
        assert res.status_code == 404, f"{endpoint} should return 404 Not Found"


def test_health_response_data_minimization(server):
    res = httpx.get(server.base + "/health", timeout=5)
    assert res.status_code == 200
    data = res.json()
    assert set(data.keys()) == {"status", "version", "api", "api_min", "auth_required"}
    assert data["status"] == "online"
    assert data["version"] == VERSION
    assert data["api"] == 2
    assert data["api_min"] == 2
    assert data["auth_required"] is True


def test_cors_origin_allowlist(server):
    # Allowed origin
    res = httpx.get(
        server.base + "/health",
        headers={"Origin": "app://obsidian.md"},
        timeout=5,
    )
    assert res.headers.get("access-control-allow-origin") == "app://obsidian.md"

    # Disallowed external origin
    res_bad = httpx.get(
        server.base + "/health",
        headers={"Origin": "https://malicious.example.com"},
        timeout=5,
    )
    assert res_bad.headers.get("access-control-allow-origin") != "https://malicious.example.com"


def test_query_path_not_in_access_log(server):
    """With default config, note path in query leaves no path in captured log (G-34)."""
    headers = {"Authorization": f"Bearer {server.token}"}
    secret_path = "Private_Secret_Note_xyz987.md"
    before = len(server.log_text())
    httpx.get(
        server.base + f"/api/vault/file?path={secret_path}",
        headers=headers,
        timeout=5,
    )
    time.sleep(0.3)
    new_logs = server.log_text()[before:]
    assert secret_path not in new_logs


def test_child_env_contract():
    base = {
        "DARJEELING_TOKEN": "secret123",
        "DARJEELING_STATE_DIR": "/var/lib/darjeeling",
        "DEEPSEEK_API_KEY": "sk-deepseek-secret",
        "ANTHROPIC_API_KEY": "sk-ant-valid-key",
        "PATH": "/usr/bin:/bin",
        "USER": "darjeeling",
    }
    cleaned = child_env(base)
    assert "DARJEELING_TOKEN" not in cleaned
    assert "DARJEELING_STATE_DIR" not in cleaned
    assert "DEEPSEEK_API_KEY" not in cleaned
    assert cleaned["ANTHROPIC_API_KEY"] == "sk-ant-valid-key"
    assert cleaned["USER"] == "darjeeling"
    # PATH additions appended, never prepended
    assert cleaned["PATH"].startswith("/usr/bin:/bin")

"""
Pairing hardening: failed claims are limited per client address and never
burn other clients' live codes; unreadable pairing state is logged.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import httpx
import pytest

from tests.server.conftest import REPO, start_server, stop_server


@pytest.fixture()
def limited_server(fresh_root):
    srv = start_server(
        fresh_root,
        extra_env={
            "DARJEELING_PAIR_MAX_FAILURES_PER_CLIENT": "3",
            "DARJEELING_PAIR_MAX_FAILURES_GLOBAL": "50",
        },
    )
    yield srv
    stop_server(srv)


def _new_code(srv) -> str:
    res = httpx.post(f"{srv.base}/api/pair/code", headers=srv.headers())
    assert res.status_code == 200, res.text
    return res.json()["code"]


def _claim(srv, code: str, client_ip: str) -> httpx.Response:
    # The server trusts X-Forwarded-For only from a loopback peer (a local
    # reverse proxy such as Tailscale Serve), which is what the tests are.
    return httpx.post(
        f"{srv.base}/api/pair",
        json={"code": code, "device_name": "Test"},
        headers={"X-Forwarded-For": client_ip},
    )


def _wrong(code: str) -> str:
    return "%08d" % ((int(code) + 1) % 100000000)


def test_failures_do_not_burn_other_clients_codes(limited_server):
    srv = limited_server
    code = _new_code(srv)

    for _ in range(3):
        assert _claim(srv, _wrong(code), "10.0.0.1").status_code == 401

    # The failing client is now locked out, even with a correct code.
    locked = _claim(srv, code, "10.0.0.1")
    assert locked.status_code == 429
    assert "retry-after" in {k.lower() for k in locked.headers.keys()}

    # Another client can still use the code: it was not burned.
    ok = _claim(srv, code, "10.0.0.2")
    assert ok.status_code == 200, ok.text
    assert ok.json()["token"]


def test_pairing_file_has_no_attempt_side_effects(limited_server):
    srv = limited_server
    code = _new_code(srv)
    for _ in range(2):
        assert _claim(srv, _wrong(code), "10.0.0.9").status_code == 401
    codes = json.loads((srv.state_dir / "pairing.json").read_text())
    assert codes and not any(c.get("burned") for c in codes)


def test_success_resets_client_failures(limited_server):
    srv = limited_server
    code = _new_code(srv)
    for _ in range(2):
        assert _claim(srv, _wrong(code), "10.0.0.3").status_code == 401
    assert _claim(srv, code, "10.0.0.3").status_code == 200

    code2 = _new_code(srv)
    for _ in range(2):
        assert _claim(srv, _wrong(code2), "10.0.0.3").status_code == 401
    # Would be the 5th failure without the reset; still allowed.
    assert _claim(srv, code2, "10.0.0.3").status_code == 200


def test_bad_format_counts_as_failure(limited_server):
    srv = limited_server
    for _ in range(3):
        assert _claim(srv, "abc", "10.0.0.4").status_code == 401
    assert _claim(srv, "12345678", "10.0.0.4").status_code == 429


@pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0, reason="root can read any file")
def test_unreadable_pairing_file_is_logged(fresh_root):
    state = fresh_root / "state"
    state.mkdir()
    pairing = state / "pairing.json"
    pairing.write_text("[]")
    pairing.chmod(0)
    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(fresh_root),
        "DARJEELING_STATE_DIR": str(state),
        "DARJEELING_TOKEN": "t" * 32,
        "PYTHONPATH": str(REPO / "server"),
    }
    code = (
        "import logging, sys\n"
        "logging.basicConfig(stream=sys.stderr)\n"
        "from darjeeling_server import pairing\n"
        "assert pairing.load_pairing_codes() == []\n"
    )
    try:
        res = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=30)
    finally:
        pairing.chmod(0o600)
    assert res.returncode == 0, res.stderr
    assert "Cannot read pairing file" in res.stderr
    assert str(Path(pairing)) in res.stderr

"""
CLI: loads the server env file, drops root to the service user for commands
that write server state, keeps secrets out of the env file, reports the real
version.
"""

import importlib.util
import json
import os
import stat
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.server.conftest import REPO

# Load cli.py on its own: importing the darjeeling_server package would import
# config, which resolves (and may mint) a token as a side effect.
_spec = importlib.util.spec_from_file_location(
    "darjeeling_cli_under_test", REPO / "server" / "darjeeling_server" / "cli.py"
)
cli = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cli)


@pytest.fixture()
def clean_environ():
    saved = dict(os.environ)
    yield
    os.environ.clear()
    os.environ.update(saved)
    cli._refresh_paths()


def _write_env(path: Path, state: Path) -> None:
    path.write_text(
        "# test env\n"
        f"DARJEELING_STATE_DIR={state}\n"
        f"DARJEELING_TOKEN_FILE={state}/.token\n"
        "DARJEELING_PORT=8765\n"
        "DARJEELING_PERMISSION_CEILING=acceptEdits\n"
    )


def test_pair_uses_env_file_state_dir_and_token(fresh_root):
    state = fresh_root / "state"
    state.mkdir()
    (state / ".token").write_text("a" * 64 + "\n")
    env_file = fresh_root / "darjeeling.env"
    _write_env(env_file, state)

    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(fresh_root),
        "DARJEELING_ENV": str(env_file),
        "DARJEELING_CURRENT": str(fresh_root / "nonexistent"),
        "PYTHONPATH": str(REPO / "server"),
    }
    res = subprocess.run(
        [sys.executable, "-m", "darjeeling_server.cli", "pair"],
        env=env, capture_output=True, text=True, timeout=60, cwd=str(fresh_root),
    )
    assert res.returncode == 0, res.stdout + res.stderr
    assert "Pairing Code:" in res.stdout
    codes = json.loads((state / "pairing.json").read_text())
    assert len(codes) == 1
    assert stat.S_IMODE((state / "pairing.json").stat().st_mode) == 0o600
    # No stray token next to .token.
    assert not (state / "token").exists()


def test_version_reads_version_file(fresh_root):
    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(fresh_root),
        "DARJEELING_ENV": str(fresh_root / "missing.env"),
        "DARJEELING_CURRENT": str(fresh_root / "nonexistent"),
        "PYTHONPATH": str(REPO / "server"),
    }
    res = subprocess.run(
        [sys.executable, "-m", "darjeeling_server.cli", "version"],
        env=env, capture_output=True, text=True, timeout=30,
    )
    assert res.returncode == 0, res.stderr
    assert res.stdout.strip() == (REPO / "server" / "VERSION").read_text().strip()


def test_env_file_does_not_override_process_env(fresh_root, clean_environ):
    env_file = fresh_root / "e.env"
    env_file.write_text("DARJEELING_PORT=1111\nDARJEELING_SESSION=fromfile\n")
    os.environ["DARJEELING_PORT"] = "2222"
    os.environ.pop("DARJEELING_SESSION", None)
    applied = cli.load_env_into_environ(env_file)
    assert os.environ["DARJEELING_PORT"] == "2222"
    assert os.environ["DARJEELING_SESSION"] == "fromfile"
    assert applied == {"DARJEELING_SESSION": "fromfile"}


@pytest.mark.parametrize("command,should_drop", [("pair", True), ("devices", True), ("version", False)])
def test_main_drops_privileges_for_state_writing_commands(monkeypatch, fresh_root, clean_environ, command, should_drop):
    monkeypatch.setattr(cli, "ENV_PATH", fresh_root / "missing.env")
    calls = []
    monkeypatch.setattr(cli, "drop_privileges", lambda *a, **k: calls.append(True) or True)
    monkeypatch.setattr(cli, "cmd_pair", lambda args: 0)
    monkeypatch.setattr(cli, "cmd_devices", lambda args: 0)
    monkeypatch.setattr(cli, "cmd_version", lambda args: 0)
    argv = [command] + (["list"] if command == "devices" else [])
    assert cli.main(argv) == 0
    assert bool(calls) is should_drop


def test_pair_state_dir_flag_overrides_env(monkeypatch, fresh_root, clean_environ):
    monkeypatch.setattr(cli, "ENV_PATH", fresh_root / "missing.env")
    monkeypatch.setattr(cli, "drop_privileges", lambda *a, **k: False)
    seen = {}
    monkeypatch.setattr(cli, "cmd_pair", lambda args: seen.setdefault("state", cli.STATE_DIR) and 0)
    cli.main(["pair", "--state-dir", str(fresh_root / "st")])
    assert seen["state"] == fresh_root / "st"


def test_drop_privileges_switches_to_service_user(monkeypatch, clean_environ):
    import pwd

    fake = SimpleNamespace(pw_name="darjeeling", pw_uid=4242, pw_gid=4343, pw_dir="/var/lib/darjeeling")
    calls = []
    monkeypatch.setattr(os, "geteuid", lambda: 0)
    monkeypatch.setattr(pwd, "getpwnam", lambda name: fake)
    monkeypatch.setattr(os, "initgroups", lambda u, g: calls.append(("initgroups", u, g)))
    monkeypatch.setattr(os, "setgid", lambda g: calls.append(("setgid", g)))
    monkeypatch.setattr(os, "setuid", lambda u: calls.append(("setuid", u)))

    assert cli.drop_privileges("darjeeling") is True
    assert calls == [("initgroups", "darjeeling", 4343), ("setgid", 4343), ("setuid", 4242)]
    assert os.environ["HOME"] == "/var/lib/darjeeling"
    assert os.environ["USER"] == "darjeeling"


def test_drop_privileges_noop_when_not_root(monkeypatch):
    monkeypatch.setattr(os, "geteuid", lambda: 1000)
    monkeypatch.setattr(os, "setuid", lambda u: pytest.fail("must not setuid"))
    assert cli.drop_privileges("darjeeling") is False


def test_resolve_service_user_prefers_explicit(monkeypatch, fresh_root, clean_environ):
    os.environ["DARJEELING_USER"] = "someone"
    assert cli.resolve_service_user(fresh_root) == "someone"


def test_resolve_service_user_uses_state_dir_owner(monkeypatch, fresh_root, clean_environ):
    import pwd

    os.environ.pop("DARJEELING_USER", None)
    if os.stat(fresh_root).st_uid == 0:
        pytest.skip("state dir owned by root")
    expected = pwd.getpwuid(os.stat(fresh_root).st_uid).pw_name
    assert cli.resolve_service_user(fresh_root) == expected


def test_config_set_deepseek_writes_secret_not_env(monkeypatch, fresh_root, clean_environ):
    state = fresh_root / "state"
    state.mkdir()
    env_file = fresh_root / "darjeeling.env"
    _write_env(env_file, state)
    with env_file.open("a") as f:
        f.write("DEEPSEEK_API_KEY=old-key\n")
    env_file.chmod(0o640)
    monkeypatch.setattr(cli, "ENV_PATH", env_file)
    os.environ.pop("DARJEELING_STATE_DIR", None)

    assert cli.main(["config", "set", "deepseek-api-key", "sk-new"]) == 0

    secret = state / "secrets" / "deepseek_api_key"
    assert secret.read_text().strip() == "sk-new"
    assert stat.S_IMODE(secret.stat().st_mode) == 0o600
    assert stat.S_IMODE(secret.parent.stat().st_mode) == 0o700
    text = env_file.read_text()
    assert "DEEPSEEK_API_KEY" not in text
    assert "DARJEELING_PORT=8765" in text
    assert stat.S_IMODE(env_file.stat().st_mode) == 0o640


def test_config_set_rejects_invalid_ceiling(monkeypatch, fresh_root, clean_environ):
    env_file = fresh_root / "darjeeling.env"
    _write_env(env_file, fresh_root / "state")
    monkeypatch.setattr(cli, "ENV_PATH", env_file)
    assert cli.main(["config", "set", "permission-ceiling", "full"]) == 1
    assert "DARJEELING_PERMISSION_CEILING=acceptEdits" in env_file.read_text()
    assert cli.main(["config", "set", "permission-ceiling", "bypassPermissions"]) == 0
    assert "DARJEELING_PERMISSION_CEILING=bypassPermissions" in env_file.read_text()


def test_config_keys_map_to_what_the_server_reads():
    assert cli.KEY_MAP["vault"] == "DARJEELING_VAULT"
    assert cli.KEY_MAP["vault-sync"] == "DARJEELING_VAULT_SYNC"
    assert "DARJEELING_VAULT_PATH" not in cli.KEY_MAP.values()

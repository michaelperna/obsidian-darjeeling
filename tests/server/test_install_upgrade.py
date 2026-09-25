"""
Installer upgrade guards (1.0.3 -> 1.0.4), exercised by sourcing install.sh
with DJ_INSTALL_SOURCE_ONLY=1 and calling its helpers against temp files.
"""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from tests.server.conftest import REPO

INSTALL_SH = REPO / "server" / "install.sh"
bash = shutil.which("bash")
pytestmark = pytest.mark.skipif(bash is None, reason="bash not available")


def run(tmp_path: Path, script: str, overlays=(), **env_vars):
    """Source install.sh and run `script`. `overlays` stubs list_overlay_addresses."""
    stub = "list_overlay_addresses() { %s }" % (
        " ".join(f"echo {a};" for a in overlays) or "return 0;"
    )
    body = f'source "{INSTALL_SH}"\n{stub}\n{script}\n'
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "TMPDIR": str(tmp_path),
        "HOME": str(tmp_path),
        "DJ_INSTALL_SOURCE_ONLY": "1",
    }
    env.update(env_vars)
    return subprocess.run(
        [bash, "-c", body], capture_output=True, text=True, env=env, timeout=30,
        stdin=subprocess.DEVNULL,
    )


def env_file(tmp_path: Path, text: str) -> Path:
    p = tmp_path / "darjeeling.env"
    p.write_text(text)
    return p


CHECK = 'NON_INTERACTIVE={yes}; NETWORK_MODE={mode}; BIND_IP="{bind}"\n' \
        'check_existing_bind "{env}"\napply_pending_bind "{env}"\necho "PENDING=$PENDING_BIND_VALUE"'


def check(tmp_path, env, yes="true", mode="auto", bind="", overlays=()):
    return run(tmp_path, CHECK.format(yes=yes, mode=mode, bind=bind, env=env), overlays=overlays)


def test_sourcing_does_not_run_main(tmp_path):
    res = run(tmp_path, 'echo sourced-ok')
    assert res.returncode == 0, res.stderr
    assert res.stdout.strip() == "sourced-ok"
    assert "Running preflight" not in res.stderr


@pytest.mark.parametrize("value", ["0.0.0.0", "::", "[::]", "address:0.0.0.0", "169.254.9.9", "fe80::1"])
def test_wildcard_detected(tmp_path, value):
    assert run(tmp_path, f'is_wildcard_bind "{value}"').returncode == 0


@pytest.mark.parametrize("value", ["127.0.0.1", "loopback", "100.64.0.5", "address:192.168.1.2", "interface:tailscale0"])
def test_safe_binds_not_flagged(tmp_path, value):
    assert run(tmp_path, f'is_wildcard_bind "{value}"').returncode == 1


def test_safe_bind_left_alone(tmp_path):
    env = env_file(tmp_path, "DARJEELING_BIND=100.64.0.5\nDARJEELING_PORT=8765\n")
    res = check(tmp_path, env)
    assert res.returncode == 0, res.stderr
    assert "PENDING=\n" in res.stdout
    assert env.read_text() == "DARJEELING_BIND=100.64.0.5\nDARJEELING_PORT=8765\n"


def test_wildcard_rewritten_to_single_overlay_with_yes(tmp_path):
    env = env_file(tmp_path, "DARJEELING_BIND=0.0.0.0\nDARJEELING_PORT=8765\nDARJEELING_PERMISSION_CEILING=plan\n")
    res = check(tmp_path, env, overlays=["100.101.102.103"])
    assert res.returncode == 0, res.stderr
    assert env.read_text() == (
        "DARJEELING_BIND=100.101.102.103\nDARJEELING_PORT=8765\nDARJEELING_PERMISSION_CEILING=plan\n"
    )


def test_legacy_host_key_rewritten_and_removed(tmp_path):
    env = env_file(tmp_path, "DARJEELING_HOST=::\nDARJEELING_PORT=8765\n")
    res = check(tmp_path, env, overlays=["100.64.0.11"])
    assert res.returncode == 0, res.stderr
    text = env.read_text()
    assert "DARJEELING_HOST" not in text
    assert "DARJEELING_BIND=100.64.0.11" in text
    assert "DARJEELING_PORT=8765" in text


def test_explicit_bind_wins(tmp_path):
    env = env_file(tmp_path, "DARJEELING_BIND=0.0.0.0\n")
    res = check(tmp_path, env, bind="192.168.1.20", overlays=["100.64.0.11", "100.64.0.12"])
    assert res.returncode == 0, res.stderr
    assert env.read_text() == "DARJEELING_BIND=192.168.1.20\n"


def test_explicit_network_loopback(tmp_path):
    env = env_file(tmp_path, "DARJEELING_BIND=0.0.0.0\n")
    res = check(tmp_path, env, mode="loopback")
    assert res.returncode == 0, res.stderr
    assert env.read_text() == "DARJEELING_BIND=127.0.0.1\n"


@pytest.mark.parametrize("overlays", [(), ("100.64.0.11", "100.64.0.12")])
def test_stops_with_choices_when_ambiguous(tmp_path, overlays):
    env = env_file(tmp_path, "DARJEELING_BIND=0.0.0.0\n")
    res = check(tmp_path, env, overlays=overlays)
    assert res.returncode == 4, res.stdout + res.stderr
    assert env.read_text() == "DARJEELING_BIND=0.0.0.0\n"  # untouched
    for hint in ("--bind <ip>", "--network meshnet", "--network lan", "--network loopback",
                 "DARJEELING_BIND=interface:tailscale0"):
        assert hint in res.stderr
    for addr in overlays:
        assert addr in res.stderr


def test_stops_without_yes_and_no_terminal_answer(tmp_path):
    # Interactive run without a usable terminal: the default (yes) applies to
    # the single overlay; with none there is nothing to pick.
    env = env_file(tmp_path, "DARJEELING_BIND=0.0.0.0\n")
    res = check(tmp_path, env, yes="false")
    assert res.returncode == 4


def test_wildcard_explicit_bind_refused(tmp_path):
    env = env_file(tmp_path, "DARJEELING_BIND=0.0.0.0\n")
    res = check(tmp_path, env, bind="0.0.0.0")
    assert res.returncode == 4
    assert env.read_text() == "DARJEELING_BIND=0.0.0.0\n"


def test_env_bind_ip(tmp_path):
    cases = {
        "": "127.0.0.1",
        "DARJEELING_BIND=loopback\n": "127.0.0.1",
        "DARJEELING_BIND=address:100.64.0.9\n": "100.64.0.9",
        "DARJEELING_HOST=192.168.1.4\n": "192.168.1.4",
    }
    for text, expected in cases.items():
        env = env_file(tmp_path, text)
        res = run(tmp_path, f'env_bind_ip "{env}"')
        assert res.returncode == 0, res.stderr
        assert res.stdout.strip() == expected, text


def test_forced_ceiling_warning_keeps_value_with_yes(tmp_path):
    env = env_file(tmp_path, "DARJEELING_PERMISSION_CEILING=bypassPermissions\n")
    marker = tmp_path / "MIGRATED_TO_V1.txt"
    marker.write_text("migrated\n")
    res = run(tmp_path, f'NON_INTERACTIVE=true\nreview_forced_ceiling "{env}" "{marker}"')
    assert res.returncode == 0, res.stderr
    assert "WARNING: permission ceiling is bypassPermissions" in res.stderr
    assert "sudo darjeeling config set permission-ceiling acceptEdits" in res.stderr
    assert env.read_text() == "DARJEELING_PERMISSION_CEILING=bypassPermissions\n"
    assert "ceiling-reviewed" not in marker.read_text()


def test_forced_ceiling_detection_is_wired_to_the_1_0_3_marker():
    text = INSTALL_SH.read_text()
    # A 1.0.3 marker has no ceiling-policy line; the new installer records it.
    assert "grep -q '^ceiling-policy: preserve'" in text
    assert '"ceiling-forced-by-1.0.3: yes"' in text
    assert 'review_forced_ceiling "$env_file" "$legacy_marker"' in text
    # The installer never lowers the ceiling on its own.
    assert text.count("set_env_var DARJEELING_PERMISSION_CEILING acceptEdits") == 1


def test_env_deepseek_key_preferred_over_legacy():
    text = INSTALL_SH.read_text()
    assert 'deepseek_value="${env_deepseek:-$legacy_deepseek}"' in text
    assert "${legacy_deepseek:-$env_deepseek}" not in text


def test_bind_check_runs_before_any_change():
    text = INSTALL_SH.read_text()
    main = text[text.index("\nmain() {"):]
    assert main.index('check_existing_bind "$existing_env"') < main.index("Check for legacy 4.1.0 layout")
    assert main.index('check_existing_bind "$existing_env"') < main.index("apt-get update")


def test_previous_release_kept_for_rollback():
    text = INSTALL_SH.read_text()
    assert "ln -sfn \"$prev_release\" /opt/darjeeling/previous" in text
    assert text.index('prev_release="$(readlink -f /opt/darjeeling/current') < text.index(
        'tar -xzf "$source_tarball" -C "$release_dir"'
    )


def test_rerun_preserves_user_vault_and_legacy_unit_backup():
    text = INSTALL_SH.read_text()
    # DARJEELING_VAULT is only set from the legacy config on first migration
    # or when converting 1.0.3's DARJEELING_VAULT_PATH, never on every run.
    assert '"$env_is_new" == "true" || -n "$vault_path_1_0_3"' in text
    # The 4.1.0 unit backup is taken once, not overwritten with our own unit.
    assert "! -f /opt/darjeeling/backups/legacy-4.1.0/darjeeling.service" in text

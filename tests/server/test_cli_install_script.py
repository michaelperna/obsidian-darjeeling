"""
Installer and shipped config: syntax, version source, safe defaults.
"""

import os
import re
import shutil
import subprocess

import pytest

from tests.server.conftest import REPO

INSTALL_SH = REPO / "server" / "install.sh"
ENV_EXAMPLE = REPO / "server" / "config" / "darjeeling.env.example"
UNITS = REPO / "server" / "units"

bash = shutil.which("bash")
needs_bash = pytest.mark.skipif(bash is None, reason="bash not available")


@needs_bash
def test_install_sh_parses():
    res = subprocess.run([bash, "-n", str(INSTALL_SH)], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr


@needs_bash
@pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0, reason="dry run is exercised as non-root")
def test_dry_run_uses_version_file(tmp_path):
    version = (REPO / "server" / "VERSION").read_text().strip()
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "TMPDIR": str(tmp_path), "HOME": str(tmp_path)}
    res = subprocess.run(
        [bash, str(INSTALL_SH), "--dry-run", "--network", "loopback"],
        capture_output=True, text=True, env=env, timeout=60,
    )
    out = res.stdout + res.stderr
    assert res.returncode == 0, out
    assert f"/opt/darjeeling/releases/{version}" in out
    assert "1.0.0-dev" not in out


def test_install_sh_has_no_hardcoded_version():
    text = INSTALL_SH.read_text()
    assert re.search(r'^DJ_VERSION=""$', text, re.M), "DJ_VERSION must be empty until stamped"


def test_env_example_ceiling_is_accept_edits():
    lines = [l for l in ENV_EXAMPLE.read_text().splitlines() if l.startswith("DARJEELING_PERMISSION_CEILING=")]
    assert lines == ["DARJEELING_PERMISSION_CEILING=acceptEdits"]
    assert "DEEPSEEK_API_KEY=" not in [l.split("=")[0] + "=" for l in ENV_EXAMPLE.read_text().splitlines() if not l.startswith("#")]


def test_installer_never_forces_bypass():
    text = INSTALL_SH.read_text()
    assert "DARJEELING_PERMISSION_CEILING=bypassPermissions" not in text
    assert "DARJEELING_VAULT_PATH=" not in text.replace("unset_env_var DARJEELING_VAULT_PATH", "")


def test_units_home_is_service_home():
    for unit in ("darjeeling.service", "darjeeling-tmux.service"):
        text = (UNITS / unit).read_text()
        assert "/home/darjeeling" not in text
        assert "HOME=/var/lib/darjeeling " in text


def test_uninstall_does_not_remove_opt_tree():
    text = INSTALL_SH.read_text()
    assert "rm -rf /opt/darjeeling\n" not in text
    assert "rm -rf /opt/darjeeling/releases" in text

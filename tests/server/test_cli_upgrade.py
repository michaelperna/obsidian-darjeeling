"""
`darjeeling upgrade` runs the NEW release's installer, never the one under
/opt/darjeeling/current, and its rollback never points at a directory the
upgrade overwrote.
"""

import importlib.util
import io
import os
import stat
import tarfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.server.conftest import REPO

_spec = importlib.util.spec_from_file_location(
    "darjeeling_cli_upgrade_under_test", REPO / "server" / "darjeeling_server" / "cli.py"
)
cli = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cli)

FAKE_INSTALLER = """#!/usr/bin/env bash
DJ_VERSION="{stamp}"
echo "{tag} $*" >> "{log}"
{extra}
"""


def _make_tarball(path: Path, version: str, installer: str = None) -> Path:
    with tarfile.open(path, "w:gz") as tar:
        for name, data in (("VERSION", version + "\n"), ("install.sh", installer)):
            if data is None:
                continue
            raw = data.encode()
            info = tarfile.TarInfo(name)
            info.size = len(raw)
            info.mode = 0o755
            tar.addfile(info, io.BytesIO(raw))
    return path


@pytest.fixture()
def host(tmp_path, monkeypatch):
    opt = tmp_path / "opt"
    releases = opt / "releases"
    old = releases / "1.0.0-dev"
    old.mkdir(parents=True)
    current = opt / "current"
    current.symlink_to("releases/1.0.0-dev")
    log = tmp_path / "calls.log"
    # The 1.0.3 installer that must NOT be used.
    (old / "install.sh").write_text(FAKE_INSTALLER.format(stamp="1.0.0-dev", tag="OLD", log=log, extra=""))

    bindir = tmp_path / "bin"
    bindir.mkdir()
    systemctl = bindir / "systemctl"
    systemctl.write_text(f'#!/bin/sh\necho "systemctl $*" >> "{log}"\n')
    systemctl.chmod(systemctl.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ.get('PATH', '')}")

    monkeypatch.setattr(cli, "CURRENT_DIR", current)
    monkeypatch.setattr(cli, "ENV_PATH", tmp_path / "missing.env")
    monkeypatch.setattr(cli, "get_active_turns_count", lambda: 0)
    monkeypatch.setattr(cli.time, "sleep", lambda _s: None)
    return SimpleNamespace(opt=opt, releases=releases, old=old, current=current, log=log, tmp=tmp_path)


def _health(monkeypatch, ok: bool):
    import urllib.request

    class Resp:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def urlopen(*_a, **_k):
        if ok:
            return Resp()
        raise OSError("connection refused")

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)


def _args(tarball):
    return SimpleNamespace(force=False, rebuild_venv=False, tarball=str(tarball))


def _switch_to(host, version):
    """Shell snippet a fake installer uses to install `version` and switch current."""
    return (
        f'mkdir -p "{host.releases}/{version}" && '
        f'ln -sfn "releases/{version}" "{host.current}"'
    )


def test_upgrade_runs_installer_from_new_tarball(host, monkeypatch):
    _health(monkeypatch, True)
    new = FAKE_INSTALLER.format(stamp="", tag="NEW", log=host.log, extra=_switch_to(host, "1.0.4"))
    tb = _make_tarball(host.tmp / "darjeeling-server-1.0.4.tar.gz", "1.0.4", new)

    assert cli.cmd_upgrade(_args(tb)) == 0
    calls = host.log.read_text().splitlines()
    assert calls[0] == f"NEW --tarball {tb} --yes"
    assert not any(c.startswith("OLD") for c in calls)
    assert host.current.resolve() == (host.releases / "1.0.4").resolve()


def test_upgrade_prefers_matching_stamped_installer_next_to_tarball(host, monkeypatch):
    _health(monkeypatch, True)
    inner = FAKE_INSTALLER.format(stamp="", tag="INNER", log=host.log, extra="")
    tb = _make_tarball(host.tmp / "darjeeling-server-1.0.4.tar.gz", "1.0.4", inner)
    (host.tmp / "install.sh").write_text(FAKE_INSTALLER.format(stamp="1.0.4", tag="SIDE", log=host.log, extra=""))

    assert cli.cmd_upgrade(_args(tb)) == 0
    assert host.log.read_text().splitlines()[0].startswith("SIDE --tarball")


def test_upgrade_ignores_mismatched_side_installer(host, monkeypatch):
    _health(monkeypatch, True)
    inner = FAKE_INSTALLER.format(stamp="", tag="INNER", log=host.log, extra="")
    tb = _make_tarball(host.tmp / "darjeeling-server-1.0.4.tar.gz", "1.0.4", inner)
    # e.g. the 1.0.3 installer left in the download directory
    (host.tmp / "install.sh").write_text(FAKE_INSTALLER.format(stamp="1.0.0-dev", tag="SIDE", log=host.log, extra=""))

    assert cli.cmd_upgrade(_args(tb)) == 0
    assert host.log.read_text().splitlines()[0].startswith("INNER --tarball")


def test_upgrade_refuses_without_new_installer(host, monkeypatch, capsys):
    _health(monkeypatch, True)
    tb = _make_tarball(host.tmp / "darjeeling-server-1.0.4.tar.gz", "1.0.4", None)

    assert cli.cmd_upgrade(_args(tb)) == 1
    assert not host.log.exists()  # the old installer was not run either
    assert "no install.sh" in capsys.readouterr().err


def test_failed_upgrade_rolls_back_to_untouched_previous_release(host, monkeypatch):
    _health(monkeypatch, False)
    new = FAKE_INSTALLER.format(stamp="", tag="NEW", log=host.log, extra=_switch_to(host, "1.0.4"))
    tb = _make_tarball(host.tmp / "darjeeling-server-1.0.4.tar.gz", "1.0.4", new)

    assert cli.cmd_upgrade(_args(tb)) == 1
    assert host.current.resolve() == host.old.resolve()
    assert (host.old / "install.sh").read_text().count("OLD") == 1  # not overwritten
    assert "systemctl restart darjeeling.service" in host.log.read_text()


def test_failed_in_place_reinstall_does_not_fake_a_rollback(host, monkeypatch, capsys):
    _health(monkeypatch, False)
    new = FAKE_INSTALLER.format(stamp="", tag="NEW", log=host.log, extra="")
    tb = _make_tarball(host.tmp / "darjeeling-server-1.0.0-dev.tar.gz", "1.0.0-dev", new)

    assert cli.cmd_upgrade(_args(tb)) == 1
    assert "in place" in capsys.readouterr().err
    assert host.current.resolve() == host.old.resolve()


def test_rollback_prefers_previous_link(host):
    newer = host.releases / "1.0.4"
    newer.mkdir()
    host.current.unlink()
    host.current.symlink_to("releases/1.0.4")
    # A lexically "later" leftover directory that is not the previous release.
    (host.releases / "9.9.9-stale").mkdir()
    (host.opt / "previous").symlink_to("releases/1.0.0-dev")

    assert cli.cmd_rollback(SimpleNamespace(to_legacy=False)) == 0
    assert host.current.resolve() == host.old.resolve()
    # Rolling back again returns to the release we came from.
    assert (host.opt / "previous").resolve() == newer.resolve()

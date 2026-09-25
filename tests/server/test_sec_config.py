"""Regression tests: bind guard, token path, access-log query stripping, udev rules (1.0.4)."""

import logging
from pathlib import Path

import pytest

import darjeeling_server.config as config
from darjeeling_server.app import AccessLogFilter

REPO = Path(__file__).resolve().parents[2]


# --------------------------------------------------------------------------
# Public-bind guard
# --------------------------------------------------------------------------

@pytest.mark.parametrize(
    "ip",
    ["127.0.0.1", "127.8.9.1", "::1", "10.1.2.3", "172.16.0.1", "172.31.255.254",
     "192.168.1.10", "100.64.0.1", "100.127.255.255", "fd00::1", "fc00::5", "[fd7a:115c:a1e0::1]"],
)
def test_private_addresses_allowed(ip):
    assert config._is_private_ip(ip)


@pytest.mark.parametrize(
    "ip",
    [
        "0.0.0.0", "::", "0.1.2.3",            # unspecified / "this network"
        "169.254.1.1", "fe80::1",              # link-local
        "224.0.0.1", "239.1.2.3", "ff02::1",   # multicast
        "240.0.0.1", "255.255.255.255",        # reserved / broadcast
        "8.8.8.8", "100.128.0.1", "172.32.0.1", "2001:db8::1", "2606:4700::1",
        "::ffff:0.0.0.0", "::ffff:8.8.8.8",
        "not-an-ip", "",
    ],
)
def test_public_or_unsafe_addresses_refused(ip, monkeypatch):
    assert not config._is_private_ip(ip)
    monkeypatch.setattr(config, "ALLOW_PUBLIC_BIND", False)
    with pytest.raises(RuntimeError):
        config._resolve_bind("address:" + ip if ip else "address:")


def test_allow_public_bind_overrides(monkeypatch):
    monkeypatch.setattr(config, "ALLOW_PUBLIC_BIND", True)
    assert config._resolve_bind("0.0.0.0") == "0.0.0.0"
    assert config._resolve_bind("address:::") == "::"


@pytest.mark.parametrize("spec,expected", [
    ("", "127.0.0.1"), ("loopback", "127.0.0.1"), ("localhost", "127.0.0.1"),
    ("address:100.64.0.2", "100.64.0.2"), ("192.168.0.2", "192.168.0.2"),
    ("address:[fd00::2]", "fd00::2"),
])
def test_resolve_bind_accepts(spec, expected, monkeypatch):
    monkeypatch.setattr(config, "ALLOW_PUBLIC_BIND", False)
    assert config._resolve_bind(spec) == expected


@pytest.mark.parametrize("var", ["DARJEELING_BIND", "DARJEELING_HOST"])
@pytest.mark.parametrize("value", ["0.0.0.0", "::", "169.254.3.3", "224.0.0.251"])
def test_env_paths_guarded(var, value, monkeypatch):
    monkeypatch.setattr(config, "ALLOW_PUBLIC_BIND", False)
    monkeypatch.delenv("DARJEELING_BIND", raising=False)
    monkeypatch.delenv("DARJEELING_HOST", raising=False)
    monkeypatch.setenv(var, value)
    with pytest.raises(RuntimeError, match=var):
        config.default_bind(timeout=0)


def test_legacy_host_private_still_works(monkeypatch):
    monkeypatch.setattr(config, "ALLOW_PUBLIC_BIND", False)
    monkeypatch.delenv("DARJEELING_BIND", raising=False)
    monkeypatch.setenv("DARJEELING_HOST", "127.0.0.1")
    assert config.default_bind(timeout=0) == "127.0.0.1"


def test_mesh_interface_allowed_but_not_unspecified(monkeypatch):
    monkeypatch.setattr(config, "ALLOW_PUBLIC_BIND", False)
    monkeypatch.setattr(config, "_get_interface_ip", lambda iface: "100.101.102.103")
    assert config._resolve_bind("interface:tailscale0", timeout=0) == "100.101.102.103"
    # A mesh interface with a non-CGNAT address is still accepted by name...
    monkeypatch.setattr(config, "_get_interface_ip", lambda iface: "44.1.2.3")
    assert config._resolve_bind("interface:nordlynx", timeout=0) == "44.1.2.3"
    # ...but an ordinary interface with a public address is not.
    with pytest.raises(RuntimeError):
        config._resolve_bind("interface:eth0", timeout=0)
    monkeypatch.setattr(config, "_get_interface_ip", lambda iface: "0.0.0.0")
    with pytest.raises(RuntimeError):
        config._resolve_bind("interface:tailscale0", timeout=0)


# --------------------------------------------------------------------------
# Token path
# --------------------------------------------------------------------------

def test_default_token_path_is_dot_token():
    assert config.DEFAULT_TOKEN_FILE.name == ".token"
    assert config.DEFAULT_TOKEN_FILE.parent == config.STATE_DIR


def test_token_file_matches_installer():
    import re

    install = (REPO / "server" / "install.sh").read_text()
    paths = re.findall(r'token_file="([^"]+)"', install)
    assert paths and all(p.endswith("/.token") for p in paths), paths


def test_token_file_env_override_and_legacy_migration(tmp_path, monkeypatch):
    new = tmp_path / ".token"
    old = tmp_path / "token"
    monkeypatch.setattr(config, "DEFAULT_TOKEN_FILE", new)
    monkeypatch.setattr(config, "_LEGACY_TOKEN_FILE", old)

    monkeypatch.setenv("DARJEELING_TOKEN_FILE", str(tmp_path / "custom"))
    assert config._resolve_token_file() == (tmp_path / "custom").resolve()

    monkeypatch.delenv("DARJEELING_TOKEN_FILE")
    assert config._resolve_token_file() == new.resolve()

    old.write_text("legacy-token\n")
    assert config._resolve_token_file() == new.resolve()
    assert new.read_text() == "legacy-token\n"
    assert not old.exists()

    # Both present: the dot file wins and the old one is left alone.
    old.write_text("stale\n")
    assert config._resolve_token_file() == new.resolve()
    assert new.read_text() == "legacy-token\n"


# --------------------------------------------------------------------------
# Access log strips query strings even when the access log is on
# --------------------------------------------------------------------------

def _record(msg, args):
    return logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, msg, args, None)


def test_access_log_strips_query_args():
    rec = _record('%s - "%s %s HTTP/%s" %d',
                  ("127.0.0.1:5", "GET", "/api/vault/file?path=Secret_Note.md", "1.1", 200))
    AccessLogFilter().filter(rec)
    out = rec.getMessage()
    assert "Secret_Note" not in out
    assert "/api/vault/file" in out


def test_access_log_strips_query_in_message():
    rec = _record('1.2.3.4 - "GET /api/vault/file?path=Private.md&x=1 HTTP/1.1" 200', ())
    AccessLogFilter().filter(rec)
    assert "Private" not in rec.getMessage()
    rec = _record('%s - "WebSocket %s" [accepted]', ("1.2.3.4:1", "/ws/terminal?session=abc&token=sekrit"))
    AccessLogFilter().filter(rec)
    assert "sekrit" not in rec.getMessage() and "session=abc" not in rec.getMessage()


def test_access_log_filter_ignores_access_log_flag():
    assert "ACCESS_LOG" not in AccessLogFilter.filter.__code__.co_names


# --------------------------------------------------------------------------
# udev: power_supply has no dev node; permissions go on the sysfs attributes
# --------------------------------------------------------------------------

def test_udev_rules_use_run_on_sysfs_attributes():
    rules = (REPO / "server" / "udev" / "99-darjeeling-battery.rules").read_text()
    lines = [l for l in rules.splitlines() if l.strip() and not l.lstrip().startswith("#")]
    assert lines
    for l in lines:
        assert 'SUBSYSTEM=="power_supply"' in l
        assert "GROUP=" not in l and "MODE=" not in l
    body = "\n".join(lines)
    for attr in ("charge_control_end_threshold", "charge_control_start_threshold"):
        assert f'RUN+="/bin/chgrp darjeeling %S%p/{attr}"' in body
        assert f'RUN+="/bin/chmod g+w %S%p/{attr}"' in body

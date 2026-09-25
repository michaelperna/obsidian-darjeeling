"""Project Darjeeling Management CLI.

The CLI reads the server's env file (``DARJEELING_ENV``, default
/etc/darjeeling/darjeeling.env) so it sees the same state directory and token
path as the service. Commands that write server state (``pair``, ``devices``)
drop from root to the service user first, so every file they create stays
readable by the running server.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Dict, List, Optional

ENV_PATH = Path(os.environ.get("DARJEELING_ENV", "/etc/darjeeling/darjeeling.env"))
CURRENT_DIR = Path(os.environ.get("DARJEELING_CURRENT", "/opt/darjeeling/current"))
STATE_DIR = Path(os.environ.get("DARJEELING_STATE_DIR", "/var/lib/darjeeling"))
BACKUP_DIR = Path(os.environ.get("DARJEELING_BACKUPS", "/opt/darjeeling/backups"))
DEFAULT_SERVICE_USER = "darjeeling"

KEY_MAP = {
    "permission-ceiling": "DARJEELING_PERMISSION_CEILING",
    "max-concurrent-turns": "DARJEELING_MAX_CONCURRENT_TURNS",
    "bind": "DARJEELING_BIND",
    "vault": "DARJEELING_VAULT",
    "vault-sync": "DARJEELING_VAULT_SYNC",
    "deepseek-api-key": "DEEPSEEK_API_KEY",
}
REV_KEY_MAP = {v: k for k, v in KEY_MAP.items()}
VALID_PERMISSION_CEILINGS = ("plan", "acceptEdits", "bypassPermissions")

# Commands that create or modify files the server reads.
STATE_WRITING_COMMANDS = {"pair", "devices"}


def parse_env_file(path: Path) -> Dict[str, str]:
    if not path.exists():
        return {}
    res = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip("'\"")
                res[k] = v
    return res


def load_env_into_environ(path: Optional[Path] = None) -> Dict[str, str]:
    """Load the server env file into os.environ without overriding values that
    are already set in the process environment. Returns what was applied."""
    path = path or ENV_PATH
    applied: Dict[str, str] = {}
    try:
        values = parse_env_file(path)
    except OSError:
        # Unreadable (not root and not in the service group): fall back to
        # the process environment.
        return applied
    for k, v in values.items():
        if k not in os.environ:
            os.environ[k] = v
            applied[k] = v
    return applied


def _refresh_paths() -> None:
    global STATE_DIR
    STATE_DIR = Path(os.environ.get("DARJEELING_STATE_DIR", "/var/lib/darjeeling"))


def resolve_service_user(state_dir: Optional[Path] = None) -> Optional[str]:
    """The account the server runs as: DARJEELING_USER, else the owner of the
    state directory, else 'darjeeling' if that account exists."""
    try:
        import pwd
    except ImportError:  # pragma: no cover - non-Unix
        return None
    explicit = os.environ.get("DARJEELING_USER", "").strip()
    if explicit:
        return explicit
    sd = state_dir or STATE_DIR
    try:
        uid = sd.stat().st_uid
        if uid != 0:
            return pwd.getpwuid(uid).pw_name
    except (OSError, KeyError):
        pass
    try:
        pwd.getpwnam(DEFAULT_SERVICE_USER)
        return DEFAULT_SERVICE_USER
    except KeyError:
        return None


def drop_privileges(user: Optional[str] = None) -> bool:
    """When running as root, switch to the service user for the rest of the
    process. Returns True if privileges were dropped."""
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        return False
    user = user or resolve_service_user()
    if not user or user == "root":
        print(
            "Warning: running as root and no service user found; files written now "
            "may not be readable by darjeeling.service.",
            file=sys.stderr,
        )
        return False
    import pwd

    pw = pwd.getpwnam(user)
    os.initgroups(user, pw.pw_gid)
    os.setgid(pw.pw_gid)
    os.setuid(pw.pw_uid)
    os.environ["HOME"] = pw.pw_dir
    os.environ["USER"] = user
    os.environ["LOGNAME"] = user
    return True


def _preserve_owner(src: Path, dst_tmp: Path) -> None:
    if not src.exists() or not hasattr(os, "chown"):
        return
    try:
        st = os.stat(src)
        os.chmod(dst_tmp, st.st_mode & 0o777)
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            os.chown(dst_tmp, st.st_uid, st.st_gid)
    except OSError:
        pass


def write_env_file(
    path: Path,
    updates: Dict[str, str],
    mode: Optional[int] = None,
    remove: Optional[List[str]] = None,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines: List[str] = []
    keys_written = set()
    drop = set(remove or [])
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            for raw_line in f:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    lines.append(raw_line)
                    continue
                if "=" in line:
                    k, _ = line.split("=", 1)
                    k = k.strip()
                    if k in drop:
                        continue
                    if k in updates:
                        if k not in keys_written:
                            lines.append(f"{k}={updates[k]}\n")
                            keys_written.add(k)
                    else:
                        lines.append(raw_line)
                else:
                    lines.append(raw_line)
    for k, v in updates.items():
        if k not in keys_written:
            lines.append(f"{k}={v}\n")

    tmp_path = path.with_suffix(".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.writelines(lines)
    # Keep owner, group and mode: the env file is root:<service group> 0640
    # and the service user must still be able to read it afterwards.
    _preserve_owner(path, tmp_path)
    if mode is not None:
        os.chmod(tmp_path, mode)
    os.replace(tmp_path, path)


def deepseek_secret_path() -> Path:
    # Must match darjeeling_server.config.get_deepseek_api_key().
    return STATE_DIR / "secrets" / "deepseek_api_key"


def write_deepseek_secret(value: str) -> Path:
    target = deepseek_secret_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(target.parent, 0o700)
    tmp = target.with_name(target.name + ".tmp")
    fd = os.open(str(tmp), os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with open(fd, "w", encoding="utf-8") as f:
        f.write(value.strip() + "\n")
    os.chmod(tmp, 0o600)
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        user = resolve_service_user()
        if user and user != "root":
            import pwd

            pw = pwd.getpwnam(user)
            os.chown(target.parent, pw.pw_uid, pw.pw_gid)
            os.chown(tmp, pw.pw_uid, pw.pw_gid)
    os.replace(tmp, target)
    return target


def _pairing_module():
    """Import darjeeling_server.pairing with the configuration main() loaded.

    ``python -m darjeeling_server.cli`` imports the package (and so config)
    before main() can read the env file, which leaves config pointing at
    default paths. Reload config and pairing so they pick up the env file's
    state dir and token path, running as the (possibly dropped) current user.
    """
    import importlib
    import sys as _sys

    if "darjeeling_server.config" in _sys.modules:
        importlib.reload(_sys.modules["darjeeling_server.config"])
        if "darjeeling_server.pairing" in _sys.modules:
            importlib.reload(_sys.modules["darjeeling_server.pairing"])
    from darjeeling_server import pairing

    return pairing


def read_version() -> str:
    """Installed version: the release VERSION file, else the source tree's."""
    candidates = [
        CURRENT_DIR / "VERSION",
        Path(__file__).resolve().parent.parent / "VERSION",
    ]
    for c in candidates:
        try:
            if c.is_file():
                v = c.read_text(encoding="utf-8").strip()
                if v:
                    return v
        except OSError:
            continue
    return "unknown"


def get_server_port() -> int:
    env = parse_env_file(ENV_PATH)
    return int(env.get("DARJEELING_PORT", os.environ.get("DARJEELING_PORT", "8765")))


def get_server_bind() -> str:
    env = parse_env_file(ENV_PATH)
    return env.get("DARJEELING_BIND", os.environ.get("DARJEELING_BIND", "127.0.0.1"))


def get_active_turns_count() -> int:
    marker = STATE_DIR / "run" / "active_turns"
    if marker.exists():
        try:
            val = int(marker.read_text().strip())
            if val > 0:
                return val
        except Exception:
            return 1
    port = get_server_port()
    try:
        import urllib.request
        tok_file = STATE_DIR / ".token"
        headers = {}
        if tok_file.exists():
            headers["Authorization"] = f"Bearer {tok_file.read_text().strip()}"
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/agents", headers=headers)
        with urllib.request.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if isinstance(data, list):
                return len([a for a in data if a.get("status") in ("running", "busy")])
    except Exception:
        pass
    return 0


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_version(_args: argparse.Namespace) -> int:
    print(read_version())
    return 0


def cmd_status(_args: argparse.Namespace) -> int:
    print("=== Project Darjeeling Status ===")
    print(f"Version: {read_version()}")

    # Check services via systemctl
    for svc in ["darjeeling.service", "darjeeling-tmux.service"]:
        try:
            res = subprocess.run(["systemctl", "is-active", svc], capture_output=True, text=True)
            status = res.stdout.strip()
            print(f"{svc}: {status}")
        except Exception as e:
            print(f"{svc}: unknown ({e})")

    # Check local health endpoint
    port = get_server_port()
    bind = get_server_bind()
    print(f"Configured bind: {bind}:{port}")
    try:
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            print(f"Health: OK (status={data.get('status', 'ok')}, running_turns={data.get('running_turns', 0)})")
    except Exception as e:
        print(f"Health: Unreachable on 127.0.0.1:{port} ({e})")

    # Devices count
    dev_file = STATE_DIR / "devices.json"
    if dev_file.exists():
        try:
            devices = json.loads(dev_file.read_text())
            active = sum(1 for d in devices if not d.get("revoked", False))
            print(f"Paired devices: {active} active ({len(devices)} total)")
        except Exception:
            pass

    return 0


def cmd_doctor(_args: argparse.Namespace) -> int:
    print("Running Darjeeling Doctor...")
    issues = 0

    # 1. Check darjeeling.service
    res = subprocess.run(["systemctl", "is-active", "darjeeling.service"], capture_output=True, text=True)
    if res.stdout.strip() == "active":
        print("  [OK] darjeeling.service is active")
    else:
        print("  [FAIL] darjeeling.service is not active.")
        print("         Fix: sudo systemctl start darjeeling.service")
        issues += 1

    # 2. Check darjeeling-tmux.service
    res_tmux = subprocess.run(["systemctl", "is-active", "darjeeling-tmux.service"], capture_output=True, text=True)
    if res_tmux.stdout.strip() == "active":
        print("  [OK] darjeeling-tmux.service is active")
    else:
        print("  [WARN] darjeeling-tmux.service is not active.")
        print("         Fix: sudo systemctl start darjeeling-tmux.service")

    # 3. Check environment file
    if ENV_PATH.exists():
        print(f"  [OK] Environment file exists at {ENV_PATH}")
        try:
            mode = oct(ENV_PATH.stat().st_mode & 0o777)
            if mode not in ["0o640", "0o600"]:
                print(f"  [WARN] Environment file permissions are {mode} (expected 0640 or 0600)")
        except Exception:
            pass
    else:
        print(f"  [FAIL] Missing configuration at {ENV_PATH}")
        print("         Fix: sudo darjeeling config set bind 127.0.0.1")
        issues += 1

    # 4. Check venv health and python version (detect broken venv after distro upgrade, G-46)
    venv_py = CURRENT_DIR / "venv" / "bin" / "python"
    if venv_py.exists() and os.access(venv_py, os.X_OK):
        try:
            chk = subprocess.run([str(venv_py), "-c", "import darjeeling_server; print('ok')"], capture_output=True, text=True, timeout=5)
            if chk.returncode == 0 and "ok" in chk.stdout:
                print("  [OK] Python venv healthy and darjeeling_server importable")
            else:
                print("  [FAIL] Python venv broken or cannot import darjeeling_server.")
                print("         Fix: sudo darjeeling upgrade --rebuild-venv")
                issues += 1
        except Exception as e:
            print(f"  [FAIL] Python venv failed execution: {e}")
            print("         Fix: sudo darjeeling upgrade --rebuild-venv")
            issues += 1
    else:
        print(f"  [FAIL] Python venv executable missing at {venv_py}")
        print("         Fix: sudo darjeeling upgrade --rebuild-venv")
        issues += 1

    # 5. Check Claude Code version range (G-47)
    claude_cmd = shutil.which("claude")
    if not claude_cmd and (STATE_DIR / ".local" / "bin" / "claude").exists():
        claude_cmd = str(STATE_DIR / ".local" / "bin" / "claude")

    if claude_cmd:
        try:
            c_res = subprocess.run([claude_cmd, "--version"], capture_output=True, text=True, timeout=5)
            c_ver = c_res.stdout.strip()
            print(f"  [OK] Claude Code found: {c_ver}")
        except Exception as e:
            print(f"  [WARN] Claude Code found but failed --version check: {e}")
    else:
        print("  [INFO] Claude Code not detected in PATH.")

    # 6. Check sudo permissions on service user (warn if NOPASSWD sudo)
    try:
        user = "darjeeling"
        s_chk = subprocess.run(["sudo", "-l", "-U", user], capture_output=True, text=True)
        if s_chk.returncode == 0 and ("(ALL" in s_chk.stdout or "NOPASSWD" in s_chk.stdout):
            print(f"  [WARN] User '{user}' has sudo privileges. Hardening recommends removing sudo rules.")
    except Exception:
        pass

    # 7. Check health endpoint
    port = get_server_port()
    try:
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("status") == "ok":
                print(f"  [OK] /health responding on port {port}")
    except Exception as e:
        print(f"  [FAIL] /health not responding on port {port} ({e})")
        print("         Fix: sudo systemctl restart darjeeling.service")
        issues += 1

    # 8. Check vault existence and freshness (INST-27)
    vault_env = os.environ.get("DARJEELING_VAULT")
    if not vault_env and ENV_PATH.exists():
        try:
            for line in ENV_PATH.read_text().splitlines():
                if line.startswith("DARJEELING_VAULT="):
                    vault_env = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
        except Exception:
            pass
    vault_dir = Path(os.path.expanduser(vault_env or "~/vault")).resolve()
    if not vault_dir.exists():
        print(f"  [WARN] Vault path does not exist: {vault_dir}")
    elif not vault_dir.is_dir():
        print(f"  [FAIL] Vault path is not a directory: {vault_dir}")
        issues += 1
    else:
        try:
            newest_mtime = 0.0
            file_count = 0
            for root, dirs, files in os.walk(vault_dir):
                dirs[:] = [d for d in dirs if not d.startswith(".")]
                for f in files:
                    if f.startswith("."):
                        continue
                    file_count += 1
                    fp = os.path.join(root, f)
                    try:
                        mt = os.path.getmtime(fp)
                        if mt > newest_mtime:
                            newest_mtime = mt
                    except OSError:
                        pass
            if file_count == 0:
                print(f"  [WARN] Vault is empty at {vault_dir}")
            else:
                age_sec = time.time() - newest_mtime
                if age_sec < 3600:
                    age_str = f"{int(age_sec // 60)} minutes ago"
                elif age_sec < 86400:
                    age_str = f"{int(age_sec // 3600)} hours ago"
                else:
                    age_str = f"{int(age_sec // 86400)} days ago"
                print(f"  [OK] Vault at {vault_dir} ({file_count} files, newest modified {age_str})")
                if age_sec > 14 * 86400:
                    print("  [WARN] Vault has not been modified in > 14 days — verify sync")
        except Exception as e:
            print(f"  [WARN] Could not inspect vault freshness: {e}")

    # 9. Check vault-sync service if configured
    sync_mode = os.environ.get("DARJEELING_VAULT_SYNC", "none")
    if sync_mode == "obsidian-sync":
        res_sync = subprocess.run(["systemctl", "is-active", "darjeeling-vault-sync.service"], capture_output=True, text=True)
        if res_sync.stdout.strip() == "active":
            print("  [OK] darjeeling-vault-sync.service is active")
        else:
            print("  [WARN] darjeeling-vault-sync.service is not active")

    if issues > 0:
        print(f"\nDoctor found {issues} issue(s).")
        return 1
    print("\nDoctor passed cleanly.")
    return 0


def cmd_pair(_args: argparse.Namespace) -> int:
    pairing = _pairing_module()

    pair_code = pairing.create_code()
    fmt_code = f"{pair_code[:4]} {pair_code[4:]}"

    bind = get_server_bind()
    port = get_server_port()

    # Determine user-facing server URL
    server_url = f"http://{bind}:{port}"
    if bind in ["0.0.0.0", "127.0.0.1"]:
        # Check if tailscale serve or tailnet IP is available
        try:
            ts = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True)
            if ts.returncode == 0 and ts.stdout.strip():
                server_url = f"http://{ts.stdout.strip()}:{port}"
        except Exception:
            pass

    deep_link = f"obsidian://darjeeling?action=pair&url={urllib.parse.quote(server_url)}&code={pair_code}"

    print("=== Pair New Device ===")
    print(f"Pairing Code:  {fmt_code}")
    print("Valid for:     10 minutes")
    print(f"Server URL:    {server_url}")
    print(f"Deep Link:     {deep_link}")
    print("")

    # Terminal QR code via segno
    try:
        import segno
        qr = segno.make(deep_link)
        print("Scan QR code with mobile camera or Obsidian:")
        qr.terminal(compact=True)
    except Exception as e:
        print(f"(QR generator unavailable: {e})")

    return 0


def cmd_devices(args: argparse.Namespace) -> int:
    sub = args.device_command
    dev_file = STATE_DIR / "devices.json"

    if not dev_file.exists():
        if sub == "list":
            print("No devices paired yet.")
            return 0
        print("Error: devices.json does not exist.")
        return 1

    try:
        devices = json.loads(dev_file.read_text())
    except Exception as e:
        print(f"Error reading devices.json: {e}")
        return 1

    if sub == "list":
        if not devices:
            print("No devices found.")
            return 0
        print(f"{'DEVICE ID':<36} {'NAME':<20} {'PLATFORM':<10} {'REVOKED':<8} {'CREATED'}")
        print("-" * 90)
        for d in devices:
            d_id = d.get("device_id", "")
            d_name = d.get("device_name", "")[:20]
            d_plat = d.get("platform", "")[:10]
            d_rev = "YES" if d.get("revoked") else "NO"
            d_cre = d.get("created", "")[:19]
            print(f"{d_id:<36} {d_name:<20} {d_plat:<10} {d_rev:<8} {d_cre}")
        return 0

    elif sub == "revoke":
        target = args.device_id
        if not target:
            print("Error: Specify device ID to revoke.")
            return 1
        pairing = _pairing_module()

        if not pairing.revoke(target):
            print(f"Error: Device '{target}' not found.")
            return 1
        print(f"Device '{target}' revoked successfully.")
        return 0

    return 0


def cmd_logs(args: argparse.Namespace) -> int:
    cmd = ["journalctl", "-u", "darjeeling.service", "-f"] + args.extra_args
    os.execvp("journalctl", cmd)


def cmd_config(args: argparse.Namespace) -> int:
    sub = args.config_command
    key = args.key

    mapped_key = KEY_MAP.get(key, key)

    if sub == "get":
        if mapped_key == "DEEPSEEK_API_KEY":
            secret = deepseek_secret_path()
            try:
                if secret.is_file() and secret.read_text(encoding="utf-8").strip():
                    print(f"(set, stored in {secret})")
                    return 0
            except OSError as e:
                print(f"(cannot read {secret}: {e})", file=sys.stderr)
                return 1
        env = parse_env_file(ENV_PATH)
        val = env.get(mapped_key)
        if val is not None and mapped_key == "DEEPSEEK_API_KEY":
            print(f"(set in {ENV_PATH}; move it with: sudo darjeeling config set deepseek-api-key)")
            return 0
        if val is not None:
            print(val)
            return 0
        else:
            print(f"(not set: {mapped_key})", file=sys.stderr)
            return 1

    elif sub == "set":
        val = args.val
        is_secret = (key == "deepseek-api-key" or mapped_key == "DEEPSEEK_API_KEY")

        if is_secret and (val is None or val == "-"):
            if not sys.stdin.isatty():
                val = sys.stdin.read().strip()
            else:
                import getpass
                val = getpass.getpass("Enter DeepSeek API Key: ").strip()

        if val is None:
            print("Error: Missing value to set.", file=sys.stderr)
            return 1

        if is_secret:
            # Secrets live in the state dir (0600, service user), not the env
            # file; the server reads this path first.
            target = write_deepseek_secret(val)
            if "DEEPSEEK_API_KEY" in parse_env_file(ENV_PATH):
                write_env_file(ENV_PATH, {}, remove=["DEEPSEEK_API_KEY"])
            print(f"Stored {key} in {target}. Restart to apply: sudo systemctl restart darjeeling.service")
            return 0

        if mapped_key == "DARJEELING_PERMISSION_CEILING" and val not in VALID_PERMISSION_CEILINGS:
            print(
                f"Error: permission-ceiling must be one of: {', '.join(VALID_PERMISSION_CEILINGS)}",
                file=sys.stderr,
            )
            return 1

        write_env_file(ENV_PATH, {mapped_key: val})
        print(f"Updated {key} ({mapped_key}). Restart to apply: sudo systemctl restart darjeeling.service")
        return 0

    return 0


def cmd_upgrade(args: argparse.Namespace) -> int:
    # 1. Turn running check (G-45)
    running_turns = get_active_turns_count()
    if running_turns > 0 and not args.force:
        print(f"Error: Refusing to upgrade while {running_turns} turn(s) are running. Pass --force to override.", file=sys.stderr)
        return 1

    # 2. Rebuild venv requested (G-46, G-47)
    if args.rebuild_venv:
        print("Rebuilding Python virtual environment for current release...")
        venv_dir = CURRENT_DIR / "venv"
        req_lock = CURRENT_DIR / "requirements.lock"
        if not req_lock.exists():
            print(f"Error: {req_lock} not found.", file=sys.stderr)
            return 1
        shutil.rmtree(venv_dir, ignore_errors=True)
        subprocess.run(["python3", "-m", "venv", str(venv_dir)], check=True)
        pip_cmd = [str(venv_dir / "bin" / "pip"), "install", "-q", "--no-deps", "--require-hashes", "-r", str(req_lock)]
        subprocess.run(pip_cmd, check=True)
        # Ensure pth
        for p in (venv_dir / "lib").glob("python*/site-packages"):
            (p / "darjeeling.pth").write_text("/opt/darjeeling/current\n")
        subprocess.run(["systemctl", "restart", "darjeeling.service"], check=False)
        print("Venv rebuilt successfully and darjeeling.service restarted.")
        return 0

    # 3. Upgrade with tarball
    tarball = args.tarball
    if not tarball:
        print("Error: Specify release tarball with --tarball <path> (or use --rebuild-venv).", file=sys.stderr)
        return 1

    tarball_path = Path(tarball).resolve()
    if not tarball_path.exists():
        print(f"Error: Tarball not found at {tarball_path}", file=sys.stderr)
        return 1

    # Validate tarball integrity before proceeding
    chk = subprocess.run(["tar", "-tzf", str(tarball_path)], capture_output=True)
    if chk.returncode != 0:
        print("Error: Tarball is corrupt or invalid gzip archive.", file=sys.stderr)
        return 1

    # Run the installer that ships with the NEW release. The installer under
    # /opt/darjeeling/current belongs to the release being replaced (1.0.3's
    # was hard-coded to 1.0.0-dev and forced bypassPermissions on migrated
    # hosts), so it must never drive an upgrade.
    import tempfile

    with tempfile.TemporaryDirectory(prefix="darjeeling-upgrade-") as workdir:
        installer, why = select_upgrade_installer(tarball_path, Path(workdir))
        if installer is None:
            print(f"Error: {why}", file=sys.stderr)
            return 1
        print(f"Using installer: {why}")

        prev_current = CURRENT_DIR.resolve() if CURRENT_DIR.exists() else None

        cmd = ["bash", str(installer), "--tarball", str(tarball_path), "--yes"]
        res = subprocess.run(cmd)

    # Health check with automatic rollback
    port = get_server_port()
    healthy = False
    for _ in range(15):
        time.sleep(1)
        try:
            import urllib.request
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as resp:
                if resp.status == 200:
                    healthy = True
                    break
        except Exception:
            pass

    if healthy:
        return res.returncode

    new_current = CURRENT_DIR.resolve() if CURRENT_DIR.exists() else None
    print("WARNING: Upgraded server failed health check!", file=sys.stderr)
    if prev_current is None or not prev_current.is_dir():
        print("No previous release to roll back to. Check: journalctl -u darjeeling.service -n 50", file=sys.stderr)
        return 1
    if new_current == prev_current:
        print(
            f"The installer reinstalled {prev_current} in place, so there is no separate "
            "release to roll back to. Check: journalctl -u darjeeling.service -n 50",
            file=sys.stderr,
        )
        return 1
    print(f"Initiating automatic rollback to {prev_current}...", file=sys.stderr)
    try:
        _switch_current(prev_current)
        subprocess.run(["systemctl", "restart", "darjeeling.service"], check=False)
        print("Rollback complete.")
    except Exception as e:
        print(f"Rollback failed: {e}", file=sys.stderr)
    return 1


def _tarball_version(tarball_path: Path) -> Optional[str]:
    for member in ("VERSION", "./VERSION"):
        res = subprocess.run(["tar", "-xzOf", str(tarball_path), member], capture_output=True, text=True)
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip().splitlines()[0].strip()
    return None


def _stamped_version(installer: Path) -> Optional[str]:
    """DJ_VERSION baked into an install.sh ("" when unstamped, None if unreadable)."""
    import re

    try:
        m = re.search(r'^DJ_VERSION="([^"]*)"', installer.read_text(encoding="utf-8"), re.M)
    except OSError:
        return None
    return m.group(1) if m else None


def select_upgrade_installer(tarball_path: Path, workdir: Path):
    """Pick the install.sh for an upgrade: never the running release's.

    1. A stamped install.sh next to the tarball for the same version (it also
       verifies the tarball's SHA-256).
    2. The install.sh shipped inside the tarball (reads VERSION from it).
    3. An unstamped install.sh next to the tarball.
    Returns (path, description) or (None, error message).
    """
    version = _tarball_version(tarball_path)
    side = tarball_path.parent / "install.sh"
    side_version = _stamped_version(side) if side.is_file() else None
    if side_version and version and side_version == version:
        return side, f"{side} (stamped {version})"

    for member in ("install.sh", "./install.sh"):
        res = subprocess.run(
            ["tar", "-xzf", str(tarball_path), "-C", str(workdir), member], capture_output=True
        )
        extracted = workdir / "install.sh"
        if res.returncode == 0 and extracted.is_file():
            return extracted, f"install.sh from {tarball_path.name}" + (f" ({version})" if version else "")

    if side.is_file() and side_version == "":
        return side, f"{side} (unstamped)"
    if side.is_file():
        return None, (
            f"{side} is stamped for {side_version or 'an unknown version'}, not "
            f"{version or 'this tarball'}, and the tarball has no install.sh. Download the "
            "install.sh from the same release as the tarball."
        )
    return None, (
        f"{tarball_path.name} contains no install.sh. Download install.sh from the same "
        "release and run: sudo bash install.sh --tarball " + str(tarball_path) + " --yes"
    )


def _switch_current(target: Path) -> None:
    """Point CURRENT_DIR at target atomically; remember the old target as previous."""
    old = CURRENT_DIR.resolve() if CURRENT_DIR.exists() else None
    tmp = CURRENT_DIR.with_name(CURRENT_DIR.name + ".tmp-rollback")
    if tmp.is_symlink() or tmp.exists():
        tmp.unlink()
    tmp.symlink_to(target)
    os.replace(tmp, CURRENT_DIR)
    if old is not None and old != target.resolve():
        prev = CURRENT_DIR.with_name("previous")
        ptmp = CURRENT_DIR.with_name("previous.tmp-rollback")
        if ptmp.is_symlink() or ptmp.exists():
            ptmp.unlink()
        ptmp.symlink_to(old)
        os.replace(ptmp, prev)


def _rollback_target() -> Optional[Path]:
    """The release before the current one: the installer's `previous` link,
    else the most recently modified release directory that is not current."""
    current = CURRENT_DIR.resolve() if CURRENT_DIR.exists() else None
    prev = CURRENT_DIR.with_name("previous")
    if prev.is_symlink() and prev.exists():
        target = prev.resolve()
        if target.is_dir() and target != current:
            return target
    releases_dir = CURRENT_DIR.parent / "releases"
    if not releases_dir.is_dir():
        return None
    others = [p for p in releases_dir.iterdir() if p.is_dir() and p.resolve() != current]
    if not others:
        return None
    return max(others, key=lambda p: p.stat().st_mtime)


def cmd_rollback(args: argparse.Namespace) -> int:
    if args.to_legacy:
        legacy_backup = BACKUP_DIR / "legacy-4.1.0" / "darjeeling.service"
        if not legacy_backup.exists():
            print(f"Error: Legacy 4.1.0 backup not found at {legacy_backup}", file=sys.stderr)
            return 1
        print("Restoring legacy 4.1.0 systemd service...")
        shutil.copy2(legacy_backup, "/etc/systemd/system/darjeeling.service")
        subprocess.run(["systemctl", "daemon-reload"], check=True)
        subprocess.run(["systemctl", "restart", "darjeeling.service"], check=False)
        print("Legacy 4.1.0 service restored.")
        return 0

    print("Rolling back to previous release...")
    target = _rollback_target()
    if target is None:
        print("Error: No previous release directory found.", file=sys.stderr)
        return 1
    _switch_current(target)
    subprocess.run(["systemctl", "restart", "darjeeling.service"], check=False)
    print(f"Rolled back to {target.name}.")
    return 0


def cmd_uninstall(args: argparse.Namespace) -> int:
    installer = CURRENT_DIR / "install.sh"
    if not installer.exists():
        installer = Path("/usr/local/bin/install.sh")
    if installer.exists():
        cmd = ["bash", str(installer), "--uninstall", "--yes"]
        if args.purge:
            cmd.append("--purge")
        if args.delete_vault:
            cmd.append("--delete-vault")
        if args.remove_user:
            cmd.append("--remove-user")
        return subprocess.run(cmd).returncode

    print("Uninstalling Project Darjeeling...")
    subprocess.run(["systemctl", "stop", "darjeeling.service", "darjeeling-tmux.service"], check=False)
    subprocess.run(["systemctl", "disable", "darjeeling.service", "darjeeling-tmux.service"], check=False)

    for unit in ["/etc/systemd/system/darjeeling.service", "/etc/systemd/system/darjeeling-tmux.service"]:
        p = Path(unit)
        if p.exists():
            p.unlink()
    subprocess.run(["systemctl", "daemon-reload"], check=False)

    if Path("/usr/local/bin/darjeeling").exists():
        Path("/usr/local/bin/darjeeling").unlink()

    # Only remove what the installer created; anything else under
    # /opt/darjeeling (for example a git checkout) is left alone.
    opt = Path("/opt/darjeeling")
    current = opt / "current"
    if current.is_symlink() or current.exists():
        current.unlink()
    for sub in ("releases", "backups"):
        shutil.rmtree(opt / sub, ignore_errors=True)
    try:
        opt.rmdir()
    except OSError:
        pass

    if args.purge:
        if Path("/etc/darjeeling").exists():
            shutil.rmtree("/etc/darjeeling", ignore_errors=True)
        if Path("/var/lib/darjeeling").exists():
            shutil.rmtree("/var/lib/darjeeling", ignore_errors=True)
    elif args.delete_vault:
        vault = STATE_DIR / "vault"
        if vault.exists():
            shutil.rmtree(vault, ignore_errors=True)

    if args.remove_user:
        # Delete user but keep home directory unless delete_vault / purge was requested
        print("Removing system user 'darjeeling'...")
        subprocess.run(["userdel", "darjeeling"], check=False)

    print("Uninstall complete. (~/.claude of the service user is never touched.)")
    return 0


# ---------------------------------------------------------------------------
# CLI Argument Parser
# ---------------------------------------------------------------------------

def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="darjeeling", description="Project Darjeeling Management CLI")
    subparsers = parser.add_subparsers(dest="command")

    # version
    subparsers.add_parser("version", help="Print installed version")

    # status
    subparsers.add_parser("status", help="Show service and daemon status")

    # doctor
    subparsers.add_parser("doctor", help="Perform preflight and system health checks")

    # pair
    p_pair = subparsers.add_parser("pair", help="Generate an 8-digit device pairing code")
    p_pair.add_argument("--state-dir", help="Path to state directory (default: /var/lib/darjeeling)")

    # devices
    p_dev = subparsers.add_parser("devices", help="Manage paired devices")
    p_dev_sub = p_dev.add_subparsers(dest="device_command", required=True)
    p_dev_sub.add_parser("list", help="List all paired devices")
    p_dev_rev = p_dev_sub.add_parser("revoke", help="Revoke a device by ID")
    p_dev_rev.add_argument("device_id", help="Device ID to revoke")

    # logs
    p_logs = subparsers.add_parser("logs", help="Follow service logs via journalctl")
    p_logs.add_argument("extra_args", nargs="*", default=[], help="Extra arguments to journalctl")

    # config
    p_conf = subparsers.add_parser("config", help="Get or set configuration options")
    p_conf_sub = p_conf.add_subparsers(dest="config_command", required=True)
    p_conf_get = p_conf_sub.add_parser("get", help="Get configuration value")
    p_conf_get.add_argument("key", help="Configuration key (permission-ceiling, max-concurrent-turns, bind, vault, vault-sync, deepseek-api-key)")
    p_conf_set = p_conf_sub.add_parser("set", help="Set configuration value")
    p_conf_set.add_argument("key", help="Configuration key")
    p_conf_set.add_argument("val", nargs="?", default=None, help="Value to set (reads stdin if omitted for secrets)")

    # upgrade
    p_upg = subparsers.add_parser("upgrade", help="Upgrade server release")
    p_upg.add_argument("--tarball", help="Path to release tarball")
    p_upg.add_argument("--force", action="store_true", help="Force upgrade even if turns are running")
    p_upg.add_argument("--rebuild-venv", action="store_true", help="Rebuild Python venv for current release")

    # rollback
    p_rb = subparsers.add_parser("rollback", help="Roll back release")
    p_rb.add_argument("--to-legacy", action="store_true", help="Roll back to captured legacy 4.1.0 unit")

    # uninstall
    p_un = subparsers.add_parser("uninstall", help="Uninstall Darjeeling server")
    p_un.add_argument("--purge", action="store_true", help="Remove all state and configuration")
    p_un.add_argument("--delete-vault", action="store_true", help="Delete vault directory")
    p_un.add_argument("--remove-user", action="store_true", help="Delete system service user")

    args = parser.parse_args(argv)

    if not args.command:
        parser.print_help()
        return 0

    # See the same configuration as darjeeling.service (state dir, token path).
    load_env_into_environ()
    if args.command == "pair" and getattr(args, "state_dir", None):
        os.environ["DARJEELING_STATE_DIR"] = args.state_dir
    _refresh_paths()

    if args.command in STATE_WRITING_COMMANDS:
        drop_privileges()

    dispatch = {
        "version": cmd_version,
        "status": cmd_status,
        "doctor": cmd_doctor,
        "pair": cmd_pair,
        "devices": cmd_devices,
        "logs": cmd_logs,
        "config": cmd_config,
        "upgrade": cmd_upgrade,
        "rollback": cmd_rollback,
        "uninstall": cmd_uninstall,
    }

    fn = dispatch.get(args.command)
    if fn:
        return fn(args)

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())

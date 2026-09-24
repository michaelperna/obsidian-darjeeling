"""Configuration and environment detection for Darjeeling server."""

import ipaddress
import logging
import os
import re
import secrets
import subprocess
import time
from pathlib import Path
from typing import Dict, Optional

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [darjeeling] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("darjeeling")

VERSION = "1.0.2"  # keep in sync with plugin/manifest.json (single source of truth)
SERVER_DIR = Path(__file__).resolve().parent.parent

# Ensure standard user binary directories are in PATH so daemon processes find claude, agy, etc.
# INST-23 / QA-35: PATH additions are appended, never prepended.
USER_BIN_DIRS = [
    str(Path.home() / ".local/bin"),
    str(Path.home() / ".cargo/bin"),
    str(Path.home() / ".bun/bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
]
_current_path = os.environ.get("PATH", "").split(os.pathsep) if os.environ.get("PATH") else []
for _d in USER_BIN_DIRS:
    if os.path.isdir(_d) and _d not in _current_path:
        _current_path.append(_d)
os.environ["PATH"] = os.pathsep.join(_current_path)


def _resolve_state_dir() -> Path:
    """Resolve DARJEELING_STATE_DIR (ADR-15)."""
    env_dir = os.environ.get("DARJEELING_STATE_DIR", "").strip()
    if env_dir:
        p = Path(os.path.expanduser(env_dir)).resolve()
        p.mkdir(parents=True, exist_ok=True)
        return p
    var_lib = Path("/var/lib/darjeeling")
    try:
        if var_lib.exists() and os.access(var_lib, os.W_OK):
            return var_lib.resolve()
    except Exception:
        pass
    home_state = Path.home() / ".local" / "state" / "darjeeling"
    try:
        home_state.mkdir(parents=True, exist_ok=True)
        return home_state.resolve()
    except Exception:
        pass
    fallback = SERVER_DIR / ".state"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback.resolve()


STATE_DIR = _resolve_state_dir()

VAULT_PATH = Path(
    os.path.expanduser(os.environ.get("DARJEELING_VAULT", "~/vault"))
).resolve()

# ARTIFACT_DIR resolved and defaulting to $STATE_DIR/artifacts (SRV-16, DOC-47).
ARTIFACT_DIR = Path(
    os.path.expanduser(
        os.environ.get("DARJEELING_ARTIFACTS", str(STATE_DIR / "artifacts"))
    )
).resolve()

# Tmux socket and runtime directory per ADR-15/16
DARJEELING_TMUX_SOCKET = os.environ.get("DARJEELING_TMUX_SOCKET", "darjeeling")
TMUX_TMPDIR = os.environ.get("TMUX_TMPDIR", str(STATE_DIR / "tmux"))

DEFAULT_SESSION = os.environ.get("DARJEELING_SESSION", "darjeeling")
TOKEN_FILE = Path(
    os.path.expanduser(
        os.environ.get("DARJEELING_TOKEN_FILE", str(STATE_DIR / "token"))
    )
).resolve()

DEFAULT_COLS, DEFAULT_ROWS = 120, 34

TURN_TIMEOUT = int(os.environ.get("DARJEELING_TURN_TIMEOUT", "1800"))
MAX_CONCURRENT_TURNS = int(os.environ.get("DARJEELING_MAX_CONCURRENT_TURNS", "2"))
TURN_BUFFER_BUDGET = int(
    os.environ.get("DARJEELING_TURN_BUFFER_BUDGET", str(128 * 1024 * 1024))
)
VAULT_SYNC = os.environ.get("DARJEELING_VAULT_SYNC", "").strip() or None


def get_deepseek_api_key() -> str:
    secret_file = STATE_DIR / "secrets" / "deepseek_api_key"
    try:
        if secret_file.is_file():
            val = secret_file.read_text(encoding="utf-8").strip()
            if val:
                return val
    except Exception:
        pass
    return os.environ.get("DEEPSEEK_API_KEY", "").strip()


DEEPSEEK_API_KEY = get_deepseek_api_key()
DEEPSEEK_BASE_URL = os.environ.get(
    "DEEPSEEK_BASE_URL", "https://api.deepseek.com"
).rstrip("/")
DEEPSEEK_SESSION_DIR = STATE_DIR / "deepseek_sessions"

# Access log default off (G-34, SRV-29, QA-12)
ACCESS_LOG = os.environ.get("DARJEELING_ACCESS_LOG", "0") == "1"
ALLOW_PUBLIC_BIND = os.environ.get("DARJEELING_ALLOW_PUBLIC_BIND", "0") == "1"

# Permission ceiling (ADR-07, G-06)
VALID_PERMISSION_CEILINGS = {"plan", "acceptEdits", "bypassPermissions"}


def _resolve_permission_ceiling() -> str:
    raw = os.environ.get("DARJEELING_PERMISSION_CEILING", "acceptEdits").strip()
    if raw not in VALID_PERMISSION_CEILINGS:
        log.warning(
            "Invalid DARJEELING_PERMISSION_CEILING '%s'; falling back to 'acceptEdits'. Valid: %s",
            raw,
            VALID_PERMISSION_CEILINGS,
        )
        return "acceptEdits"
    return raw


PERMISSION_RANK = {
    "plan": 0,
    "acceptEdits": 1,
    "accept-edits": 1,
    "dontAsk": 1,
    "bypassPermissions": 2,
    "acceptAll": 2,
}

PERMISSION_CEILING = _resolve_permission_ceiling()


def _validate_token_charset(token: str) -> bool:
    """Token charset validated: ASCII printable, no whitespace or control characters (SRV-39)."""
    if not token:
        return False
    return all(33 <= ord(c) <= 126 for c in token)


def _resolve_token() -> str:
    """
    Secure token resolution (SRV-31, SRV-39).
    DARJEELING_ALLOW_ANONYMOUS deleted.
    Token file created O_EXCL 0600 and source logged.
    """
    env_token = os.environ.get("DARJEELING_TOKEN", "").strip()
    if env_token:
        if not _validate_token_charset(env_token):
            raise ValueError(
                "DARJEELING_TOKEN contains invalid characters; must be printable ASCII without whitespace."
            )
        log.info("Auth: token loaded from environment variable DARJEELING_TOKEN")
        return env_token

    if TOKEN_FILE.exists():
        existing = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if existing:
            if not _validate_token_charset(existing):
                raise ValueError(
                    f"Token file {TOKEN_FILE} contains invalid characters."
                )
            log.info("Auth: token loaded from %s", TOKEN_FILE)
            return existing

    minted = secrets.token_urlsafe(32)
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(
        str(TOKEN_FILE),
        os.O_CREAT | os.O_EXCL | os.O_WRONLY,
        0o600,
    )
    with open(fd, "w", encoding="utf-8") as f:
        f.write(minted + "\n")
    log.warning("Auth: No token found -- minted one at %s (0600)", TOKEN_FILE)
    return minted


AUTH_TOKEN = _resolve_token()


def _is_private_ip(ip_str: str) -> bool:
    """Check if IP is loopback, RFC 1918 private, or 100.64.0.0/10 CGNAT / Meshnet."""
    try:
        addr = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    if addr.is_loopback or addr.is_private:
        return True
    try:
        cgnat = ipaddress.ip_network("100.64.0.0/10")
        if addr in cgnat:
            return True
    except ValueError:
        pass
    return False


def _get_interface_ip(iface: str) -> Optional[str]:
    """Retrieve IPv4 address for interface name."""
    try:
        res = subprocess.run(
            ["ip", "-4", "-o", "addr", "show", "dev", iface],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
        if res.returncode == 0 and res.stdout:
            match = re.search(r"inet\s+(\d+\.\d+\.\d+\.\d+)", res.stdout)
            if match:
                return match.group(1)
    except Exception:
        pass

    try:
        res = subprocess.run(
            ["ifconfig", iface],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
        if res.returncode == 0 and res.stdout:
            match = re.search(r"inet\s+(\d+\.\d+\.\d+\.\d+)", res.stdout)
            if match:
                return match.group(1)
    except Exception:
        pass
    return None


def default_bind(timeout: float = 60.0) -> str:
    """
    Resolve listen address per ADR-15/16 (INST-25, QA-19, SRV-22).
    DARJEELING_BIND accepts loopback | address:IP | interface:NAME.
    Retries for up to 60 s then fails loudly; no 100.64/10 guessing and no silent 127.0.0.1 fallback.
    Non-private binds refused unless DARJEELING_ALLOW_PUBLIC_BIND=1.
    """
    bind_spec = os.environ.get("DARJEELING_BIND", "").strip()
    if not bind_spec:
        bind_spec = os.environ.get("DARJEELING_HOST", "").strip()
    if not bind_spec or bind_spec == "loopback":
        return "127.0.0.1"

    target_ip: Optional[str] = None
    if bind_spec.startswith("address:"):
        target_ip = bind_spec[len("address:") :].strip()
    elif bind_spec.startswith("interface:"):
        iface = bind_spec[len("interface:") :].strip()
        log.info("Resolving IPv4 address for interface '%s' (timeout %ds)...", iface, int(timeout))
        deadline = time.time() + timeout
        while time.time() < deadline:
            ip = _get_interface_ip(iface)
            if ip:
                target_ip = ip
                break
            time.sleep(1.0)
        if not target_ip:
            raise RuntimeError(
                f"Interface '{iface}' has no IPv4 address after {int(timeout)}s; cannot bind."
            )
    else:
        target_ip = bind_spec

    if not _is_private_ip(target_ip):
        if not ALLOW_PUBLIC_BIND:
            raise RuntimeError(
                f"Refusing to bind to non-private address '{target_ip}' without DARJEELING_ALLOW_PUBLIC_BIND=1"
            )
        log.warning(
            "Binding to non-private address '%s' because DARJEELING_ALLOW_PUBLIC_BIND=1",
            target_ip,
        )

    return target_ip


def child_env(base_env: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """
    Return clean environment for child processes (ADR-15, INST-23, QA-35).
    Strips DARJEELING_* and DEEPSEEK_API_KEY. Keeps ANTHROPIC_API_KEY.
    PATH additions appended, never prepended.
    """
    env = dict(base_env if base_env is not None else os.environ)
    for k in list(env.keys()):
        if k.startswith("DARJEELING_") or k == "DEEPSEEK_API_KEY":
            del env[k]

    path_parts = env.get("PATH", "").split(os.pathsep) if env.get("PATH") else []
    for d in USER_BIN_DIRS:
        if d not in path_parts and os.path.isdir(d):
            path_parts.append(d)
    env["PATH"] = os.pathsep.join(path_parts)
    return env

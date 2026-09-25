"""
Pairing and device token management.

Pairing codes are 8 digits, single use, stored hashed, and valid for 10 minutes.
Failed claims are rate limited per client address (and with a looser global
cap); a wrong guess never burns other people's live codes.
"""

import hashlib
import json
import logging
import os
import re
import secrets
import socket
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from darjeeling_server.auth import close_device_sockets, require_auth
from darjeeling_server.config import AUTH_TOKEN, STATE_DIR

log = logging.getLogger("darjeeling.pairing")

DEVICES_FILE = STATE_DIR / "devices.json"
PAIRING_FILE = STATE_DIR / "pairing.json"
CODE_TTL_SECONDS = 600  # 10 minutes


def _env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, str(default))))
    except ValueError:
        return default


# Failed claims allowed per client address inside FAILURE_WINDOW_SECONDS.
MAX_FAILURES_PER_CLIENT = _env_int("DARJEELING_PAIR_MAX_FAILURES_PER_CLIENT", 10)
# Failed claims allowed across all clients inside FAILURE_WINDOW_SECONDS.
MAX_FAILURES_GLOBAL = _env_int("DARJEELING_PAIR_MAX_FAILURES_GLOBAL", 100)
FAILURE_WINDOW_SECONDS = _env_int("DARJEELING_PAIR_FAILURE_WINDOW", CODE_TTL_SECONDS)

router = APIRouter(tags=["pairing"])

# client address -> timestamps of recent failed claims
_failures: Dict[str, List[float]] = {}


def _prune_failures(now: float) -> None:
    cutoff = now - FAILURE_WINDOW_SECONDS
    for key in list(_failures.keys()):
        recent = [t for t in _failures[key] if t > cutoff]
        if recent:
            _failures[key] = recent
        else:
            del _failures[key]


def _global_failures() -> int:
    return sum(len(v) for v in _failures.values())


def _record_failure(client: str, now: float) -> None:
    _failures.setdefault(client, []).append(now)


def reset_rate_limits() -> None:
    """Clear failed-claim counters (used by tests and on restart)."""
    _failures.clear()


def _client_key(request: Optional[Request]) -> str:
    """Best-effort client address for rate limiting.

    When the direct peer is loopback (Tailscale Serve or another local reverse
    proxy), use the right-most X-Forwarded-For entry, which is the one the
    proxy appended. Headers from non-loopback peers are ignored.
    """
    if request is None or request.client is None:
        return "unknown"
    peer = request.client.host or "unknown"
    if peer in ("127.0.0.1", "::1", "localhost"):
        fwd = request.headers.get("x-forwarded-for", "")
        parts = [p.strip() for p in fwd.split(",") if p.strip()]
        if parts:
            return parts[-1]
    return peer


def _atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_dir = path.parent
    with tempfile.NamedTemporaryFile("w", dir=temp_dir, delete=False, encoding="utf-8") as tf:
        json.dump(data, tf, indent=2)
        tf.flush()
        os.fsync(tf.fileno())
        temp_name = tf.name
    os.chmod(temp_name, 0o600)
    os.replace(temp_name, path)


def _legacy_record() -> Dict[str, Any]:
    now_iso = datetime.now(timezone.utc).isoformat()
    return {
        "device_id": "legacy",
        "token_hash": hashlib.sha256(AUTH_TOKEN.encode("utf-8")).hexdigest(),
        "device_name": "Legacy 4.1.0 Token",
        "platform": "unknown",
        "created": now_iso,
        "last_seen": now_iso,
        "revoked": False,
    }


def ensure_legacy_record() -> str:
    """Startup check that the host token keeps working after an upgrade.

    Returns what happened: "created" (no devices.json yet, seeded with the
    host token), "seeded" (devices.json had no legacy record, one was added),
    "present" (a legacy record exists, revoked or not -- a revocation is
    never undone), "unreadable" (fail closed, error logged) or "no-token".

    Hosts installed or upgraded by 1.0.3 and earlier can have a devices.json
    without a "legacy" record; 1.0.4 would then refuse the host token that
    their existing clients use.
    """
    if not AUTH_TOKEN:
        return "no-token"
    if not DEVICES_FILE.exists():
        init_devices_if_needed()
        return "created"
    try:
        with open(DEVICES_FILE, "r", encoding="utf-8") as f:
            devices = json.load(f)
        if not isinstance(devices, list):
            raise ValueError(f"expected a JSON list, got {type(devices).__name__}")
    except Exception as e:
        log.error(
            "Auth: cannot read %s (%s). The host token and every paired device are "
            "refused until this is fixed. Check that the file is valid JSON and owned "
            "by the service user with mode 0600 (sudo chown darjeeling:darjeeling %s && "
            "sudo chmod 600 %s), then restart: sudo systemctl restart darjeeling.service. "
            "If it cannot be repaired, move it aside and restart; that re-creates it with "
            "only the host token, and other devices must pair again.",
            DEVICES_FILE, e, DEVICES_FILE, DEVICES_FILE,
        )
        return "unreadable"
    if any(isinstance(d, dict) and d.get("device_id") == "legacy" for d in devices):
        return "present"
    devices.append(_legacy_record())
    try:
        _atomic_write_json(DEVICES_FILE, devices)
    except Exception as e:
        log.error(
            "Auth: could not add the host token to %s (%s); clients using the host token "
            "will be refused. Check the file's ownership and permissions.",
            DEVICES_FILE, e,
        )
        return "unreadable"
    log.warning(
        "Auth: %s had no legacy record; added one for the current host token so existing "
        "clients keep working. Revoke it with: sudo darjeeling devices revoke legacy",
        DEVICES_FILE,
    )
    return "seeded"


def init_devices_if_needed() -> List[Dict[str, Any]]:
    """Initialize devices.json with legacy token if missing (ADR-12)."""
    if DEVICES_FILE.exists():
        try:
            with open(DEVICES_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            log.warning("Could not read devices file %s: %s", DEVICES_FILE, e)
            return []

    devices: List[Dict[str, Any]] = []
    if AUTH_TOKEN:
        devices.append(_legacy_record())
        try:
            _atomic_write_json(DEVICES_FILE, devices)
            log.info("Initialized %s with legacy device token", DEVICES_FILE)
        except Exception as e:
            log.warning("Could not initialize %s: %s", DEVICES_FILE, e)
    return devices


def load_devices() -> List[Dict[str, Any]]:
    return init_devices_if_needed()


def save_devices(devices: List[Dict[str, Any]]) -> None:
    _atomic_write_json(DEVICES_FILE, devices)


def touch_device_last_seen(device_id: str) -> None:
    """Update last_seen timestamp for a device (debounced to once per 60s)."""
    try:
        devices = load_devices()
        now_dt = datetime.now(timezone.utc)
        updated = False
        for d in devices:
            if d.get("device_id") == device_id and not d.get("revoked"):
                last_seen_str = d.get("last_seen")
                if last_seen_str:
                    try:
                        last_dt = datetime.fromisoformat(last_seen_str)
                        if (now_dt - last_dt).total_seconds() < 60:
                            return
                    except Exception:
                        pass
                d["last_seen"] = now_dt.isoformat()
                updated = True
                break
        if updated:
            save_devices(devices)
    except Exception as e:
        log.debug("Error updating last_seen for %s: %s", device_id, e)


def load_pairing_codes() -> List[Dict[str, Any]]:
    if not PAIRING_FILE.exists():
        return []
    try:
        with open(PAIRING_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except PermissionError as e:
        try:
            st = PAIRING_FILE.stat()
            owner = f"uid={st.st_uid} gid={st.st_gid} mode={oct(st.st_mode & 0o777)}"
        except OSError:
            owner = "unknown owner"
        log.error(
            "Cannot read pairing file %s (%s; running as uid=%s): %s. "
            "Codes created by another user cannot be claimed. Fix ownership with: "
            "sudo chown <service-user>: %s  (or create codes with `sudo darjeeling pair`, "
            "which runs as the service user).",
            PAIRING_FILE,
            owner,
            os.getuid() if hasattr(os, "getuid") else "?",
            e,
            PAIRING_FILE,
        )
        return []
    except Exception as e:
        log.warning("Could not read pairing file %s: %s", PAIRING_FILE, e)
        return []


def save_pairing_codes(codes: List[Dict[str, Any]]) -> None:
    _atomic_write_json(PAIRING_FILE, codes)


def create_code() -> str:
    """
    Generate an 8-digit single-use pairing code (4+4), stored hashed (ADR-12, PRD 1.8).
    Valid for 10 minutes.
    """
    code_digits = f"{secrets.randbelow(100000000):08d}"
    code_hash = hashlib.sha256(code_digits.encode("utf-8")).hexdigest()
    now = time.time()

    codes = load_pairing_codes()
    codes = [
        c
        for c in codes
        if (now - c.get("created_at", 0)) < CODE_TTL_SECONDS and not c.get("burned")
    ]
    codes.append(
        {
            "code_hash": code_hash,
            "created_at": now,
            "attempts": 0,
            "burned": False,
        }
    )
    save_pairing_codes(codes)
    return code_digits


create_pairing_code = create_code


def list_devices() -> List[Dict[str, Any]]:
    """List registered devices (never exposes token_hash)."""
    devices = load_devices()
    result = []
    for d in devices:
        if d.get("revoked"):
            continue
        result.append(
            {
                "device_id": d.get("device_id"),
                "device_name": d.get("device_name", "Unknown Device"),
                "platform": d.get("platform", "unknown"),
                "created": d.get("created"),
                "last_seen": d.get("last_seen", d.get("created")),
                "is_legacy": d.get("device_id") == "legacy",
            }
        )
    return result


async def revoke_async(device_id: str) -> bool:
    """
    Revoke a device: remove from devices.json and close open sockets with 4401 in < 1s (G-31).
    """
    devices = load_devices()
    found = False
    for d in devices:
        if d.get("device_id") == device_id and not d.get("revoked"):
            d["revoked"] = True
            found = True
            break
    if not found:
        return False

    save_devices(devices)
    await close_device_sockets(device_id)
    return True


def revoke(device_id: str) -> bool:
    """Synchronous revoke for CLI consumption (INST-26)."""
    devices = load_devices()
    found = False
    for d in devices:
        if d.get("device_id") == device_id and not d.get("revoked"):
            d["revoked"] = True
            found = True
            break
    if not found:
        return False

    save_devices(devices)
    try:
        import asyncio

        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.create_task(close_device_sockets(device_id))
    except Exception:
        pass
    return True


class PairRequest(BaseModel):
    code: str
    device_name: Optional[str] = "Obsidian Client"
    platform: Optional[str] = "unknown"


@router.post("/api/pair")
async def pair_endpoint(req: PairRequest, request: Request):
    """
    Unauthenticated, code-gated device pairing.
    Returns {token, device_id, server_name, api}.
    """
    now = time.time()
    client = _client_key(request)
    _prune_failures(now)

    if len(_failures.get(client, [])) >= MAX_FAILURES_PER_CLIENT:
        log.warning("Pairing: client %s is rate limited after repeated failures", client)
        raise HTTPException(
            status_code=429,
            detail="Too many failed pairing attempts. Please wait and try again.",
            headers={"Retry-After": str(FAILURE_WINDOW_SECONDS)},
        )
    if _global_failures() >= MAX_FAILURES_GLOBAL:
        log.warning("Pairing: global failed-claim limit reached; refusing claims for now")
        raise HTTPException(
            status_code=429,
            detail="Too many failed pairing attempts. Please wait and try again.",
            headers={"Retry-After": str(FAILURE_WINDOW_SECONDS)},
        )

    raw_code = re.sub(r"[\s\-]", "", req.code.strip())
    if not (len(raw_code) == 8 and raw_code.isdigit()):
        _record_failure(client, now)
        raise HTTPException(
            status_code=401, detail="Invalid pairing code format; must be 8 digits"
        )

    candidate_hash = hashlib.sha256(raw_code.encode("utf-8")).hexdigest()
    codes = load_pairing_codes()
    matched_idx: Optional[int] = None

    for i, c in enumerate(codes):
        if c.get("burned"):
            continue
        if (now - c.get("created_at", 0)) > CODE_TTL_SECONDS:
            continue
        if secrets.compare_digest(candidate_hash, c.get("code_hash", "")):
            matched_idx = i
            break

    if matched_idx is None:
        # A wrong guess cannot be attributed to a particular code, so it only
        # counts against the caller's address; other users' codes stay live.
        _record_failure(client, now)
        raise HTTPException(status_code=401, detail="Invalid or expired pairing code")

    codes[matched_idx]["burned"] = True
    save_pairing_codes(codes)
    _failures.pop(client, None)

    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    device_id = f"dev_{secrets.token_hex(6)}"
    now_iso = datetime.now(timezone.utc).isoformat()

    devices = load_devices()
    devices.append(
        {
            "device_id": device_id,
            "token_hash": token_hash,
            "device_name": req.device_name or "Obsidian Client",
            "platform": req.platform or "unknown",
            "created": now_iso,
            "last_seen": now_iso,
            "revoked": False,
        }
    )
    save_devices(devices)

    server_name = os.environ.get("DARJEELING_SERVER_NAME") or socket.gethostname().split(".")[0]
    return {
        "token": token,
        "device_id": device_id,
        "server_name": server_name,
        "api": "1.0.0",
    }


@router.post("/api/pair/code", dependencies=[Depends(require_auth)])
async def pair_code_endpoint():
    """
    Authenticated endpoint to generate an 8-digit pairing code for 'Pair your phone' (PRD 1.8).
    """
    code = create_code()
    formatted = f"{code[:4]} {code[4:]}"
    return {
        "code": code,
        "formatted_code": formatted,
        "expires_in": CODE_TTL_SECONDS,
    }


@router.get("/api/devices", dependencies=[Depends(require_auth)])
async def get_devices():
    """List registered devices (authenticated)."""
    return {"devices": list_devices()}


@router.delete("/api/devices/{device_id}", dependencies=[Depends(require_auth)])
async def delete_device(device_id: str):
    """Revoke a device (authenticated). Closes active sockets with 4401 in < 1s."""
    ok = await revoke_async(device_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Device not found")
    return {"revoked": True, "device_id": device_id}

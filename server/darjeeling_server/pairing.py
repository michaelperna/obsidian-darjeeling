"""
Pairing and device token management (ADR-12, PRD 1.8, G-31, G-35, INST-26).
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

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from darjeeling_server.auth import close_device_sockets, require_auth
from darjeeling_server.config import AUTH_TOKEN, STATE_DIR

log = logging.getLogger("darjeeling.pairing")

DEVICES_FILE = STATE_DIR / "devices.json"
PAIRING_FILE = STATE_DIR / "pairing.json"
CODE_TTL_SECONDS = 600  # 10 minutes
MAX_FAILED_ATTEMPTS = 5

router = APIRouter(tags=["pairing"])

# Global backoff state (G-35)
_last_failure_time: float = 0.0
_consecutive_failures: int = 0


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
        legacy_hash = hashlib.sha256(AUTH_TOKEN.encode("utf-8")).hexdigest()
        now_iso = datetime.now(timezone.utc).isoformat()
        devices.append(
            {
                "device_id": "legacy",
                "token_hash": legacy_hash,
                "device_name": "Legacy 4.1.0 Token",
                "platform": "unknown",
                "created": now_iso,
                "last_seen": now_iso,
                "revoked": False,
            }
        )
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
async def pair_endpoint(req: PairRequest):
    """
    Unauthenticated, code-gated device pairing (ADR-12, PRD 1.8).
    Returns {token, device_id, server_name, api}.
    """
    global _last_failure_time, _consecutive_failures

    now = time.time()
    if _consecutive_failures >= 10 and (now - _last_failure_time) < 2.0:
        raise HTTPException(
            status_code=429, detail="Too many failed pairing attempts. Please wait."
        )

    raw_code = re.sub(r"[\s\-]", "", req.code.strip())
    if not (len(raw_code) == 8 and raw_code.isdigit()):
        _consecutive_failures += 1
        _last_failure_time = now
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
        if c.get("attempts", 0) >= MAX_FAILED_ATTEMPTS:
            continue

        if secrets.compare_digest(candidate_hash, c.get("code_hash", "")):
            matched_idx = i
            break

    if matched_idx is None:
        for c in codes:
            if not c.get("burned") and (now - c.get("created_at", 0)) <= CODE_TTL_SECONDS:
                c["attempts"] = c.get("attempts", 0) + 1
                if c["attempts"] >= MAX_FAILED_ATTEMPTS:
                    c["burned"] = True
        save_pairing_codes(codes)
        _consecutive_failures += 1
        _last_failure_time = now
        raise HTTPException(status_code=401, detail="Invalid or expired pairing code")

    codes[matched_idx]["burned"] = True
    save_pairing_codes(codes)
    _consecutive_failures = 0

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

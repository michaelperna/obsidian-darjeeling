"""Authentication helpers for HTTP and WebSocket endpoints (ADR-12, G-31)."""

import hashlib
import logging
import secrets
from typing import Dict, List, Optional, Set, Tuple

from fastapi import Header, HTTPException, WebSocket

from darjeeling_server.config import AUTH_TOKEN

log = logging.getLogger("darjeeling.auth")

ALLOWED_ORIGIN_PREFIXES = (
    "app://obsidian.md",
    "capacitor://localhost",
    "http://localhost",
    "http://127.0.0.1",
)

# Active WebSocket connection registry (ADR-12, G-31)
_ACTIVE_WS: Dict[str, Set[WebSocket]] = {}
_WS_TO_DEVICE: Dict[WebSocket, str] = {}


def register_ws(device_id: str, websocket: WebSocket) -> None:
    """Register an open WebSocket under a device_id."""
    if device_id not in _ACTIVE_WS:
        _ACTIVE_WS[device_id] = set()
    _ACTIVE_WS[device_id].add(websocket)
    _WS_TO_DEVICE[websocket] = device_id


def unregister_ws(websocket: WebSocket) -> None:
    """Unregister an active WebSocket."""
    device_id = _WS_TO_DEVICE.pop(websocket, None)
    if device_id and device_id in _ACTIVE_WS:
        _ACTIVE_WS[device_id].discard(websocket)
        if not _ACTIVE_WS[device_id]:
            del _ACTIVE_WS[device_id]


def get_active_device_ids() -> List[str]:
    """Return all device IDs currently having active WebSocket connections."""
    return list(_ACTIVE_WS.keys())


async def close_device_sockets(device_id: str) -> int:
    """
    Close all open WebSockets for device_id with close code 4401 within 1 s (ADR-12, G-31).
    """
    sockets = list(_ACTIVE_WS.pop(device_id, set()))
    for ws in sockets:
        _WS_TO_DEVICE.pop(ws, None)
        try:
            await ws.close(code=4401, reason="device revoked")
        except Exception as e:
            log.debug("Error closing socket for revoked device %s: %s", device_id, e)
    return len(sockets)


def is_origin_allowed(origin: Optional[str]) -> bool:
    """
    Validate WebSocket Origin header against allowed origins (SRV-21).
    Requests with no Origin header (CLI tools, curl, tests) are allowed.
    """
    if origin is None:
        return True
    return any(
        origin == prefix or origin.startswith(prefix + ":") or origin.startswith(prefix + "/")
        for prefix in ALLOWED_ORIGIN_PREFIXES
    )


def verify_token(candidate: Optional[str]) -> Tuple[bool, Optional[str]]:
    """
    Authenticate candidate token against devices.json and legacy AUTH_TOKEN (ADR-12, G-31).
    Returns (is_valid, device_id).
    """
    if not candidate:
        return False, None

    # Late import to prevent circular dependencies
    devices_ok = True
    try:
        from darjeeling_server.pairing import DEVICES_FILE, load_devices, touch_device_last_seen

        devices = load_devices()
        if not isinstance(devices, list):
            devices, devices_ok = [], False
    except Exception:
        DEVICES_FILE = None  # type: ignore[assignment]
        devices, devices_ok = [], False

    candidate_hash = hashlib.sha256(candidate.encode("utf-8")).hexdigest()

    # 1. Match against registered devices
    for dev in devices:
        if not isinstance(dev, dict) or dev.get("revoked"):
            continue
        token_hash = dev.get("token_hash", "")
        if token_hash and secrets.compare_digest(candidate_hash, token_hash):
            dev_id = dev.get("device_id", "unknown")
            touch_device_last_seen(dev_id)
            return True, dev_id

    # 2. Legacy AUTH_TOKEN: honoured only when the device list says so (a
    #    non-revoked "legacy" record), or when devices.json genuinely does not
    #    exist yet. An unreadable/corrupt devices.json fails CLOSED: it could
    #    be hiding a revocation of the legacy token.
    if AUTH_TOKEN and secrets.compare_digest(candidate.encode("utf-8"), AUTH_TOKEN.encode("utf-8")):
        legacy_dev = next(
            (d for d in devices if isinstance(d, dict) and d.get("device_id") == "legacy"), None
        )
        if legacy_dev is not None:
            if not legacy_dev.get("revoked"):
                return True, "legacy"
            return False, None
        if not devices_ok:
            log.warning("Auth: device list unavailable; refusing legacy token")
            return False, None
        try:
            devices_file_exists = DEVICES_FILE is not None and DEVICES_FILE.exists()
        except OSError:
            devices_file_exists = True
        if devices_file_exists:
            # devices.json exists but yielded no legacy record: either it was
            # removed on purpose or the file could not be read.
            return False, None
        return True, "legacy"

    return False, None


def _token_ok(candidate: Optional[str]) -> bool:
    """Backwards-compatible boolean token check (SRV-30)."""
    valid, _ = verify_token(candidate)
    return valid


async def require_auth(
    authorization: Optional[str] = Header(None),
    x_darjeeling_token: Optional[str] = Header(None),
) -> str:
    """
    Header-only auth for REST (ADR-12). Returns authenticated device_id.
    """
    candidate = x_darjeeling_token
    if not candidate and authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer":
            candidate = value.strip()

    valid, device_id = verify_token(candidate)
    if not valid:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return device_id or "unknown"


def ws_auth(
    websocket: WebSocket,
    query_token: Optional[str] = None,
    register: bool = True,
) -> Tuple[bool, Optional[str]]:
    """
    Authenticate a WebSocket handshake (SRV-21, SRV-29, QA-12, ADR-12, G-31).
    - Checks Origin allowlist (SRV-21).
    - Token rides Sec-WebSocket-Protocol or headers (x-darjeeling-token, Authorization).
    - Rejects query_token (SRV-29, QA-12).
    - Registers live WebSocket in active connection registry if register=True (G-31).
    """
    origin = websocket.headers.get("origin")
    if not is_origin_allowed(origin):
        return False, None

    candidate = None
    subprotocol = None
    matched_device_id = None

    offered = [
        p.strip()
        for p in websocket.headers.get("sec-websocket-protocol", "").split(",")
        if p.strip()
    ]

    for proto in offered:
        for prefix in ("darjeeling.token.", "darjeeling-auth.", "Bearer."):
            if proto.startswith(prefix):
                tok = proto[len(prefix) :]
                valid, dev_id = verify_token(tok)
                if valid:
                    candidate = tok
                    subprotocol = proto
                    matched_device_id = dev_id
                    break
        if candidate:
            break

    if not candidate:
        header = websocket.headers.get("x-darjeeling-token")
        if header:
            valid, dev_id = verify_token(header)
            if valid:
                candidate = header
                subprotocol = offered[0] if offered else None
                matched_device_id = dev_id

    if not candidate:
        auth_hdr = websocket.headers.get("authorization")
        if auth_hdr:
            scheme, _, value = auth_hdr.partition(" ")
            if scheme.lower() == "bearer":
                tok = value.strip()
                valid, dev_id = verify_token(tok)
                if valid:
                    candidate = tok
                    subprotocol = offered[0] if offered else None
                    matched_device_id = dev_id

    if candidate and matched_device_id:
        if register:
            register_ws(matched_device_id, websocket)
        return True, subprotocol

    return False, None

"""FastAPI application factory and route assembly for Darjeeling server."""

import logging
import re
from typing import List

from fastapi import Depends, FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from darjeeling_server.agents import AGENTS
from darjeeling_server.auth import require_auth, ws_auth
from darjeeling_server.config import (
    AUTH_TOKEN,
    VAULT_SYNC,
    VERSION,
    log,
)
from darjeeling_server.conversations import router as conversations_router
from darjeeling_server.host import router as host_router
from darjeeling_server.terminal import router as terminal_router
from darjeeling_server.turns import router as turns_router
from darjeeling_server.vault import router as vault_router

# Configure uvicorn.access logging (G-34, SRV-29, QA-12)
_QUERY_RE = re.compile(
    r"(\b(?:GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|WebSocket)\s+[^?\s\"']+)\?[^\s\"']*"
)


def _strip_query(text: str) -> str:
    """Drop the query string from a request path or a log line containing one."""
    if "token=" in text:
        text = re.sub(r"token=[^&\s'\"]+", "token=[REDACTED]", text)
    if text.startswith("/") and "?" in text:
        return text.split("?", 1)[0]
    return _QUERY_RE.sub(r"\1", text)


class AccessLogFilter(logging.Filter):
    """
    Strip query strings and redact tokens in access logs -- always, whether
    or not DARJEELING_ACCESS_LOG enables the access log. Query strings carry
    vault note paths (?path=...) and, for old clients, tokens.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if record.args and isinstance(record.args, tuple):
            record.args = tuple(
                _strip_query(arg) if isinstance(arg, str) else arg for arg in record.args
            )
        if isinstance(record.msg, str):
            record.msg = _strip_query(record.msg)
        return True


for _name in ("uvicorn.access", "uvicorn.error", "uvicorn"):
    _logger = logging.getLogger(_name)
    _logger.addFilter(AccessLogFilter())


class WebSocketAuthMiddleware:
    """
    ASGI middleware ensuring unauthorized WebSocket connections receive
    accept() then close(4401, 'token rejected') across all WS endpoints (QA-07).
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "websocket":
            # Sanitize token from query string so uvicorn never logs it (QA-12, SRV-29)
            qs = scope.get("query_string", b"")
            if b"token=" in qs:
                scope["query_string"] = re.sub(rb"(?:^|&)token=[^&\s]+", rb"", qs).lstrip(b"&")

            if scope.get("path") == "/ws/agent":
                ws = WebSocket(scope, receive=receive, send=send)
                allowed, _ = ws_auth(ws, register=False)
                if not allowed:
                    log.warning("Rejected /ws/agent from %s", ws.client.host if ws.client else "unknown")
                    await send({"type": "websocket.accept", "subprotocol": None})
                    await send({"type": "websocket.close", "code": 4401, "reason": "token rejected"})
                    return

        await self.app(scope, receive, send)


async def _devices_watcher_task() -> None:
    """Watch devices.json for CLI-driven modifications or revocations (ADR-12, G-31)."""
    import asyncio
    from darjeeling_server.auth import close_device_sockets, get_active_device_ids
    from darjeeling_server.config import STATE_DIR
    from darjeeling_server.pairing import load_devices

    devices_file = STATE_DIR / "devices.json"
    last_mtime_ns = devices_file.stat().st_mtime_ns if devices_file.exists() else 0

    while True:
        try:
            await asyncio.sleep(0.1)
            if devices_file.exists():
                mtime_ns = devices_file.stat().st_mtime_ns
                if mtime_ns != last_mtime_ns:
                    last_mtime_ns = mtime_ns
                    active_ids = get_active_device_ids()
                    if active_ids:
                        devices = load_devices()
                        revoked_or_missing = set(active_ids)
                        for d in devices:
                            if not d.get("revoked"):
                                revoked_or_missing.discard(d.get("device_id"))
                        for dev_id in revoked_or_missing:
                            await close_device_sockets(dev_id)
        except asyncio.CancelledError:
            break
        except Exception as e:
            log.debug("Error in devices watcher: %s", e)


from contextlib import asynccontextmanager


@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio
    from darjeeling_server.pairing import init_devices_if_needed

    init_devices_if_needed()
    watcher = asyncio.create_task(_devices_watcher_task())
    try:
        yield
    finally:
        watcher.cancel()


app = FastAPI(
    title="Project Darjeeling",
    version=VERSION,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)

app.add_middleware(WebSocketAuthMiddleware)

ALLOWED_ORIGINS: List[str] = [
    "app://obsidian.md",
    "capacitor://localhost",
    "http://localhost",
    "http://127.0.0.1",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    """
    Unauthenticated reachability probe per ADR-15/16 (SRV-28, INST-31, QA-31, G-60).
    Returns only {status, version, api, api_min, auth_required}.
    """
    return JSONResponse(
        {
            "status": "online",
            "version": VERSION,
            "api": 2,
            "api_min": 2,
            "auth_required": bool(AUTH_TOKEN),
        }
    )


@app.get("/api/agents", dependencies=[Depends(require_auth)])
async def list_agents():
    """
    Drives the plugin's model controls. Only agents whose binary is actually
    present report available -- v2's UI offered `agy` on a host where it was
    never installed, so picking it produced a session that died instantly.
    """
    return {
        "agents": [a.as_json() for a in AGENTS.values()],
        "vault_sync": VAULT_SYNC,
    }


# Include sub-routers
app.include_router(turns_router)
app.include_router(host_router)
app.include_router(conversations_router)
app.include_router(vault_router)
app.include_router(terminal_router)

from darjeeling_server.pairing import router as pairing_router
app.include_router(pairing_router)


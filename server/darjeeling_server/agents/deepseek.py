"""DeepSeek API agent driver."""

import asyncio
import json
import os
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from darjeeling_server.agents.base import AgentSpec
from darjeeling_server.agents.catalog import load_catalog
from darjeeling_server.config import (
    DEEPSEEK_BASE_URL,
    DEEPSEEK_SESSION_DIR,
    TURN_TIMEOUT,
    VAULT_PATH,
    get_deepseek_api_key,
)

if TYPE_CHECKING:
    from darjeeling_server.turns import TurnRequest


class DeepSeekAgent(AgentSpec):
    """
    Direct API agent, not a CLI. There is no DeepSeek binary that speaks
    stream-json the way Claude Code does, so this bypasses build_argv/
    subprocess entirely and talks to the chat completions endpoint over
    HTTP, translating the response into the same event envelope
    (system/init, assistant, result) the plugin already renders.
    """

    is_api = True

    def __init__(self):
        catalog = load_catalog().get("deepseek", {})
        models = [
            {"id": "deepseek-chat", "label": "DeepSeek-V3 (chat)"},
            {"id": "deepseek-reasoner", "label": "DeepSeek-R1 (reasoner)"},
        ]
        if "models" in catalog:
            models = [
                {"id": m["id"], "label": m.get("name", m["id"])}
                for m in catalog["models"]
                if m.get("id")
            ]
        super().__init__(
            key="deepseek",
            label="DeepSeek (API)",
            binary="",
            models=models,
            efforts=["n/a"],
            permission_modes=[{"id": "n/a", "label": "N/A — direct API call"}],
        )

    @property
    def path(self) -> Optional[str]:
        return DEEPSEEK_BASE_URL if self.available else None

    @property
    def available(self) -> bool:
        return bool(get_deepseek_api_key())

    def version(self) -> Optional[str]:
        return "DeepSeek API" if self.available else None

    def build_argv(self, req: "TurnRequest") -> List[str]:
        raise NotImplementedError("DeepSeek is an API agent; see run_api")

    def _session_path(self, session_id: str) -> Path:
        if not re.fullmatch(r"[0-9a-fA-F-]{8,64}", session_id):
            raise ValueError("invalid DeepSeek session id")
        return DEEPSEEK_SESSION_DIR / f"{session_id}.json"

    def _load_history(self, session_id: Optional[str]) -> List[Dict[str, str]]:
        if not session_id:
            return []
        path = self._session_path(session_id)
        if not path.exists():
            return []
        try:
            return json.loads(path.read_text()).get("messages", [])
        except (json.JSONDecodeError, OSError):
            return []

    def _save_history(self, session_id: str, messages: List[Dict[str, str]]) -> None:
        try:
            DEEPSEEK_SESSION_DIR.mkdir(parents=True, exist_ok=True)
            os.chmod(DEEPSEEK_SESSION_DIR, 0o700)
        except Exception:
            pass
        # Bounded history: keep latest 100 messages
        bounded = messages[-100:]
        path = self._session_path(session_id)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"messages": bounded}, ensure_ascii=False))
        try:
            os.chmod(tmp, 0o600)
        except Exception:
            pass
        tmp.replace(path)
        try:
            os.chmod(path, 0o600)
        except Exception:
            pass

    async def run_api(self, req: "TurnRequest", emit) -> None:
        import uuid

        import httpx

        api_key = get_deepseek_api_key()
        if not api_key:
            await emit(
                {
                    "type": "dj.error",
                    "message": "DEEPSEEK_API_KEY is not set on the host.",
                    "terminal": True,
                }
            )
            return

        if not req.resume and req.session_id:
            try:
                if self._session_path(req.session_id).exists():
                    await emit(
                        {
                            "type": "dj.error",
                            "message": f"Session '{req.session_id}' already exists; use resume to continue.",
                            "terminal": True,
                        }
                    )
                    return
            except ValueError:
                pass

        session_id = req.resume or req.session_id or uuid.uuid4().hex
        if not re.fullmatch(r"[0-9a-fA-F-]{8,64}", session_id):
            await emit({"type": "dj.error", "message": "invalid DeepSeek session id"})
            return
        history = [] if (req.resume and req.fork) else self._load_history(req.resume)
        if req.fork:
            session_id = uuid.uuid4().hex

        messages: List[Dict[str, str]] = list(history)
        if req.append_system_prompt and not any(m.get("role") == "system" for m in messages):
            messages.insert(0, {"role": "system", "content": req.append_system_prompt})
        messages.append({"role": "user", "content": req.prompt})

        model = req.model or "deepseek-chat"

        await emit(
            {
                "type": "system",
                "subtype": "init",
                "session_id": session_id,
                "model": model,
                "cwd": req.cwd or str(VAULT_PATH),
                "tools": [],
                "permissionMode": "n/a",
            }
        )

        text_out = ""
        usage: Dict[str, Any] = {}
        error: Optional[str] = None

        try:
            async with httpx.AsyncClient(timeout=TURN_TIMEOUT) as client:
                async with client.stream(
                    "POST",
                    f"{DEEPSEEK_BASE_URL}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": model,
                        "messages": messages,
                        "stream": True,
                    },
                ) as resp:
                    if resp.status_code != 200:
                        body = await resp.aread()
                        error = f"DeepSeek API {resp.status_code}: {body.decode('utf-8', 'replace')[:500]}"
                    else:
                        async for line in resp.aiter_lines():
                            if not line.startswith("data:"):
                                continue
                            payload = line[len("data:"):].strip()
                            if payload == "[DONE]":
                                break
                            try:
                                chunk = json.loads(payload)
                            except json.JSONDecodeError:
                                continue
                            delta = (
                                chunk.get("choices", [{}])[0]
                                .get("delta", {})
                                .get("content")
                            )
                            if delta:
                                text_out += delta
                                await emit(
                                    {
                                        "type": "stream_event",
                                        "event": {
                                            "type": "content_block_delta",
                                            "delta": {
                                                "type": "text_delta",
                                                "text": delta,
                                            },
                                        },
                                    }
                                )
                            if chunk.get("usage"):
                                usage = chunk["usage"]
        except asyncio.CancelledError:
            raise
        except httpx.HTTPError as err:
            error = f"DeepSeek request failed: {err}"

        if error:
            await emit({"type": "dj.error", "message": error, "terminal": True})
            await emit(
                {
                    "type": "result",
                    "subtype": "error",
                    "is_error": True,
                    "session_id": session_id,
                    "result": error,
                }
            )
            return

        await emit(
            {
                "type": "assistant",
                "session_id": session_id,
                "message": {
                    "role": "assistant",
                    "model": model,
                    "content": [{"type": "text", "text": text_out}],
                    "stop_reason": "end_turn",
                    "usage": {
                        "input_tokens": usage.get("prompt_tokens"),
                        "output_tokens": usage.get("completion_tokens"),
                    },
                },
            }
        )

        messages.append({"role": "assistant", "content": text_out})
        self._save_history(session_id, messages)

        await emit(
            {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "session_id": session_id,
                "result": text_out,
                "num_turns": sum(1 for m in messages if m.get("role") == "user"),
                "usage": {
                    "input_tokens": usage.get("prompt_tokens"),
                    "output_tokens": usage.get("completion_tokens"),
                },
            }
        )

import asyncio
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query

from darjeeling_server.auth import require_auth
from darjeeling_server.config import VAULT_PATH

router = APIRouter(prefix="/api/agent/conversations", tags=["conversations"])


def project_store(cwd: Optional[str]) -> Path:
    """Claude Code slugs the working directory by replacing non-alphanumeric chars with '-'."""
    target = Path(cwd).expanduser().resolve() if cwd else VAULT_PATH
    slug = re.sub(r"[^A-Za-z0-9]", "-", str(target))
    return Path.home() / ".claude" / "projects" / slug


def _text_blocks(content: Any) -> List[str]:
    if isinstance(content, str):
        return [content] if content.strip() else []
    if isinstance(content, list):
        out = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text", "")
                if text.strip():
                    out.append(text)
        return out
    return []


def summarise_session(path: Path) -> Dict[str, Any]:
    first_user = ""
    last_user = ""
    turns = 0
    model = None
    tools = 0

    try:
        with path.open(encoding="utf-8", errors="replace") as handle:
            for line in handle:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                message = record.get("message") or {}
                kind = record.get("type")

                if kind == "user":
                    for text in _text_blocks(message.get("content")):
                        # Tool results come back as synthetic user turns; they
                        # are not something a person typed.
                        if text.startswith("<") or text.startswith("[Request"):
                            continue
                        turns += 1
                        if not first_user:
                            first_user = text
                        last_user = text
                elif kind == "assistant":
                    if message.get("model"):
                        model = message["model"]
                    content = message.get("content")
                    if isinstance(content, list):
                        tools += sum(
                            1 for b in content
                            if isinstance(b, dict) and b.get("type") == "tool_use"
                        )
    except OSError:
        pass

    stat = path.stat()
    return {
        "sessionId": path.stem,
        "modified": int(stat.st_mtime),
        "sizeBytes": stat.st_size,
        "turns": turns,
        "model": model,
        "toolCalls": tools,
        "firstMessage": first_user[:300],
        "lastMessage": last_user[:300],
    }


_SUMMARY_CACHE: Dict[Tuple[str, float], Dict[str, Any]] = {}


def summarise_session_cached(path: Path) -> Dict[str, Any]:
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return summarise_session(path)
    key = (str(path), mtime)
    if key in _SUMMARY_CACHE:
        return _SUMMARY_CACHE[key]
    res = summarise_session(path)
    _SUMMARY_CACHE[key] = res
    return res


@router.get("", dependencies=[Depends(require_auth)])
async def list_conversations(
    cwd: Optional[str] = Query(None),
    limit: int = Query(30, ge=1, le=200),
    min_turns: int = Query(1, ge=0),
):
    store = project_store(cwd)
    if not store.is_dir():
        return {"store": str(store), "conversations": []}

    def _scan() -> List[Dict[str, Any]]:
        files = sorted(store.glob("*.jsonl"), key=lambda f: f.stat().st_mtime, reverse=True)
        out = []
        for path in files[: limit * 4]:
            summary = summarise_session_cached(path)
            if summary["turns"] < min_turns:
                continue
            out.append(summary)
            if len(out) >= limit:
                break
        return out

    out = await asyncio.to_thread(_scan)
    return {"store": str(store), "conversations": out}


def _parse_messages(path: Path, limit: int) -> Tuple[List[Dict[str, Any]], bool]:
    messages: List[Dict[str, Any]] = []
    try:
        with path.open(encoding="utf-8", errors="replace") as handle:
            for line in handle:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                message = record.get("message") or {}
                kind = record.get("type")

                if kind == "user":
                    for text in _text_blocks(message.get("content")):
                        if text.startswith("<") or text.startswith("[Request"):
                            continue
                        messages.append({"role": "user", "text": text})
                elif kind == "assistant":
                    content = message.get("content")
                    texts = _text_blocks(content)
                    names = []
                    if isinstance(content, list):
                        names = [
                            b.get("name", "tool")
                            for b in content
                            if isinstance(b, dict) and b.get("type") == "tool_use"
                        ]
                    if texts or names:
                        messages.append(
                            {
                                "role": "assistant",
                                "text": "\n".join(texts),
                                "model": message.get("model"),
                                "tools": names,
                            }
                        )
    except OSError:
        pass

    return messages[-limit:], len(messages) > limit


@router.get("/{session_id}", dependencies=[Depends(require_auth)])
async def read_conversation(
    session_id: str,
    cwd: Optional[str] = Query(None),
    limit: int = Query(200, ge=1, le=2000),
):
    if not re.fullmatch(r"[0-9a-fA-F-]{8,64}", session_id):
        raise HTTPException(status_code=400, detail="Bad session id")

    path = project_store(cwd) / f"{session_id}.jsonl"
    if not path.is_file():
        # Fallback: search by session ID across ~/.claude/projects/*/<session_id>.jsonl
        projects_dir = Path.home() / ".claude" / "projects"
        if projects_dir.is_dir():
            matches = list(projects_dir.glob(f"*/{session_id}.jsonl"))
            if matches:
                path = matches[0]
            else:
                raise HTTPException(status_code=404, detail="No such conversation")
        else:
            raise HTTPException(status_code=404, detail="No such conversation")

    messages, truncated = await asyncio.to_thread(_parse_messages, path, limit)

    return {
        "sessionId": session_id,
        "messages": messages,
        "truncated": truncated,
    }

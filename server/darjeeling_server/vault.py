"""Vault synchronization and artifact endpoints."""

import asyncio
import contextlib
import hashlib
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from darjeeling_server.auth import require_auth
from darjeeling_server.config import ARTIFACT_DIR, VAULT_PATH

router = APIRouter(tags=["vault"])

FORBIDDEN_COMPONENTS = {".obsidian", ".git", ".trash", ".claude", "node_modules"}

BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svgz", ".ico",
    ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z",
    ".pdf", ".epub", ".docx", ".xlsx", ".pptx",
    ".exe", ".dll", ".so", ".dylib", ".bin",
    ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".wav",
    ".pyc", ".wasm",
}


def safe_join(base: Path, rel: str) -> Path:
    """
    Resolve `rel` under `base`, refusing empty, absolute, or escaping paths,
    and refusing access into internal/meta directories (SRV-19, SRV-20, SRV-34).
    """
    if not rel or not rel.strip():
        raise HTTPException(status_code=400, detail="Path cannot be empty")
    if rel.startswith("/") or rel.startswith("\\") or os.path.isabs(rel):
        raise HTTPException(status_code=400, detail="Absolute paths not allowed")

    base_resolved = base.resolve()
    target = (base / rel).resolve()

    if base_resolved not in target.parents and target != base_resolved:
        raise HTTPException(status_code=400, detail="Path escapes root")

    rel_parts = target.relative_to(base_resolved).parts
    if any(part in FORBIDDEN_COMPONENTS for part in rel_parts):
        raise HTTPException(status_code=403, detail="Access to protected directory forbidden")

    return target


class SyncFileRequest(BaseModel):
    path: str
    content: str
    base_sha256: Optional[str] = None


class ArtifactWriteRequest(BaseModel):
    path: str
    content: str


def _scan_artifacts(artifact_dir: Path) -> List[Dict[str, Any]]:
    if not artifact_dir.exists():
        return []
    out = []
    for path in sorted(artifact_dir.rglob("*.md")):
        with contextlib.suppress(OSError):
            stat = path.stat()
            out.append(
                {
                    "path": str(path.relative_to(artifact_dir)),
                    "size": stat.st_size,
                    "modified": int(stat.st_mtime),
                }
            )
    return out


@router.get("/api/artifacts", dependencies=[Depends(require_auth)])
async def list_artifacts():
    artifacts = await asyncio.to_thread(_scan_artifacts, ARTIFACT_DIR)
    return {"root": str(ARTIFACT_DIR), "artifacts": artifacts}


@router.get("/api/artifacts/read", dependencies=[Depends(require_auth)])
async def read_artifact(path: str = Query(...)):
    target = safe_join(ARTIFACT_DIR, path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    try:
        return {"path": path, "content": target.read_text(encoding="utf-8", errors="replace")}
    except OSError as err:
        raise HTTPException(status_code=500, detail=str(err))


@router.post("/api/artifacts/write", dependencies=[Depends(require_auth)])
async def write_artifact(req: ArtifactWriteRequest):
    target = safe_join(ARTIFACT_DIR, req.path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(req.content, encoding="utf-8")
    return {"status": "written", "path": req.path}


def _scan_status(vault_path: Path) -> Tuple[int, int]:
    count = 0
    total = 0
    if vault_path.exists():
        for root, dirs, files in os.walk(vault_path):
            dirs[:] = [d for d in dirs if d not in FORBIDDEN_COMPONENTS]
            count += len(files)
            for name in files:
                with contextlib.suppress(OSError):
                    total += os.path.getsize(os.path.join(root, name))
    return count, total


@router.get("/api/vault/status", dependencies=[Depends(require_auth)])
async def vault_status():
    count, total = await asyncio.to_thread(_scan_status, VAULT_PATH)
    return {
        "path": str(VAULT_PATH),
        "exists": VAULT_PATH.exists(),
        "file_count": count,
        "total_size_bytes": total,
    }


@router.post("/api/vault/sync/file", dependencies=[Depends(require_auth)])
@router.post("/api/vault/push", dependencies=[Depends(require_auth)])
async def sync_file(req: SyncFileRequest):
    """
    Synchronize or push a text note into the vault with hash-conflict detection (SRV-05, G-30).
    Refuses binary files and protected paths. Atomic write via tmp + os.replace.
    """
    target = safe_join(VAULT_PATH, req.path)

    # 1. Text files only
    ext = target.suffix.lower()
    if ext in BINARY_EXTENSIONS or "\x00" in req.content:
        raise HTTPException(status_code=400, detail="Text files only: binary content or extensions refused")

    # 2. Hash conflict check
    if req.base_sha256 is not None:
        if target.is_file():
            host_bytes = target.read_bytes()
            host_sha = hashlib.sha256(host_bytes).hexdigest()
            host_mtime = int(target.stat().st_mtime)
            if req.base_sha256 != host_sha:
                return JSONResponse(
                    status_code=409,
                    content={
                        "detail": "Conflict: base_sha256 mismatch",
                        "error": "conflict",
                        "host_sha256": host_sha,
                        "current_sha256": host_sha,
                        "host_mtime": host_mtime,
                        "mtime": host_mtime,
                    },
                )
        elif req.base_sha256 != "":
            # Expected a base sha but file doesn't exist on host
            return JSONResponse(
                status_code=409,
                content={
                    "detail": "Conflict: host file does not exist",
                    "error": "conflict",
                    "host_sha256": None,
                    "current_sha256": None,
                    "host_mtime": None,
                    "mtime": None,
                },
            )

    # 3. Atomic write via temp file + os.replace
    target.parent.mkdir(parents=True, exist_ok=True)
    temp_fd, temp_path = tempfile.mkstemp(dir=target.parent, prefix=".dj_sync_")
    try:
        with os.fdopen(temp_fd, "w", encoding="utf-8") as tf:
            tf.write(req.content)
            tf.flush()
            os.fsync(tf.fileno())
        os.chmod(temp_path, 0o644)
        os.replace(temp_path, target)
    except Exception:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        raise

    new_bytes = req.content.encode("utf-8")
    new_sha = hashlib.sha256(new_bytes).hexdigest()
    new_mtime = int(target.stat().st_mtime)
    return {
        "status": "synced",
        "path": req.path,
        "sha256": new_sha,
        "mtime": new_mtime,
    }


@router.get("/api/vault/file", dependencies=[Depends(require_auth)])
async def read_vault_file(path: str = Query(...)):
    """Pull a file back. Without this the agent's output is stranded on the host."""
    target = safe_join(VAULT_PATH, path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    try:
        size = target.stat().st_size
    except OSError as err:
        raise HTTPException(status_code=500, detail=str(err))

    if size > 4_000_000:
        raise HTTPException(status_code=413, detail="File too large")

    return {
        "path": path,
        "content": target.read_text(encoding="utf-8", errors="replace"),
        "modified": int(target.stat().st_mtime),
    }


def _scan_changed(vault_path: Path, since: int, limit: int) -> List[Dict[str, Any]]:
    out = []
    if vault_path.exists():
        for root, dirs, files in os.walk(vault_path):
            dirs[:] = [d for d in dirs if d not in FORBIDDEN_COMPONENTS]
            for name in files:
                if not name.endswith(".md"):
                    continue
                full = Path(root) / name
                with contextlib.suppress(OSError):
                    mtime = int(full.stat().st_mtime)
                    if mtime > since:
                        out.append(
                            {
                                "path": str(full.relative_to(vault_path)),
                                "modified": mtime,
                            }
                        )
    out.sort(key=lambda item: item["modified"], reverse=True)
    return out[:limit]


@router.get("/api/vault/changed", dependencies=[Depends(require_auth)])
async def changed_since(since: int = Query(0), limit: int = Query(200, le=2000)):
    """Markdown files touched on the host since `since` (unix seconds)."""
    changed = await asyncio.to_thread(_scan_changed, VAULT_PATH, since, limit)
    return {"since": since, "changed": changed}

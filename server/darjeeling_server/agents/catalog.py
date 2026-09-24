"""Model catalogue loader and CLI version range checker (SRV-25, G-47)."""

import json
import re
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

CATALOG_PATHS = [
    Path("/etc/darjeeling/models.json"),
    Path("/opt/darjeeling/current/catalog/models.json"),
    Path(__file__).resolve().parents[2] / "catalog" / "models.json",
]


def load_catalog() -> Dict[str, Any]:
    """Load model catalogue, checking host overrides first."""
    for path in CATALOG_PATHS:
        if path.is_file():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
    return {}


def parse_semver(v: str) -> Optional[Tuple[int, int, int]]:
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", v)
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)))


def check_version_in_range(version_str: Optional[str], range_str: Optional[str]) -> Optional[bool]:
    """
    Check if a version string (e.g. '2.1.999 (Claude Code) [darjeeling-fake]')
    satisfies a range constraint like '>=0.2.0,<1.0.0'.
    """
    if not version_str or not range_str:
        return None
    v = parse_semver(version_str)
    if not v:
        return None

    # Constraints are comma-separated, e.g. ">=0.2.0,<1.0.0"
    for part in range_str.split(","):
        part = part.strip()
        if not part:
            continue
        op = ""
        for candidate_op in (">=", "<=", ">", "<", "=="):
            if part.startswith(candidate_op):
                op = candidate_op
                break
        if not op:
            continue
        target_v = parse_semver(part[len(op):].strip())
        if not target_v:
            continue

        if op == ">=" and not (v >= target_v):
            return False
        elif op == "<=" and not (v <= target_v):
            return False
        elif op == ">" and not (v > target_v):
            return False
        elif op == "<" and not (v < target_v):
            return False
        elif op == "==" and not (v == target_v):
            return False

    return True

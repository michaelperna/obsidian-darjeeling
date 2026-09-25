"""AgentSpec base class representing an integrated agent runtime."""

import re
import shutil
import subprocess
import uuid
from typing import TYPE_CHECKING, Any, Dict, Iterable, List, Optional

if TYPE_CHECKING:
    from darjeeling_server.turns import TurnRequest


class ArgvError(ValueError):
    """A user-supplied value cannot be placed on an agent command line."""


def safe_value(name: str, value: Optional[str]) -> Optional[str]:
    """
    Guard a user-supplied value destined for a CLI flag argument.

    A value that begins with '-' would be parsed by the agent CLI as another
    flag (e.g. model="--dangerously-skip-permissions"), so it is refused.
    Control characters (NUL, newlines) are refused as well: no legitimate
    model name, tool name, path or id contains them.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise ArgvError(f"{name} must be a string")
    if value.startswith("-"):
        raise ArgvError(f"{name} must not start with '-'")
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ArgvError(f"{name} contains control characters")
    return value


def safe_values(name: str, values: Iterable[str]) -> List[str]:
    return [safe_value(name, v) for v in values]  # type: ignore[misc]


def is_uuid(value: str) -> bool:
    """Accepts canonical (dashed) and 32-char hex UUIDs, nothing else."""
    if not isinstance(value, str) or len(value) not in (32, 36):
        return False
    try:
        uuid.UUID(value)
    except (ValueError, AttributeError, TypeError):
        return False
    return True


def safe_session_id(name: str, value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    if not is_uuid(value):
        raise ArgvError(f"{name} must be a UUID")
    return value


# Agents whose session id format is not documented as a UUID (agy) get a
# conservative token instead: starts with a letter or digit (never '-', so it
# cannot be read as a flag), then letters, digits and _ . : - only (no '/',
# whitespace or control characters), at most 128 characters.
_SAFE_RESUME_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}")


def is_safe_resume_id(value: str) -> bool:
    return isinstance(value, str) and _SAFE_RESUME_ID.fullmatch(value) is not None


def safe_resume_id(name: str, value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    if not is_safe_resume_id(value):
        raise ArgvError(
            f"{name} must start with a letter or digit and contain only letters, digits, '_', '.', ':' or '-' (max 128)"
        )
    return value


class AgentSpec:
    """
    How to drive one coding agent in structured streaming mode.

    Most agents are a local CLI, spawned per turn. `is_api` marks the other
    shape: a direct HTTP call to a hosted API, with no binary and no PATH
    lookup. AgentTurn dispatches on that flag instead of assuming subprocess.
    """

    is_api: bool = False
    # Extra accepted spellings for permission modes (alias -> canonical id).
    # Canonical ids are the advertised `permission_modes` ids.
    permission_aliases: Dict[str, str] = {}

    def __init__(
        self,
        key: str,
        label: str,
        binary: str,
        models: List[Dict[str, str]],
        efforts: List[str],
        permission_modes: List[Dict[str, str]],
    ):
        self.key = key
        self.label = label
        self.binary = binary
        self.models = models
        self.efforts = efforts
        self.permission_modes = permission_modes
        self.authenticated = True
        self.tested_versions: Optional[str] = None

    @property
    def path(self) -> Optional[str]:
        return shutil.which(self.binary)

    @property
    def available(self) -> bool:
        return self.path is not None

    def version(self) -> Optional[str]:
        if not self.available:
            return None
        try:
            res = subprocess.run(
                [self.binary, "--version"],
                capture_output=True,
                text=True,
                check=False,
                timeout=10,
            )
            return (res.stdout or res.stderr).strip().splitlines()[0][:120] or None
        except Exception:
            return None

    def in_tested_range(self) -> Optional[bool]:
        if not self.tested_versions:
            return None
        from darjeeling_server.agents.catalog import check_version_in_range
        return check_version_in_range(self.version(), self.tested_versions)

    @property
    def permission_mode_ids(self) -> List[str]:
        return [m["id"] for m in self.permission_modes]

    @property
    def most_restrictive_mode(self) -> str:
        # permission_modes are listed most-restrictive first.
        return self.permission_modes[0]["id"]

    def resolve_permission_mode(self, mode: Optional[str], explicit: bool = True) -> str:
        """
        Map a requested permission mode onto this agent's allow-list.

        Absent (explicit=False) -> the most restrictive supported mode.
        Explicit null or an unknown string -> ValueError (fail closed).
        """
        if mode is None:
            if explicit:
                raise ValueError(
                    f"permission_mode must be one of {self.permission_mode_ids} for {self.label}"
                )
            return self.most_restrictive_mode
        if not isinstance(mode, str):
            raise ValueError("permission_mode must be a string")
        if mode in self.permission_mode_ids:
            return mode
        if mode in self.permission_aliases:
            return self.permission_aliases[mode]
        raise ValueError(
            f"Unknown permission mode '{mode}' for {self.label}; "
            f"supported: {', '.join(self.permission_mode_ids)}"
        )

    def build_argv(self, req: "TurnRequest") -> List[str]:
        raise NotImplementedError

    async def run_api(self, req: "TurnRequest", emit) -> None:
        """Only implemented by is_api agents. See DeepSeekAgent."""
        raise NotImplementedError

    def as_json(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "binary": self.binary,
            "available": self.available,
            "path": self.path,
            "version": self.version(),
            "tested_versions": self.tested_versions,
            "in_tested_range": self.in_tested_range(),
            "authenticated": self.authenticated,
            "models": self.models,
            "efforts": self.efforts,
            "permissionModes": self.permission_modes,
            "isApi": self.is_api,
        }

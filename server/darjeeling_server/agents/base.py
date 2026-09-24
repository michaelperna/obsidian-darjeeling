"""AgentSpec base class representing an integrated agent runtime."""

import shutil
import subprocess
from typing import TYPE_CHECKING, Any, Dict, List, Optional

if TYPE_CHECKING:
    from darjeeling_server.turns import TurnRequest


class AgentSpec:
    """
    How to drive one coding agent in structured streaming mode.

    Most agents are a local CLI, spawned per turn. `is_api` marks the other
    shape: a direct HTTP call to a hosted API, with no binary and no PATH
    lookup. AgentTurn dispatches on that flag instead of assuming subprocess.
    """

    is_api: bool = False

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

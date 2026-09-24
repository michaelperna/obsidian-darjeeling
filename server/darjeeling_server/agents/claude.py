"""Claude Code agent driver."""

import json
from typing import TYPE_CHECKING, List

from darjeeling_server.agents.base import AgentSpec
from darjeeling_server.agents.catalog import load_catalog

if TYPE_CHECKING:
    from darjeeling_server.turns import TurnRequest


class ClaudeAgent(AgentSpec):
    def __init__(self):
        catalog = load_catalog().get("claude_code", {})
        models = [
            {"id": "", "label": "Default (managed setting)"},
            {"id": "opus", "label": "Opus (alias, latest)"},
            {"id": "sonnet", "label": "Sonnet (alias, latest)"},
            {"id": "haiku", "label": "Haiku (alias, latest)"},
            {"id": "claude-opus-5", "label": "Opus 5"},
            {"id": "claude-sonnet-5", "label": "Sonnet 5"},
            {"id": "claude-fable-5-1", "label": "Fable 5.1"},
            {"id": "claude-haiku-4-5-20251001", "label": "Haiku 4.5"},
        ]
        if "models" in catalog:
            models = [{"id": "", "label": "Default (managed setting)"}] + [
                {"id": m["id"], "label": m.get("name", m["id"])}
                for m in catalog["models"]
                if m.get("id")
            ]
        super().__init__(
            key="claude",
            label="Claude Code",
            binary="claude",
            models=models,
            efforts=["low", "medium", "high", "xhigh", "max"],
            permission_modes=[
                {"id": "plan", "label": "Plan only (read-only)"},
                {"id": "acceptEdits", "label": "Accept edits"},
                {"id": "dontAsk", "label": "Don't ask (skip gated tools)"},
                {"id": "acceptAll", "label": "Accept everything"},
                {"id": "bypassPermissions", "label": "Bypass all checks"},
            ],
        )
        if "tested_versions" in catalog:
            self.tested_versions = catalog["tested_versions"]

    def build_argv(self, req: "TurnRequest") -> List[str]:
        argv = [
            self.binary,
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--setting-sources",
            "user",
        ]
        if req.partial_messages:
            argv.append("--include-partial-messages")
        if req.model:
            argv += ["--model", req.model]
        if req.fallback_model:
            argv += ["--fallback-model", req.fallback_model]
        if req.effort:
            argv += ["--effort", req.effort]
        if req.permission_mode:
            mode = req.permission_mode
            # 'acceptAll' is our legacy label for the flag-based escape hatch.
            if mode == "acceptAll":
                argv.append("--dangerously-skip-permissions")
            else:
                argv += ["--permission-mode", mode]
        if req.resume:
            argv += ["--resume", req.resume]
            if req.fork:
                argv.append("--fork-session")
        elif req.session_id:
            argv += ["--session-id", req.session_id]
        if req.json_schema is not None:
            argv += ["--json-schema", json.dumps(req.json_schema)]
        if req.append_system_prompt:
            argv += ["--append-system-prompt", req.append_system_prompt]
        if req.allowed_tools:
            argv += ["--allowedTools", *req.allowed_tools]
        if req.disallowed_tools:
            argv += ["--disallowedTools", *req.disallowed_tools]
        for extra in req.add_dirs:
            argv += ["--add-dir", extra]
        return argv

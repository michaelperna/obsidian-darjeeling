"""Claude Code agent driver."""

import json
from typing import TYPE_CHECKING, List

from darjeeling_server.agents.base import (
    AgentSpec,
    ArgvError,
    safe_session_id,
    safe_value,
    safe_values,
)
from darjeeling_server.agents.catalog import load_catalog

if TYPE_CHECKING:
    from darjeeling_server.turns import TurnRequest


class ClaudeAgent(AgentSpec):
    # Real Claude Code modes only (see `claude --help`, --permission-mode
    # choices). The old 'acceptAll' label was never a Claude Code mode; it is
    # now rejected as unknown instead of silently mapping to
    # --dangerously-skip-permissions.
    permission_aliases = {"accept-edits": "acceptEdits"}

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
                {"id": "bypassPermissions", "label": "Bypass all checks"},
            ],
        )
        if "tested_versions" in catalog:
            self.tested_versions = catalog["tested_versions"]

    def build_argv(self, req: "TurnRequest") -> List[str]:
        # Every user-supplied value below is validated so it can never be
        # parsed as a flag: values may not start with '-', and session ids
        # must be UUIDs. The prompt itself goes via stdin, never argv.
        # Values stay as separate argv entries (`--flag value`): with the
        # leading-dash guard this is equivalent to `--flag=value` and keeps
        # the argv shape the tests and the fake CLI rely on.
        model = safe_value("model", req.model or None)
        fallback_model = safe_value("fallback_model", req.fallback_model or None)
        effort = safe_value("effort", req.effort or None)
        mode = self.resolve_permission_mode(
            req.permission_mode, explicit="permission_mode" in req.model_fields_set
        )
        resume = safe_session_id("resume", req.resume or None)
        session_id = safe_session_id("session_id", req.session_id or None)
        allowed_tools = safe_values("allowed_tools", req.allowed_tools)
        disallowed_tools = safe_values("disallowed_tools", req.disallowed_tools)
        add_dirs = safe_values("add_dirs", req.add_dirs)

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
        if model:
            argv += ["--model", model]
        if fallback_model:
            argv += ["--fallback-model", fallback_model]
        if effort:
            argv += ["--effort", effort]
        # Always pass an explicit mode so the CLI's own default never applies.
        argv += ["--permission-mode", mode]
        if resume:
            argv += ["--resume", resume]
            if req.fork:
                argv.append("--fork-session")
        elif session_id:
            argv += ["--session-id", session_id]
        if req.json_schema is not None:
            # json.dumps of a dict always starts with '{'.
            argv += ["--json-schema", json.dumps(req.json_schema)]
        if req.append_system_prompt:
            text = req.append_system_prompt
            if "\x00" in text:
                raise ArgvError("append_system_prompt contains NUL")
            # Free text may legitimately start with '-' (a bullet list);
            # a leading newline keeps it from ever looking like a flag.
            if text.startswith("-"):
                text = "\n" + text
            argv += ["--append-system-prompt", text]
        if allowed_tools:
            argv += ["--allowedTools", *allowed_tools]
        if disallowed_tools:
            argv += ["--disallowedTools", *disallowed_tools]
        for extra in add_dirs:
            argv += ["--add-dir", extra]
        return argv

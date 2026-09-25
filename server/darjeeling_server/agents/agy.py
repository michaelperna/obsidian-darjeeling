"""Antigravity CLI (agy) agent driver and event normalizer."""

import json
import re
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from darjeeling_server.agents.base import (
    AgentSpec,
    safe_resume_id,
    safe_value,
)

if TYPE_CHECKING:
    from darjeeling_server.turns import TurnRequest


def normalize_agy_event(
    event: Dict[str, Any],
    default_session_id: Optional[str] = None,
    model: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Translates an Antigravity CLI (agy) stream-json event into Darjeeling / Claude Code
    standard stream-json events (type: "system", "assistant", "user", "result").
    """
    if not isinstance(event, dict):
        return [event]
    if "type" in event and "event" not in event:
        return [event]

    ev_type = event.get("event")
    sid = (
        event.get("conversation_id")
        or event.get("session_id")
        or default_session_id
    )

    if ev_type == "init":
        init_data = event.get("init", {})
        return [
            {
                "type": "system",
                "subtype": "init",
                "session_id": sid,
                "cwd": init_data.get("cwd"),
                "tools": init_data.get("tools", []),
                "model": model or "gemini-3.8-flash-high",
                "permissionMode": init_data.get("permission_mode"),
            }
        ]

    if ev_type == "step_update":
        update = event.get("step_update", {})
        update_sid = update.get("conversation_id") or sid
        step_type = update.get("step_type")
        state = update.get("state")
        step_idx = update.get("step_index", 0)
        events = []

        if step_type == "agent_response":
            text_delta = update.get("text_delta")
            if text_delta:
                events.append(
                    {
                        "type": "assistant",
                        "session_id": update_sid,
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": text_delta}],
                        },
                    }
                )
            thinking = update.get("thinking")
            if thinking:
                events.append(
                    {
                        "type": "assistant",
                        "session_id": update_sid,
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "thinking", "thinking": thinking}],
                        },
                    }
                )
        elif step_type == "tool":
            tool_name = update.get("tool_name") or update.get("tool_info", {}).get("name", "tool")
            tool_info = update.get("tool_info", {})
            if state == "ACTIVE":
                events.append(
                    {
                        "type": "assistant",
                        "session_id": update_sid,
                        "message": {
                            "role": "assistant",
                            "content": [
                                {
                                    "type": "tool_use",
                                    "id": f"step-{step_idx}",
                                    "name": tool_name,
                                    "input": tool_info.get("parameters", {}),
                                }
                            ],
                        },
                    }
                )
            elif state == "DONE":
                events.append(
                    {
                        "type": "user",
                        "session_id": update_sid,
                        "message": {
                            "role": "user",
                            "content": [
                                {
                                    "type": "tool_result",
                                    "tool_use_id": f"step-{step_idx}",
                                    "content": tool_info.get("output", ""),
                                }
                            ],
                        },
                    }
                )
        return events

    if ev_type == "result":
        res = event.get("result", {})
        res_sid = res.get("conversation_id") or sid
        dur = res.get("duration_seconds")
        usage = res.get("usage", {})
        status_str = str(res.get("status") or "").upper()
        is_error = bool(res.get("is_error")) or status_str in ("ERROR", "FAILED")
        return [
            {
                "type": "result",
                "subtype": "turn_error" if is_error else "turn_complete",
                "result": res.get("response", ""),
                "session_id": res_sid,
                "duration_ms": int(dur * 1000) if dur is not None else None,
                "num_turns": res.get("num_turns", 1),
                "usage": {
                    "input_tokens": usage.get("input_tokens"),
                    "output_tokens": usage.get("output_tokens"),
                    "cache_read_input_tokens": usage.get("cache_read_tokens"),
                },
                "is_error": is_error,
            }
        ]

    return [event]


class AntigravityAgent(AgentSpec):
    # Claude-style spellings the plugin may send for agy. bypassPermissions is
    # accepted (still subject to the host ceiling) and maps to agy's
    # --dangerously-skip-permissions; 'acceptAll' is no longer accepted.
    permission_aliases = {
        "acceptEdits": "accept-edits",
        "bypassPermissions": "bypassPermissions",
    }

    def __init__(self):
        super().__init__(
            key="agy",
            label="Antigravity CLI",
            binary="agy",
            models=[
                {"id": "", "label": "Default"},
                {"id": "gemini-3.8-flash-high", "label": "Gemini 3.8 Flash (High)"},
                {"id": "gemini-3.8-flash-medium", "label": "Gemini 3.8 Flash (Medium)"},
                {"id": "gemini-3.8-flash-low", "label": "Gemini 3.8 Flash (Low)"},
            ],
            efforts=["low", "medium", "high"],
            permission_modes=[
                {"id": "plan", "label": "Plan only"},
                {"id": "accept-edits", "label": "Accept edits"},
            ],
        )

    def build_argv(self, req: "TurnRequest") -> List[str]:
        prompt = req.prompt
        if req.append_system_prompt:
            prompt = f"System Context:\n{req.append_system_prompt}\n\n---\n\n{prompt}"
        if len(prompt.encode("utf-8")) > 100 * 1024:
            raise ValueError(
                "Prompt exceeds 100 KiB limit for agy agent. "
                "agy passes prompts via command-line arguments (-p=...); "
                "use Claude Code or DeepSeek for larger prompts."
            )

        model_req = safe_value("model", req.model or None)
        effort = safe_value("effort", req.effort or None)
        mode = self.resolve_permission_mode(
            req.permission_mode, explicit="permission_mode" in req.model_fields_set
        )
        # agy conversation ids are not documented as UUIDs; accept a safe token.
        resume = safe_resume_id("resume", req.resume or None)

        argv = [self.binary, "--output-format", "stream-json"]

        if effort:
            if effort not in ("low", "medium", "high"):
                effort = "high" if effort in ("xhigh", "max") else "medium"

        if model_req:
            model = model_req
            has_effort_suffix = any(model.endswith(f"-{e}") for e in ("high", "medium", "low"))
            if effort:
                if has_effort_suffix:
                    model = re.sub(r"-(high|medium|low)$", f"-{effort}", model)
                else:
                    argv += ["--effort", effort]
            argv += ["--model", model]
        elif effort:
            argv += ["--effort", effort]
        # Always pass an explicit mode.
        if mode == "bypassPermissions":
            argv.append("--dangerously-skip-permissions")
        else:
            argv += ["--mode", mode]
        if resume:
            argv += ["--conversation", resume]
        if req.json_schema is not None:
            argv += ["--json-schema", json.dumps(req.json_schema)]
        # Attached form: the prompt can never be parsed as a separate flag.
        argv.append(f"-p={prompt}")
        return argv

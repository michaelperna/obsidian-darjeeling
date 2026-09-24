"""Agents package for Darjeeling server."""

from typing import Dict

from darjeeling_server.agents.agy import AntigravityAgent
from darjeeling_server.agents.base import AgentSpec
from darjeeling_server.agents.claude import ClaudeAgent
from darjeeling_server.agents.deepseek import DeepSeekAgent

AGENTS: Dict[str, AgentSpec] = {
    a.key: a for a in (ClaudeAgent(), AntigravityAgent(), DeepSeekAgent())
}

__all__ = [
    "AGENTS",
    "AgentSpec",
    "ClaudeAgent",
    "AntigravityAgent",
    "DeepSeekAgent",
]

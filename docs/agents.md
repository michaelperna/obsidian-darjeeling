# AI Agents & CLI Integration

Project Darjeeling integrates external agentic coding CLIs and tools directly into your Obsidian workflow. This document details supported agents, headless authentication, permission levels, and version compatibility.

---

## 1. Supported CLI Agents

| Agent CLI | Status | Tested Versions | Capabilities |
|---|---|---|---|
| **Claude Code (`claude`)** | **Supported** | `0.2.29` – `0.2.32` | Multi-turn reasoning, file inspection, edits, shell command execution, Git integration. |
| **Antigravity (`agy`)** | **Experimental** | Tested on v0.1.x | Task-based agent execution with specialized skill sets. Marked experimental. |
| **DeepSeek CLI** | **Experimental** | Community builds | Reasoning and code generation CLI. Marked experimental. |

---

## 2. Authenticating on a Headless Server

To run Claude Code on your headless Linux companion server, authenticate as the server service user (`darjeeling` by default, or your configured service user):

### Method 1: Web Browser OAuth Flow
Log in interactively as the service user:
```bash
sudo runuser -u darjeeling -- claude login
```
Claude Code prints an authorization URL. Open the URL on any browser, complete the Anthropic login, and paste the confirmation code back into the terminal.

### Method 2: Environment API Key
Alternatively, supply an Anthropic API key in `/etc/darjeeling/darjeeling.env`:
```ini
# /etc/darjeeling/darjeeling.env
ANTHROPIC_API_KEY="sk-ant-api03-..."
```
Then restart the service:
```bash
sudo systemctl restart darjeeling.service
```

---

## 3. Permission Modes

When starting a conversation or turn, you can select one of three permission modes:

1. **`plan` (Default / Recommended)**:
   - **Read-only analysis**: The agent can inspect notes and repository files, explain architectures, and draft plans.
   - The agent cannot modify files or execute modifying shell commands.
2. **`acceptEdits`**:
   - **Interactive development**: The agent can create, modify, and delete files inside the workspace.
   - Modifying shell commands and outside-vault writes require explicit confirmation.
3. **`bypassPermissions`**:
   - **Autonomous execution**: The agent executes shell commands and applies edits autonomously without prompting for confirmation.
   - Use only in trusted, isolated container or virtual machine environments.

---

## 4. The Server Permission Ceiling

Even if a client requests `bypassPermissions`, the host companion server enforces a mandatory **permission ceiling** configured via `DARJEELING_PERMISSION_CEILING` in `/etc/darjeeling/darjeeling.env` (default `acceptEdits`):

| Server Ceiling Setting | Maximum Allowed Client Mode |
|---|---|
| `plan` | `plan` only (any client request for higher permissions is clamped to `plan`). |
| `acceptEdits` | `plan` or `acceptEdits`. |
| `bypassPermissions` | `plan`, `acceptEdits`, or `bypassPermissions`. |

This ensures server administrators can enforce safety policies regardless of client settings.

---

## 5. Model Aliases & Substitution

Darjeeling translates friendly model identifiers in the UI to current upstream model identifiers:
- `claude-sonnet-5` → `claude-3-7-sonnet-20250219`
- `claude-opus-4` → `claude-3-opus-20240229`
- `gemini-pro` → `gemini-1.5-pro`
- `deepseek-chat` → `deepseek-chat`

If a model identifier is deprecated or unsupported by the local CLI version, Darjeeling uses the configured fallback model and notifies the user in the conversation turn header.

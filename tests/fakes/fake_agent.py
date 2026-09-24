#!/usr/bin/env python3
"""
Fake coding-agent CLI for Darjeeling tests.

Stands in for `claude` (Claude Code) and `agy` (Antigravity) so the server,
the installer checks and the plugin E2E suite can exercise a full agent turn
without credentials, network or cost. Stdlib only, Python 3.8+.

It accepts the same argv the server builds (server.py ClaudeAgent.build_argv /
AntigravityAgent.build_argv), picks a scenario, and replays it to stdout as
NDJSON, flushing after every line like the real CLI does.

Scenario selection, first match wins:
  1. FAKE_AGENT_SCENARIO env var
  2. a `#scenario:<name>` token anywhere in the prompt
  3. "basic" (claude flavour) / "agy-basic" (agy flavour)

Scenario files live in FAKE_AGENT_SCENARIOS (default: ./scenarios next to this
file) as <name>.ndjson. Each line is either a literal event, with {{placeholders}}
substituted, or a directive object with a "$fake" key:

  {"$fake": "sleep", "ms": 250}
  {"$fake": "stderr", "text": "warning on stderr"}
  {"$fake": "raw", "text": "not json on stdout"}
  {"$fake": "big_tool_result", "bytes": 200000}      one line > asyncio's 64 KiB limit
  {"$fake": "wait_for_signal"}                         block until SIGTERM/SIGINT
  {"$fake": "exit", "code": 1}

Placeholders: {{session_id}} {{model}} {{cwd}} {{permission_mode}} {{prompt}}
{{prompt_json}} {{uuid}} (fresh per occurrence) {{version}} {{tool_use_id}}.

Other environment knobs:
  FAKE_AGENT_ARGV_LOG     append one JSON line per invocation: {"argv": [...], "cwd": ...}
  FAKE_AGENT_TRANSCRIPTS  "1" = also write ~/.claude/projects/<slug>/<sid>.jsonl like
                          the real CLI, so /api/agent/conversations has data.
                          Only ever enable this with HOME pointed at a temp dir.
  FAKE_AGENT_DELAY_MS     sleep between every emitted event (default 0)
"""

import json
import os
import re
import signal
import sys
import time
import uuid
from pathlib import Path

VERSION = "2.1.999 (Claude Code) [darjeeling-fake]"
AGY_VERSION = "agy 0.0.0-darjeeling-fake"

ALIASES = {
    "opus": "claude-opus-5",
    "sonnet": "claude-sonnet-5",
    "haiku": "claude-haiku-4-5-20251001",
}

# Flags that take exactly one value, per the real CLIs.
CLAUDE_VALUE_FLAGS = {
    "--output-format", "--input-format", "--model", "--fallback-model", "--effort",
    "--permission-mode", "--resume", "-r", "--session-id", "--json-schema",
    "--append-system-prompt", "--append-system-prompt-file", "--system-prompt",
    "--settings", "--max-turns", "--setting-sources",
}
# Variadic flags (commander `<values...>`): they swallow every following
# non-flag token, *including a trailing positional prompt*. Modelled on
# purpose so a test can catch argv that puts a variadic flag last.
CLAUDE_VARIADIC_FLAGS = {"--allowedTools", "--allowed-tools", "--disallowedTools",
                         "--disallowed-tools", "--add-dir", "--mcp-config"}
CLAUDE_BOOL_FLAGS = {"-p", "--print", "--verbose", "--include-partial-messages",
                     "--fork-session", "--dangerously-skip-permissions", "-c", "--continue"}

AGY_VALUE_FLAGS = {"--output-format", "--model", "--effort", "--mode", "--conversation",
                   "--json-schema"}
AGY_BOOL_FLAGS = {"--dangerously-skip-permissions"}


def parse_claude(argv):
    opts = {"_prompt": None, "_variadic": {}}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in CLAUDE_BOOL_FLAGS:
            opts[a] = True
            i += 1
        elif a in CLAUDE_VALUE_FLAGS:
            opts[a] = argv[i + 1] if i + 1 < len(argv) else None
            i += 2
        elif a in CLAUDE_VARIADIC_FLAGS:
            vals = []
            i += 1
            while i < len(argv) and not argv[i].startswith("-"):
                vals.append(argv[i])
                i += 1
            opts["_variadic"][a] = vals
        elif a.startswith("-"):
            sys.stderr.write("error: unknown option '%s'\n" % a)
            sys.exit(1)
        else:
            opts["_prompt"] = a
            i += 1
    return opts


def parse_agy(argv):
    opts = {"_prompt": None}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("-p="):
            opts["_prompt"] = a[3:]
            i += 1
        elif a in AGY_BOOL_FLAGS:
            opts[a] = True
            i += 1
        elif a in AGY_VALUE_FLAGS:
            opts[a] = argv[i + 1] if i + 1 < len(argv) else None
            i += 2
        elif a == "-p":
            # agy wants -p=<prompt>; a detached -p is the bug test 5 guards against.
            sys.stderr.write("error: -p requires an attached value (-p=<prompt>)\n")
            sys.exit(2)
        else:
            sys.stderr.write("error: unexpected argument '%s'\n" % a)
            sys.exit(2)
    return opts


class Emitter:
    def __init__(self, delay_ms, transcript):
        self.delay = max(0, delay_ms) / 1000.0
        self.transcript = transcript

    def line(self, text):
        sys.stdout.write(text + "\n")
        sys.stdout.flush()
        if self.delay:
            time.sleep(self.delay)

    def event(self, obj):
        self.line(json.dumps(obj, ensure_ascii=False))
        if self.transcript is not None and obj.get("type") in ("user", "assistant"):
            with self.transcript.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(obj, ensure_ascii=False) + "\n")


def substitute(template, ctx):
    out = template
    while "{{uuid}}" in out:
        out = out.replace("{{uuid}}", str(uuid.uuid4()), 1)
    for key, value in ctx.items():
        out = out.replace("{{%s}}" % key, value)
    return out


def main():
    flavour = os.environ.get("FAKE_AGENT_FLAVOUR") or (
        "agy" if Path(sys.argv[0]).name.startswith("agy") else "claude"
    )
    argv = sys.argv[1:]

    if "--version" in argv or "-v" in argv:
        print(AGY_VERSION if flavour == "agy" else VERSION)
        return 0

    log_path = os.environ.get("FAKE_AGENT_ARGV_LOG")
    if log_path:
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"flavour": flavour, "argv": argv, "cwd": os.getcwd()}) + "\n")

    opts = parse_agy(argv) if flavour == "agy" else parse_claude(argv)
    prompt = opts.get("_prompt")

    if flavour == "claude":
        if not (opts.get("-p") or opts.get("--print")):
            sys.stderr.write("fake claude only supports print mode (-p)\n")
            return 2
        if prompt is None:
            if not sys.stdin.isatty():
                stdin_text = sys.stdin.read()
                if stdin_text:
                    prompt = stdin_text
        if prompt is None:
            # Same message the real CLI prints when -p gets no prompt.
            sys.stderr.write(
                "Error: Input must be provided either through stdin or as a prompt "
                "argument when using --print\n"
            )
            return 1
        if opts.get("--output-format") != "stream-json":
            sys.stdout.write("fake: only stream-json is implemented\n")
            return 0
        if not opts.get("--verbose"):
            sys.stderr.write(
                "Error: When using --print, --output-format=stream-json requires --verbose\n"
            )
            return 1
    elif prompt is None:
        sys.stderr.write("error: missing -p=<prompt>\n")
        return 2

    session_id = (
        opts.get("--resume") or opts.get("-r") or opts.get("--session-id")
        or opts.get("--conversation") or str(uuid.uuid4())
    )
    if opts.get("--fork-session"):
        session_id = str(uuid.uuid4())
    model = opts.get("--model") or ("gemini-3.8-flash-high" if flavour == "agy" else "claude-opus-5")
    model = ALIASES.get(model, model)
    permission = opts.get("--permission-mode") or opts.get("--mode") or "default"
    if opts.get("--dangerously-skip-permissions"):
        permission = "bypassPermissions"

    scenario = os.environ.get("FAKE_AGENT_SCENARIO")
    if not scenario and prompt and "#scenario:" in prompt:
        scenario = prompt.split("#scenario:", 1)[1].split()[0].strip()
    if not scenario and prompt and prompt.strip() == "-h":
        scenario = "leading-dash"
    if not scenario and prompt and len(prompt) > 100 * 1024:
        scenario = "huge-prompt"
    if not scenario:
        scenario = "agy-basic" if flavour == "agy" else "basic"
    scen_dir = Path(os.environ.get("FAKE_AGENT_SCENARIOS") or Path(__file__).resolve().parent / "scenarios")
    scen_file = scen_dir / ("%s.ndjson" % scenario)
    if not scen_file.is_file() or "/" in scenario:
        sys.stderr.write("fake: unknown scenario '%s' (looked in %s)\n" % (scenario, scen_dir))
        return 3

    transcript = None
    if flavour == "claude" and os.environ.get("FAKE_AGENT_TRANSCRIPTS") == "1":
        # Real CLI rule: every non-alphanumeric character becomes '-', so
        # /home/first.last/My Vault -> -home-first-last-My-Vault.
        slug = re.sub(r"[^A-Za-z0-9]", "-", os.getcwd())
        store = Path.home() / ".claude" / "projects" / slug
        store.mkdir(parents=True, exist_ok=True)
        transcript = store / ("%s.jsonl" % session_id)
        with transcript.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"type": "user", "session_id": session_id,
                                 "message": {"role": "user", "content": prompt}}) + "\n")

    ctx = {
        "session_id": session_id,
        "model": model,
        "cwd": os.getcwd(),
        "permission_mode": permission,
        "prompt": prompt.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n"),
        "prompt_json": json.dumps(prompt),
        "version": VERSION,
        "tool_use_id": "toolu_fake_" + uuid.uuid4().hex[:12],
    }

    emit = Emitter(int(os.environ.get("FAKE_AGENT_DELAY_MS", "0") or 0), transcript)

    stop = {"flag": False}

    def on_signal(signum, _frame):
        stop["flag"] = True
        sys.exit(128 + signum)

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    for raw in scen_file.read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if not raw or raw.startswith("//"):
            continue
        obj = json.loads(substitute(raw, ctx))
        directive = obj.get("$fake") if isinstance(obj, dict) else None
        if directive is None:
            if obj.get("type") == "result" and opts.get("--json-schema"):
                try:
                    json.loads(opts["--json-schema"])
                    obj["structured_output"] = {"status": "ok", "mock": True}
                except Exception:
                    obj["structured_output"] = {"status": "ok"}
            emit.event(obj)
        elif directive == "sleep":
            time.sleep(float(obj.get("ms", 0)) / 1000.0)
        elif directive == "stderr":
            sys.stderr.write(obj.get("text", "") + "\n")
            sys.stderr.flush()
        elif directive == "raw":
            emit.line(obj.get("text", ""))
        elif directive == "big_tool_result":
            size = int(obj.get("bytes", 200000))
            emit.event({
                "type": "user",
                "message": {"role": "user", "content": [{
                    "tool_use_id": obj.get("tool_use_id", ctx["tool_use_id"]),
                    "type": "tool_result",
                    "content": "x" * size,
                }]},
                "parent_tool_use_id": None,
                "session_id": session_id,
                "uuid": str(uuid.uuid4()),
            })
        elif directive == "wait_for_signal":
            while not stop["flag"]:
                time.sleep(0.1)
        elif directive == "exit":
            return int(obj.get("code", 0))
        else:
            sys.stderr.write("fake: unknown directive %r\n" % directive)
            return 4
    return 0


if __name__ == "__main__":
    sys.exit(main())

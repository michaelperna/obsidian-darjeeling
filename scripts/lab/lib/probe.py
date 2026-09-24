#!/usr/bin/env python3
"""
Black-box probe for an installed Darjeeling server. Lab use only: run it inside
a disposable container, never against the owner's live service.

    probe.py --base http://127.0.0.1:8765 --token-file ~/darjeeling-server/.token CHECK...

Checks: health auth ws ws-reject terminal agents agent-turn ws-query-token
Prints one TSV line per result: STATUS<TAB>name<TAB>detail. Exit 1 if any FAIL.
Needs the `websockets` package, which the server venv already has.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
import uuid

from websockets.sync.client import connect

RESULTS = []


def res(status, name, detail=""):
    RESULTS.append(status)
    print("%s\t%s\t%s" % (status, name, str(detail).replace("\n", " ")[:300]), flush=True)


def http(base, path, token=None, header="bearer", method="GET", body=None, timeout=15):
    headers = {}
    if token is not None:
        if header == "bearer":
            headers["Authorization"] = "Bearer " + token
        else:
            headers["X-Darjeeling-Token"] = token
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, headers=headers, method=method, data=data)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def ws_url(base, path):
    return base.replace("http://", "ws://").replace("https://", "wss://") + path


def rejection(exc):
    resp = getattr(exc, "response", None)
    if resp is not None and getattr(resp, "status_code", None) is not None:
        return "HTTP %s" % resp.status_code
    code = getattr(exc, "status_code", None)
    if code:
        return "HTTP %s" % code
    rcvd = getattr(exc, "rcvd", None)
    if rcvd is not None:
        return "close %s" % rcvd.code
    return type(exc).__name__


def check_health(a):
    try:
        code, body = http(a.base, "/health")
    except Exception as e:  # connection refused etc.
        res("FAIL", "health", "unreachable: %s" % e)
        return
    if code != 200:
        res("FAIL", "health", "HTTP %s" % code)
        return
    j = json.loads(body)
    ok = j.get("status") == "online"
    res("PASS" if ok else "FAIL", "health",
        "v%s auth_required=%s vault_exists=%s agents=%s" % (
            j.get("version"), j.get("auth_required"), j.get("vault_exists"), j.get("agents")))
    if a.expect_version and j.get("version") != a.expect_version:
        res("FAIL", "health.version", "server %s != manifest %s" % (j.get("version"), a.expect_version))


def check_auth(a):
    cases = [
        ("auth.none", None, "bearer", 401),
        ("auth.wrong", "wrong-" + uuid.uuid4().hex, "bearer", 401),
        ("auth.bearer", a.token, "bearer", 200),
        ("auth.x-header", a.token, "x", 200),
    ]
    for name, tok, hdr, want in cases:
        code, _ = http(a.base, "/api/agents", token=tok, header=hdr)
        res("PASS" if code == want else "FAIL", name, "HTTP %s (want %s)" % (code, want))
    code, _ = http(a.base, "/api/agents?token=" + a.token)
    res("PASS" if code == 401 else "FAIL", "auth.rest-query-token-refused", "HTTP %s (want 401)" % code)


def check_agents(a):
    code, body = http(a.base, "/api/agents", token=a.token)
    if code != 200:
        res("FAIL", "agents", "HTTP %s" % code)
        return
    agents = {x["key"]: x for x in json.loads(body)["agents"]}
    for key, spec in agents.items():
        res("INFO", "agents." + key, "available=%s path=%s version=%s" % (
            spec.get("available"), spec.get("path"), spec.get("version")))


def check_ws(a):
    try:
        with connect(ws_url(a.base, "/ws/agent"), subprotocols=["darjeeling.token." + a.token],
                     open_timeout=10) as ws:
            echoed = ws.subprotocol == "darjeeling.token." + a.token
            ws.send(json.dumps({"type": "ping"}))
            ev = json.loads(ws.recv(timeout=5))
            ok = echoed and ev.get("type") == "dj.pong"
            res("PASS" if ok else "FAIL", "ws.handshake+ping",
                "subprotocol echoed=%s reply=%s" % (echoed, ev.get("type")))
    except Exception as e:
        res("FAIL", "ws.handshake+ping", "%s: %s" % (rejection(e), e))


def check_ws_reject(a):
    for name, protos in (("ws.reject-missing", None),
                         ("ws.reject-wrong", ["darjeeling.token.wrong-" + uuid.uuid4().hex])):
        try:
            with connect(ws_url(a.base, "/ws/agent"), subprotocols=protos, open_timeout=10) as ws:
                try:
                    ws.recv(timeout=5)
                    res("FAIL", name, "connection stayed open without a valid token")
                except Exception as e:
                    how = rejection(e)
                    res("PASS" if how in ("close 1008", "close 4401") else "WARN", name,
                        "accepted then %s" % how)
        except Exception as e:
            how = rejection(e)
            # Rejected, which is what matters for security. But the plugin only
            # recognises a bad token via close code 1008 after accept.
            res("WARN" if how.startswith("HTTP") else "PASS", name,
                "rejected with %s; plugin expects close 1008 (agentClient.ts onclose)" % how)


def check_terminal(a):
    session = "djlab-probe-" + uuid.uuid4().hex[:6]
    try:
        with connect(ws_url(a.base, "/ws/terminal?session=" + session),
                     subprotocols=["darjeeling.token." + a.token], open_timeout=10) as ws:
            ws.send(json.dumps({"type": "resize", "rows": 30, "cols": 100}))
            time.sleep(0.5)
            ws.send("echo DJLAB_$((6*7))_OK\r")
            buf = ""
            deadline = time.time() + 10
            while "DJLAB_42_OK" not in buf and time.time() < deadline:
                try:
                    buf += ws.recv(timeout=1)
                except TimeoutError:
                    pass
            ok = "DJLAB_42_OK" in buf
            res("PASS" if ok else "FAIL", "ws.terminal-echo",
                "tmux PTY round trip %s" % ("ok" if ok else "no marker in %d bytes" % len(buf)))
    except Exception as e:
        res("FAIL", "ws.terminal-echo", "%s: %s" % (rejection(e), e))
    finally:
        try:
            http(a.base, "/api/sessions/" + session, token=a.token, method="DELETE")
        except Exception:
            pass


def check_ws_query_token(a):
    """Connect once with ?token= so the caller can grep the journal for it."""
    try:
        with connect(ws_url(a.base, "/ws/agent?token=" + a.token), open_timeout=10) as ws:
            ws.send(json.dumps({"type": "ping"}))
            ws.recv(timeout=5)
        res("INFO", "ws.query-token", "accepted ?token= on /ws/agent (server.py:691)")
    except Exception as e:
        res("INFO", "ws.query-token", "refused: %s" % rejection(e))


def check_agent_turn(a):
    payload = {"type": "turn", "agent": a.agent, "prompt": a.prompt}
    if a.scenario:
        payload["prompt"] += " #scenario:" + a.scenario
    events = []
    started = False
    try:
        with connect(ws_url(a.base, "/ws/agent"), subprotocols=["darjeeling.token." + a.token],
                     open_timeout=10, max_size=None) as ws:
            ws.send(json.dumps(payload))
            deadline = time.time() + a.turn_timeout
            while time.time() < deadline:
                try:
                    ev = json.loads(ws.recv(timeout=max(0.1, deadline - time.time())))
                except TimeoutError:
                    break
                events.append(ev)
                if ev.get("type") == "dj.status" and ev.get("state") in ("starting", "running"):
                    started = True
                if ev.get("type") == "dj.status" and ev.get("state") in ("exited", "interrupted"):
                    break
                if ev.get("type") == "dj.error" and not started:
                    break
    except Exception as e:
        res("FAIL", "agent-turn." + a.agent, "%s: %s" % (rejection(e), e))
        return
    if a.record:
        with open(a.record, "w", encoding="utf-8") as fh:
            for ev in events:
                fh.write(json.dumps(ev) + "\n")
    seq = []
    for e in events:
        t = e.get("type")
        if t == "dj.status":
            t += ":" + str(e.get("state"))
        elif t in ("system", "result"):
            t += ":" + str(e.get("subtype"))
        seq.append(t)
    last = events[-1] if events else {}
    result = next((e for e in events if e.get("type") == "result"), None)
    name = "agent-turn.%s%s" % (a.agent, (":" + a.scenario) if a.scenario else "")
    if a.expect == "complete":
        ok = (result is not None and not result.get("is_error")
              and last.get("state") == "exited" and last.get("code") == 0)
        res("PASS" if ok else "FAIL", name, " > ".join(seq))
    else:
        texts = [b.get("text") for e in events if e.get("type") == "assistant"
                 for b in e.get("message", {}).get("content", []) if b.get("type") == "text"]
        raw = [e.get("line") for e in events if e.get("type") == "dj.raw"]
        res("INFO", name, "%s | exit=%s | result.is_error=%s | text=%r | raw=%r | stderr=%r" % (
            " > ".join(seq), last.get("code"), result.get("is_error") if result else None,
            texts[:1], raw[:1], (last.get("stderr") or "")[:160]))


CHECKS = {
    "health": check_health, "auth": check_auth, "agents": check_agents, "ws": check_ws,
    "ws-reject": check_ws_reject, "terminal": check_terminal,
    "ws-query-token": check_ws_query_token, "agent-turn": check_agent_turn,
}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base", required=True)
    p.add_argument("--token")
    p.add_argument("--token-file")
    p.add_argument("--expect-version")
    p.add_argument("--agent", default="claude")
    p.add_argument("--prompt", default="Say hello.")
    p.add_argument("--scenario")
    p.add_argument("--expect", choices=["complete", "any"], default="complete")
    p.add_argument("--record")
    p.add_argument("--turn-timeout", type=float, default=60)
    p.add_argument("checks", nargs="+", choices=sorted(CHECKS))
    a = p.parse_args()
    if not a.token and a.token_file:
        with open(a.token_file) as fh:
            a.token = fh.read().strip()
    for c in a.checks:
        CHECKS[c](a)
    return 1 if "FAIL" in RESULTS else 0


if __name__ == "__main__":
    sys.exit(main())

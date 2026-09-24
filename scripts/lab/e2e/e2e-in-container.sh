#!/usr/bin/env bash
# e2e-in-container.sh -- Runs Playwright-over-CDP test suite inside the Obsidian container.
set -uo pipefail

if [ ! -f /run/.containerenv ] && [ ! -f /.dockerenv ]; then
    echo "e2e-in-container.sh: refusing to run outside a container" >&2
    exit 99
fi

W=/work
OUT="$W/_lab/e2e"
VAULT=/root/e2e-vault
SRV_VAULT=/root/srv-vault
TOKEN="e2e-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
PORT=8765
MOCK_PORT=8766
GREP="${1:-}"

rm -rf "$OUT"
mkdir -p "$OUT" "$VAULT/.obsidian/plugins/darjeeling" "$SRV_VAULT" /root/.config/obsidian /tmp/e2e-tmux

# 1. Start Companion Server with fake agents
python3 -m venv /tmp/srv-venv >/dev/null
/tmp/srv-venv/bin/pip install -q -r "$W/server/requirements.lock" >"$OUT/pip.log" 2>&1 || {
    echo "FAIL server deps"
    exit 1
}
printf '# Server-side vault\n' >"$SRV_VAULT/README.md"
env PATH="$W/tests/fakes/bin:/usr/local/bin:/usr/bin:/bin" HOME=/root TMUX_TMPDIR=/tmp/e2e-tmux \
    DARJEELING_HOST=127.0.0.1 DARJEELING_PORT="$PORT" DARJEELING_TOKEN="$TOKEN" \
    DARJEELING_VAULT="$SRV_VAULT" FAKE_AGENT_DELAY_MS=30 FAKE_AGENT_TRANSCRIPTS=1 \
    /tmp/srv-venv/bin/python "$W/server/server.py" >"$OUT/server.log" 2>&1 &
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.5; done

# 2. Start Mock OpenAI Endpoint for direct API tests
python3 "$W/scripts/lab/e2e/mock_openai.py" "$MOCK_PORT" >"$OUT/mock-openai.log" 2>&1 &
for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$MOCK_PORT/health" >/dev/null 2>&1 && break; sleep 0.5; done

# 3. Seed Vault & Plugin
cp "$W/main.js" "$W/manifest.json" "$W/styles.css" "$VAULT/.obsidian/plugins/darjeeling/"
printf '["darjeeling"]\n' >"$VAULT/.obsidian/community-plugins.json"
if [ -d "$W/tests/e2e/demo-vault" ]; then
    cp "$W/tests/e2e/demo-vault/"*.md "$VAULT/"
else
    printf '# E2E vault\n\nA note for the plugin to attach.\n' >"$VAULT/Welcome.md"
fi
python3 - "$VAULT/.obsidian/plugins/darjeeling/data.json" "$TOKEN" "$PORT" "$SRV_VAULT" <<'PY'
import json, sys
path, token, port, cwd = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
json.dump({
    "hasCompletedOnboarding": True,
    "runtimeMode": "remote",
    "askHostOnNewSession": False,
    "meshnetHost": "127.0.0.1", "port": port, "authToken": token,
    "remoteHosts": [{"id": "lab", "name": "Lab host", "host": "127.0.0.1", "port": port, "authToken": token}],
    "activeRemoteHostId": "lab",
    "agent": "claude", "model": "", "effort": "", "permissionMode": "plan",
    "remoteCwd": cwd, "partialMessages": False, "attachActiveNote": False,
}, open(path, "w"), indent=2)
PY

python3 - "$VAULT" <<'PY'
import json, sys, time
json.dump({"vaults": {"e2e0000000000001": {"path": sys.argv[1], "ts": int(time.time() * 1000), "open": True}},
           "updateDisabled": True}, open("/root/.config/obsidian/obsidian.json", "w"))
PY

# 4. Launch Obsidian under Xvfb with remote debugging
BIN=$(command -v obsidian || echo /opt/Obsidian/obsidian)
t0=$(date +%s)
xvfb-run -a -s "-screen 0 1280x860x24" "$BIN" \
    --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --remote-debugging-port=9222 --remote-allow-origins='*' \
    >"$OUT/obsidian.log" 2>&1 &

ok=0
for _ in $(seq 1 60); do
    if curl -fsS http://127.0.0.1:9222/json/version >"$OUT/cdp-version.json" 2>/dev/null; then ok=1; break; fi
    sleep 1
done
if [ "$ok" != 1 ]; then
    echo "FAIL obsidian: CDP never came up"
    tail -n 30 "$OUT/obsidian.log"
    exit 1
fi
echo "INFO obsidian $OBSIDIAN_VERSION CDP up after $(($(date +%s) - t0))s"

# 5. Run Suite
node "$W/scripts/lab/e2e/runner.mjs" "$OUT" "$GREP"
rc=$?

if [ -z "$GREP" ] || echo "$GREP" | grep -qiE "ac-16|timing|startup"; then
    echo "=== AC-16 Startup Timing Harness ==="
    node "$W/scripts/lab/e2e/timing-harness.mjs" "$OUT" || rc=1
fi

pkill -f obsidian >/dev/null 2>&1 || true
pkill -f mock_openai >/dev/null 2>&1 || true
exit "$rc"

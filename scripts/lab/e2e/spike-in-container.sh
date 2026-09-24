#!/usr/bin/env bash
# E2E feasibility spike. Runs INSIDE the dj-lab Obsidian container (/work is
# the synced repo). Boots a local Darjeeling server with the fake agents, a
# pre-seeded test vault with the committed plugin build, and real Obsidian
# under Xvfb with CDP on :9222; then drives it with scripts/lab/e2e/spike.mjs.
set -uo pipefail

if [ ! -f /run/.containerenv ] && [ ! -f /.dockerenv ]; then
    echo "spike-in-container.sh: refusing to run outside a container" >&2
    exit 99
fi

W=/work
OUT="$W/_lab/e2e"
VAULT=/root/e2e-vault
SRV_VAULT=/root/srv-vault
TOKEN="e2e-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
PORT=8765
rm -rf "$OUT"
mkdir -p "$OUT" "$VAULT/.obsidian/plugins/darjeeling" "$SRV_VAULT" /root/.config/obsidian /tmp/e2e-tmux

# ---------------------------------------------------------------- server
python3 -m venv /tmp/srv-venv >/dev/null
/tmp/srv-venv/bin/pip install -q -r "$W/server/requirements.txt" >"$OUT/pip.log" 2>&1 || {
    echo "FAIL server deps"
    exit 1
}
printf '# Server-side vault\n' >"$SRV_VAULT/README.md"
env PATH="$W/tests/fakes/bin:/usr/local/bin:/usr/bin:/bin" HOME=/root TMUX_TMPDIR=/tmp/e2e-tmux \
    DARJEELING_HOST=127.0.0.1 DARJEELING_PORT="$PORT" DARJEELING_TOKEN="$TOKEN" \
    DARJEELING_VAULT="$SRV_VAULT" FAKE_AGENT_DELAY_MS=40 FAKE_AGENT_TRANSCRIPTS=1 \
    /tmp/srv-venv/bin/python "$W/server/server.py" >"$OUT/server.log" 2>&1 &
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.5; done

# ---------------------------------------------------------------- vault
cp "$W/main.js" "$W/manifest.json" "$W/styles.css" "$VAULT/.obsidian/plugins/darjeeling/"
printf '["darjeeling"]\n' >"$VAULT/.obsidian/community-plugins.json"
printf '# E2E vault\n\nA note for the plugin to attach.\n' >"$VAULT/Welcome.md"
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
# Register the vault as open so Obsidian skips the vault picker, and keep the
# app from self-updating mid-test.
python3 - "$VAULT" <<'PY'
import json, sys, time
json.dump({"vaults": {"e2e0000000000001": {"path": sys.argv[1], "ts": int(time.time() * 1000), "open": True}},
           "updateDisabled": True}, open("/root/.config/obsidian/obsidian.json", "w"))
PY

# ---------------------------------------------------------------- obsidian
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
echo "INFO obsidian $OBSIDIAN_VERSION CDP up after $(($(date +%s) - t0))s: $(python3 -c 'import json;d=json.load(open("'"$OUT"'/cdp-version.json"));print(d.get("Browser"), d.get("User-Agent","")[-40:])')"

node "$W/scripts/lab/e2e/spike.mjs" "$OUT"
rc=$?
free -m | awk '/Mem:/{print "INFO container memory used " $3 " MB"}'
pkill -f obsidian >/dev/null 2>&1 || true
exit "$rc"

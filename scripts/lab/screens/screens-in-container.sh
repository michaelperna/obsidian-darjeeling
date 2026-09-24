#!/usr/bin/env bash
# screens-in-container.sh -- Runs visual harness & Playwright screenshot matrix inside Obsidian container
set -euo pipefail

if [ ! -f /run/.containerenv ] && [ ! -f /.dockerenv ]; then
    echo "screens-in-container.sh: refusing to run outside a container" >&2
    exit 99
fi

W=/work
OUT="$W/_lab/screens"
ONLY="${1:-}"

rm -rf "$OUT"
mkdir -p "$OUT"

# 1. Extract Obsidian app.css if available inside the container
ASAR_PATH="/opt/Obsidian/resources/obsidian.asar"
if [ -f "$ASAR_PATH" ]; then
    echo "screens: extracting app.css from $ASAR_PATH"
    npx --yes asar extract-file "$ASAR_PATH" app.css "$W/scripts/lab/screens/app.css" 2>/dev/null || true
fi

# 2. Launch Obsidian under Xvfb with remote debugging
BIN=$(command -v obsidian || echo /opt/Obsidian/obsidian)
echo "screens: launching Obsidian with remote debugging on port 9222"
xvfb-run -a -s "-screen 0 1280x1024x24" "$BIN" \
    --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --remote-debugging-port=9222 --remote-allow-origins='*' \
    >"$OUT/obsidian.log" 2>&1 &
OBS_PID=$!

cleanup() {
    kill "$OBS_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in $(seq 1 60); do
    if curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
        echo "screens: Obsidian CDP available on port 9222"
        break
    fi
    sleep 1
done

# 3. Launch screens-runner
echo "screens: starting screens-runner with ONLY='${ONLY:-all}'"
set +e
node "$W/scripts/lab/screens/screens-runner.mjs" "$OUT" "$ONLY"
rc=$?
set -e

echo "screens: complete (exit code: $rc, artifacts at $OUT)"
exit "$rc"

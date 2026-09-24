#!/usr/bin/env bash
# sync-in-container.sh -- Runs Syncthing verification inside container
set -euo pipefail

if [ ! -f /run/.containerenv ] && [ ! -f /.dockerenv ]; then
    echo "sync-in-container.sh: refusing to run outside a container" >&2
    exit 99
fi

W=/work
OUT="$W/_lab/vault-sync"
rm -rf "$OUT"
mkdir -p "$OUT"

python3 "$W/scripts/lab/vault-sync/sync_test.py" 2>&1 | tee "$OUT/sync-test.log"
exit "${PIPESTATUS[0]}"

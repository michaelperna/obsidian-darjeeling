#!/usr/bin/env bash
# host-vault-sync-check.sh -- Host side of `lab.sh vault-sync-check`: runs Syncthing isolation test in container
set -euo pipefail

LAB_RUN=${1:?usage: host-vault-sync-check.sh <run-id>}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR source=host-common.sh
. "$HERE/host-common.sh"

TREE="$LAB_DIR/vault-sync/$LAB_RUN"
OUT="$TREE/_lab"
NAME="dj-lab-vault-sync-$LAB_RUN"
IMAGE="localhost/dj-lab/syncthing:latest"
[ -f "$TREE/package.json" ] || die "no synced tree at $TREE"
mkdir -p "$OUT"

# shellcheck disable=SC2317
cleanup() {
    podman rm -f "$NAME" >/dev/null 2>&1 || true
    release_slot_marker
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

acquire_slot
reap_stale
if ! ensure_image "$IMAGE" "$TREE/scripts/lab/vault-sync/Containerfile.syncthing" "$TREE/scripts/lab/vault-sync" \
    >/dev/null 2>&1; then
    die "Syncthing image build failed"
fi
wait_container_budget
set_labels vault-sync
log "running $NAME for vault-sync isolation check"
set +e
podman run --rm --name "$NAME" "${LAB_LABELS[@]}" \
    --memory "$LAB_MEM" --cpus "$LAB_CPUS" --pids-limit 4096 \
    -v "$TREE:/work" "$IMAGE" bash /work/scripts/lab/vault-sync/sync-in-container.sh
rc=$?
set -e
prune_runs vault-sync "${DJ_LAB_KEEP_RUNS:-8}"
log "artifacts (logs): $OUT/vault-sync/"
exit "$rc"

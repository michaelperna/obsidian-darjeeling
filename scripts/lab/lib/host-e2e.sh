#!/usr/bin/env bash
# Host side of `lab.sh e2e-spike`: real Obsidian under Xvfb in a disposable
# container, driven over CDP. Feasibility spike for the plugin E2E suite.
#   bash ~/dj-lab/e2e/<run>/scripts/lab/lib/host-e2e.sh <run>
set -euo pipefail

LAB_RUN=${1:?usage: host-e2e.sh <run-id>}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR source=host-common.sh
. "$HERE/host-common.sh"

TREE="$LAB_DIR/e2e/$LAB_RUN"
OUT="$TREE/_lab"
NAME="dj-lab-e2e-$LAB_RUN"
OBS_VERSION="${DJ_LAB_OBSIDIAN_VERSION:-1.13.7}"
IMAGE="localhost/dj-lab/obsidian:$OBS_VERSION"
[ -f "$TREE/main.js" ] || die "no synced tree (or no main.js) at $TREE"
mkdir -p "$OUT"

# shellcheck disable=SC2317  # invoked via trap
cleanup() {
    podman rm -f "$NAME" >/dev/null 2>&1 || true
    release_slot_marker
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

acquire_slot
reap_stale
if ! ensure_image "$IMAGE" "$TREE/scripts/lab/e2e/Containerfile.obsidian" "$TREE/scripts/lab/e2e" \
    "OBSIDIAN_VERSION=$OBS_VERSION" >"$OUT/image-build.log" 2>&1; then
    tail -n 30 "$OUT/image-build.log" >&2
    die "Obsidian image build failed (log: $OUT/image-build.log)"
fi
wait_container_budget
set_labels e2e
log "running $NAME (Obsidian $OBS_VERSION)"
set +e
podman run --rm --name "$NAME" "${LAB_LABELS[@]}" \
    --memory "$LAB_MEM" --cpus "$LAB_CPUS" --pids-limit 4096 --shm-size 512m \
    -v "$TREE:/work" "$IMAGE" bash /work/scripts/lab/e2e/e2e-in-container.sh "${DJ_LAB_GREP:-}"
rc=$?
set -e
prune_runs e2e "${DJ_LAB_KEEP_RUNS:-8}"
log "artifacts (screenshots, logs): $OUT/e2e/"
exit "$rc"

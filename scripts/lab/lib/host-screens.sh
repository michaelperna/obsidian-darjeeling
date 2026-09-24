#!/usr/bin/env bash
# host-screens.sh -- Host side of `lab.sh screens`: runs visual harness & Playwright matrix in container
set -euo pipefail

LAB_RUN=${1:?usage: host-screens.sh <run-id>}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR source=host-common.sh
. "$HERE/host-common.sh"

TREE="$LAB_DIR/screens/$LAB_RUN"
OUT="$TREE/_lab"
NAME="dj-lab-screens-$LAB_RUN"
OBS_VERSION="${DJ_LAB_OBSIDIAN_VERSION:-1.13.7}"
IMAGE="localhost/dj-lab/obsidian:$OBS_VERSION"
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
if ! ensure_image "$IMAGE" "$TREE/scripts/lab/e2e/Containerfile.obsidian" "$TREE/scripts/lab/e2e" \
    "OBSIDIAN_VERSION=$OBS_VERSION" >"$OUT/image-build.log" 2>&1; then
    tail -n 30 "$OUT/image-build.log" >&2
    die "Obsidian image build failed (log: $OUT/image-build.log)"
fi
wait_container_budget
set_labels screens
log "running $NAME for visual QA"
set +e
podman run --rm --name "$NAME" "${LAB_LABELS[@]}" \
    --memory "$LAB_MEM" --cpus "$LAB_CPUS" --pids-limit 4096 --shm-size 512m \
    -v "$TREE:/work" "$IMAGE" bash /work/scripts/lab/screens/screens-in-container.sh "${DJ_LAB_ONLY:-}"
rc=$?
set -e
prune_runs screens "${DJ_LAB_KEEP_RUNS:-8}"
log "artifacts (screenshots, logs): $OUT/screens/"
exit "$rc"

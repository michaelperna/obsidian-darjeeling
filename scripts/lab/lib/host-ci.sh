#!/usr/bin/env bash
# Host side of `lab.sh ci`. Runs on the lab host from the synced tree:
#   bash ~/dj-lab/ci/<run>/scripts/lab/lib/host-ci.sh <run>
set -euo pipefail

LAB_RUN=${1:?usage: host-ci.sh <run-id>}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR source=host-common.sh
. "$HERE/host-common.sh"

TREE="$LAB_DIR/ci/$LAB_RUN"
OUT="$TREE/_lab"
NAME="dj-lab-ci-$LAB_RUN"
IMAGE="localhost/dj-lab/ci:node22"
[ -f "$TREE/package.json" ] || die "no synced tree at $TREE"
mkdir -p "$OUT"

# shellcheck disable=SC2317  # invoked via trap
cleanup() {
    podman rm -f "$NAME" >/dev/null 2>&1 || true
    if [ "${DJ_LAB_KEEP:-0}" != "1" ]; then
        rm -rf "$TREE/node_modules"
    fi
    release_slot_marker
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

acquire_slot
reap_stale

if ! ensure_image "$IMAGE" "$TREE/scripts/lab/images/Containerfile.ci" \
    "$TREE/scripts/lab/images" "BASE=docker.io/library/node:22-bookworm" \
    >"$OUT/image-build.log" 2>&1; then
    tail -n 30 "$OUT/image-build.log" >&2
    die "CI image build failed (log: $OUT/image-build.log)"
fi
ensure_volume dj-lab-npm-cache
ensure_volume dj-lab-pip-cache

wait_container_budget
set_labels ci
log "running CI container $NAME (${LAB_CPUS} cpu, ${LAB_MEM})"

set +e
podman run --rm --name "$NAME" "${LAB_LABELS[@]}" \
    --memory "$LAB_MEM" --cpus "$LAB_CPUS" --pids-limit 4096 \
    -v "$TREE:/work" \
    -v dj-lab-npm-cache:/root/.npm \
    -v dj-lab-pip-cache:/root/.cache/pip \
    -e DJ_LAB_RUN="$LAB_RUN" \
    -e DJ_LAB_STAGES="${DJ_LAB_STAGES:-all}" \
    -e DJ_LAB_IN_CONTAINER=1 \
    -e DJ_LAB_PYTEST_ARGS="${DJ_LAB_PYTEST_ARGS:-}" \
    "$IMAGE" bash /work/scripts/lab/lib/ci-stages.sh
rc=$?
set -e

prune_runs ci "${DJ_LAB_KEEP_RUNS:-8}"
log "logs: $LAB_DIR/ci/$LAB_RUN/_lab/"
exit "$rc"

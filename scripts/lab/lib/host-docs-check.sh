#!/usr/bin/env bash
# host-docs-check.sh -- Host side of `lab.sh docs-check`.
# Runs on the lab host from the synced tree:
#   bash ~/dj-lab/docs-check/<run>/scripts/lab/lib/host-docs-check.sh <run> [distro] [doc-path]
set -euo pipefail

LAB_RUN=${1:?usage: host-docs-check.sh <run-id> [distro] [doc-path]}
DISTRO=${2:-debian13}
DOC_PATH=${3:-docs/install-server.md}

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR source=host-common.sh
. "$HERE/host-common.sh"

case "$DISTRO" in
    debian12) BASE=docker.io/library/debian:12 ;;
    debian13) BASE=docker.io/library/debian:13 ;;
    ubuntu2204) BASE=docker.io/library/ubuntu:22.04 ;;
    ubuntu2404) BASE=docker.io/library/ubuntu:24.04 ;;
    ubuntu2604) BASE=docker.io/library/ubuntu:26.04 ;;
    *) die "unknown distro '$DISTRO' (debian12|debian13|ubuntu2204|ubuntu2404|ubuntu2604)" ;;
esac

TREE="$LAB_DIR/docs-check/$LAB_RUN"
OUT="$TREE/_lab/docs-check/$DISTRO"
NAME="dj-lab-doc-$DISTRO-$LAB_RUN"
IMAGE="localhost/dj-lab/$DISTRO"
mkdir -p "$OUT"

CF="${DJ_LAB_CONTAINERFILE:-$LAB_DIR/images/Containerfile.debian}"
if [ ! -f "$CF" ]; then
    CF="$TREE/scripts/lab/images/Containerfile.systemd"
fi

cleanup() {
    if [ "${DJ_LAB_KEEP:-0}" = "1" ]; then
        log "DJ_LAB_KEEP=1: leaving $NAME running. Remove with: podman rm -f $NAME"
    else
        podman rm -f "$NAME" >/dev/null 2>&1 || true
    fi
    release_slot_marker
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

acquire_slot
reap_stale

if ! ensure_image "$IMAGE" "$CF" "$(dirname "$CF")" "BASE=$BASE" >"$OUT/image-build.log" 2>&1; then
    tail -n 30 "$OUT/image-build.log" >&2
    die "image build failed for $DISTRO (log: $OUT/image-build.log)"
fi

wait_container_budget
set_labels "docs-check-$DISTRO"
log "starting $NAME from $IMAGE"
podman run -d --name "$NAME" "${LAB_LABELS[@]}" --systemd=always \
    --memory "$LAB_MEM" --cpus "$LAB_CPUS" --pids-limit 4096 \
    --hostname "dj-lab-doc-$DISTRO" "$IMAGE" >/dev/null

wait_systemd "$NAME"

log "copying repository tree into container"
podman exec "$NAME" mkdir -p /home/tester/darjeeling
tar -C "$TREE" --exclude="./.git" --exclude="./node_modules" --exclude="./_lab" -cf - . \
    | podman exec -i "$NAME" tar -C /home/tester/darjeeling -xf -
podman exec "$NAME" chown -R tester:tester /home/tester

log "extracting shell blocks from $DOC_PATH"
mkdir -p "$OUT/doc-steps"
python3 "$TREE/scripts/lab/lib/extract-doc-blocks.py" \
    "$TREE/$DOC_PATH" --out-dir "$OUT/doc-steps" >"$OUT/extracted.log" 2>&1

cat "$OUT/extracted.log"

podman exec "$NAME" mkdir -p /tmp/doc-steps
tar -C "$OUT/doc-steps" -cf - . | podman exec -i "$NAME" tar -C /tmp/doc-steps -xf -


# Execute extracted runnable steps in order
log "executing runnable doc steps inside container"
for step in $(podman exec "$NAME" find /tmp/doc-steps -name "step-*.sh" | sort); do
    step_base=$(basename "$step")
    log "running $step_base"
    if ! podman exec "$NAME" bash "$step" >"$OUT/$step_base.log" 2>&1; then
        log "FAILED: $step_base"
        cat "$OUT/$step_base.log" >&2
        die "docs-check step $step_base failed"
    fi
    log "PASS: $step_base"
done

# Final verification: check authenticated /api/agents endpoint
log "verifying authenticated /api/agents endpoint"
if ! podman exec "$NAME" curl -fsS -m 5 -H "Authorization: Bearer $(podman exec "$NAME" cat /var/lib/darjeeling/.token)" http://127.0.0.1:8765/api/agents >"$OUT/api-agents.json" 2>&1; then
    die "authenticated /api/agents probe failed"
fi

log "docs-check completed successfully for $DISTRO against $DOC_PATH"
echo "PASS docs-check $DISTRO $DOC_PATH" >"$OUT/results.tsv"

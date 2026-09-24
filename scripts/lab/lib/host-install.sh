#!/usr/bin/env bash
# Host side of `lab.sh install <distro>`. Runs on the lab host from the synced tree:
#   bash ~/dj-lab/install/<run>/scripts/lab/lib/host-install.sh <run> <distro>
# Starts a fresh systemd container for <distro>, copies the tree in, and runs
# install-check.sh inside it. The container is always destroyed unless
# DJ_LAB_KEEP=1.
set -euo pipefail

LAB_RUN=${1:?usage: host-install.sh <run-id> <distro>}
DISTRO=${2:?usage: host-install.sh <run-id> <distro>}
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

TREE="$LAB_DIR/install/$LAB_RUN"
OUT="$TREE/_lab/$DISTRO"
NAME="dj-lab-inst-$DISTRO-$LAB_RUN"
IMAGE="localhost/dj-lab/$DISTRO"
[ -f "$TREE/server/install.sh" ] || [ -f "$TREE/dist/install.sh" ] || [ -n "${DJ_LAB_TARBALL:-}" ] || die "no synced tree at $TREE"
mkdir -p "$OUT"

CF="${DJ_LAB_CONTAINERFILE:-$LAB_DIR/images/Containerfile.debian}"
if [ ! -f "$CF" ]; then
    CF="$TREE/scripts/lab/images/Containerfile.systemd"
fi

# shellcheck disable=SC2317  # invoked via trap
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
set_labels "install-$DISTRO"
log "starting $NAME from $IMAGE"
podman run -d --name "$NAME" "${LAB_LABELS[@]}" --systemd=always \
    --memory "$LAB_MEM" --cpus "$LAB_CPUS" --pids-limit 4096 \
    --hostname "dj-lab-$DISTRO" "$IMAGE" >/dev/null

state=""
for _ in $(seq 1 60); do
    state=$(podman exec "$NAME" systemctl is-system-running 2>/dev/null || true)
    case "$state" in running | degraded) break ;; esac
    sleep 1
done
log "systemd in container: ${state:-unknown}"

# Copy the tree in as the unprivileged user's checkout, the way `git clone`
# would leave it (the container has no git, see install-check.sh preflight).
podman exec "$NAME" mkdir -p /home/tester/darjeeling /opt/dj-lab/out
tar -C "$TREE" --exclude=./_lab -cf - . | podman exec -i "$NAME" tar -C /home/tester/darjeeling -xf -
podman exec "$NAME" chown -R tester:tester /home/tester/darjeeling

set +e
timeout "${DJ_LAB_INSTALL_TIMEOUT:-3600}" podman exec \
    -e DJ_LAB_DISTRO="$DISTRO" \
    -e DJ_LAB_EXTENDED="${DJ_LAB_EXTENDED:-0}" \
    -e DJ_LAB_SKIP_RERUN="${DJ_LAB_SKIP_RERUN:-0}" \
    -e DJ_LAB_TARBALL="${DJ_LAB_TARBALL:-}" \
    -e DJ_LAB_NETWORK="${DJ_LAB_NETWORK:-loopback}" \
    -e DJ_LAB_SCENARIO="${DJ_LAB_SCENARIO:-fresh}" \
    "$NAME" bash /home/tester/darjeeling/scripts/lab/lib/install-check.sh
rc=$?
set -e

podman cp "$NAME:/opt/dj-lab/out/." "$OUT/" >/dev/null 2>&1 || log "could not copy results out of $NAME"
log "results: $OUT/results.tsv  logs: $OUT/"
prune_runs install "${DJ_LAB_KEEP_RUNS:-8}"
exit "$rc"

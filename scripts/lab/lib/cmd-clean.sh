#!/usr/bin/env bash
# cmd-clean.sh -- lab.sh clean implementation
set -euo pipefail

cmd_clean() {
    local all=0 force=0 dry=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --all) all=1; shift ;;
            --force) force=1; shift ;;
            --dry-run) dry=1; shift ;;
            -h | --help) usage ;;
            *) die "clean: unknown option $1" ;;
        esac
    done
    rssh "LAB=~/$LAB_REMOTE_DIR ALL=$all FORCE=$force DRY=$dry bash -s" <<'REMOTE'
set -u
do_() { if [ "$DRY" = 1 ]; then echo "  would: $*"; else "$@"; fi; }
busy=""
for f in "$LAB"/.slot.*.lock; do
    [ -e "$f" ] || continue
    flock -n "$f" true || busy="$busy $(cat "${f%.lock}.owner" 2>/dev/null | awk '{print $2}')"
done
if [ -n "$busy" ] && [ "$FORCE" != 1 ]; then
    echo "lab clean: runs in progress:$busy -- refusing (use --force to kill them)" >&2
    exit 3
fi
# Running dj-lab-* containers this tool did not start belong to someone else.
foreign=$(podman ps --filter name='^dj-lab-' --format '{{.Names}} {{index .Labels "dj-lab.tool"}}' | awk '$2 != "lab" {print $1}')
if [ -n "$foreign" ] && [ "$FORCE" != 1 ]; then
    echo "lab clean: running dj-lab-* containers not started by lab.sh:" $foreign "-- refusing (use --force)" >&2
    exit 3
fi
ids=$(podman ps -aq --filter name='^dj-lab-'; podman ps -aq --filter label=dj-lab.tool=lab)
ids=$(printf '%s\n' "$ids" | sort -u | grep . || true)
echo "containers: $(printf '%s\n' "$ids" | grep -c . || true)"
[ -z "$ids" ] || do_ podman rm -f $ids >/dev/null
vols=$(podman volume ls -q --filter name='^dj-lab-')
echo "volumes: $(printf '%s\n' "$vols" | grep -c . || true)"
[ -z "$vols" ] || do_ podman volume rm -f $vols >/dev/null
echo "run dirs: $LAB/ci $LAB/install $LAB/e2e"
do_ rm -rf "$LAB/ci" "$LAB/install" "$LAB/e2e"
if [ "$ALL" = 1 ]; then
    imgs=$(podman images --filter reference='localhost/dj-lab/*' --format '{{.Repository}}:{{.Tag}}')
    for base in docker.io/library/node:22-bookworm docker.io/library/debian:12 docker.io/library/debian:13 \
                docker.io/library/ubuntu:22.04 docker.io/library/ubuntu:24.04; do
        podman image exists "$base" && imgs="$imgs $base"
    done
    echo "images: $(printf '%s\n' $imgs | grep -c . || true)"
    [ -z "$(printf '%s' "$imgs" | tr -d ' ')" ] || do_ podman rmi -f $imgs >/dev/null
    do_ podman image prune -f >/dev/null
fi
echo "lab clean: done$([ "$DRY" = 1 ] && echo ' (dry run)')"
REMOTE
}

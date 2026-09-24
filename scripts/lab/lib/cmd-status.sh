#!/usr/bin/env bash
# cmd-status.sh -- lab.sh status implementation
set -euo pipefail

cmd_status() {
    rssh "LAB=~/$LAB_REMOTE_DIR bash -s" <<'REMOTE'
set -u
echo "host: $(hostname)  load: $(cut -d' ' -f1-3 /proc/loadavg)  mem avail: $(awk '/MemAvailable/{printf "%.1f GB", $2/1048576}' /proc/meminfo)"
echo "slots:"
for f in "$LAB"/.slot.*.lock; do
    [ -e "$f" ] || continue
    if flock -n "$f" true; then state=free; else state="busy ($(cat "${f%.lock}.owner" 2>/dev/null))"; fi
    echo "  $(basename "$f" .lock): $state"
done
echo "containers (dj-lab-*):"
podman ps -a --filter name='^dj-lab-' --format '  {{.Names}}  {{.Status}}  {{.Image}}'
echo "images:"
podman images --filter reference='localhost/dj-lab/*' --format '  {{.Repository}}:{{.Tag}}  {{.Size}}  {{.Created}}'
echo "volumes:"
podman volume ls --filter name='^dj-lab-' --format '  {{.Name}}'
echo "run dirs: $(du -sh "$LAB/ci" "$LAB/install" "$LAB/e2e" 2>/dev/null | awk '{printf "%s %s  ", $2, $1}')"
REMOTE
}

#!/usr/bin/env bash
# Shared helpers for the host side of the Darjeeling lab. Sourced by host-*.sh,
# never run directly. Everything here runs on the lab host as the unprivileged
# lab user, using rootless podman only.
# The LAB_* settings below are read by the scripts that source this file:
# shellcheck disable=SC2034

LAB_DIR="${DJ_LAB_DIR:-$HOME/dj-lab}"
LAB_SLOTS="${DJ_LAB_SLOTS:-2}"              # concurrent lab jobs on the host
LAB_MAX_CONTAINERS="${DJ_LAB_MAX_CONTAINERS:-2}"  # running dj-lab-* containers, any owner
LAB_SLOT_WAIT="${DJ_LAB_SLOT_WAIT:-3600}"   # seconds to queue before giving up
LAB_MEM="${DJ_LAB_MEMORY:-2g}"
LAB_CPUS="${DJ_LAB_CPUS:-2}"
LAB_STALE_SECS="${DJ_LAB_STALE_SECS:-10800}" # lab containers older than this are reaped
LAB_RUN="${LAB_RUN:-unknown}"
LAB_SLOT=""
LAB_LABELS=()

log() { printf '[lab %s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() {
    log "ERROR: $*"
    exit 2
}

# Take one of LAB_SLOTS flock slots, queueing if all are busy. The lock is held
# by an fd of this shell and is released automatically when it exits, however
# it exits, so a killed run can never wedge the queue.
acquire_slot() {
    local waited=0 i fd
    mkdir -p "$LAB_DIR"
    while :; do
        for ((i = 1; i <= LAB_SLOTS; i++)); do
            exec {fd}>"$LAB_DIR/.slot.$i.lock"
            if flock -n "$fd"; then
                LAB_SLOT=$i
                printf '%s %s %s\n' "$$" "$LAB_RUN" "$(date +%s)" >"$LAB_DIR/.slot.$i.owner"
                log "slot $i/$LAB_SLOTS acquired (run $LAB_RUN)"
                return 0
            fi
            exec {fd}>&-
        done
        if ((waited == 0)); then
            log "all $LAB_SLOTS lab slots busy; queueing (max ${LAB_SLOT_WAIT}s)"
        fi
        if ((waited >= LAB_SLOT_WAIT)); then
            die "gave up waiting for a lab slot after ${waited}s"
        fi
        sleep 5
        waited=$((waited + 5))
    done
}

release_slot_marker() {
    if [ -n "$LAB_SLOT" ]; then
        rm -f "$LAB_DIR/.slot.$LAB_SLOT.owner"
    fi
}

# Labels every lab container carries. `lab.sh clean` and the reaper key off
# dj-lab.tool; Ctrl-C on the Mac keys off dj-lab.run.
set_labels() {
    LAB_LABELS=(
        --label dj-lab.tool=lab
        --label "dj-lab.run=$LAB_RUN"
        --label "dj-lab.kind=$1"
        --label "dj-lab.started=$(date +%s)"
    )
}

# Remove lab containers left behind by a crashed or disconnected run.
reap_stale() {
    local now name started
    now=$(date +%s)
    while IFS=$'\t' read -r name started; do
        [ -n "$name" ] || continue
        case "$started" in '' | *[!0-9]*) continue ;; esac
        if ((now - started > LAB_STALE_SECS)); then
            log "reaping stale lab container $name"
            podman rm -f "$name" >/dev/null 2>&1 || true
        fi
    done < <(podman ps -a --filter label=dj-lab.tool=lab \
        --format '{{.Names}}{{"\t"}}{{index .Labels "dj-lab.started"}}' 2>/dev/null)
}

running_lab_containers() {
    podman ps --filter name='^dj-lab-' --format '{{.Names}}' 2>/dev/null | grep -c . || true
}

# The host is the owner's live server: never exceed LAB_MAX_CONTAINERS running
# dj-lab-* containers, counting ones started outside this tool too.
wait_container_budget() {
    local waited=0 n
    while :; do
        n=$(running_lab_containers)
        if ((n < LAB_MAX_CONTAINERS)); then
            return 0
        fi
        if ((waited == 0)); then
            log "$n dj-lab containers already running (budget $LAB_MAX_CONTAINERS); waiting"
        fi
        if ((waited >= LAB_SLOT_WAIT)); then
            die "container budget never freed up after ${waited}s"
        fi
        sleep 5
        waited=$((waited + 5))
    done
}

# ensure_image TAG CONTAINERFILE CONTEXT [BUILD_ARG=VALUE ...]
# Builds only when the recipe (Containerfile bytes + build args) changed, or
# DJ_LAB_REBUILD=1. The recipe hash is stored as an image label.
ensure_image() {
    local tag=$1 file=$2 ctx=$3
    shift 3
    local want have a
    local args=()
    want=$({
        sha256sum "$file" | cut -d' ' -f1
        printf '%s\n' "$@"
    } | sha256sum | cut -c1-16)
    have=$(podman image inspect --format '{{index .Labels "dj-lab.recipe"}}' "$tag" 2>/dev/null || true)
    if [ "$have" = "$want" ] && [ "${DJ_LAB_REBUILD:-0}" != "1" ]; then
        log "image $tag cached ($want)"
        return 0
    fi
    for a in "$@"; do
        args+=(--build-arg "$a")
    done
    log "building image $tag (recipe $want)"
    podman build --label "dj-lab.recipe=$want" "${args[@]}" -t "$tag" -f "$file" "$ctx"
}

ensure_volume() {
    podman volume exists "$1" 2>/dev/null || podman volume create "$1" >/dev/null
}

# Keep the newest $2 run dirs under $LAB_DIR/$1, never touching a run that
# currently holds a slot.
prune_runs() {
    local kind=$1 keep=$2 dir base active
    active=$(cat "$LAB_DIR"/.slot.*.owner 2>/dev/null | awk '{print $2}')
    [ -d "$LAB_DIR/$kind" ] || return 0
    while IFS= read -r dir; do
        [ -n "$dir" ] || continue
        base=$(basename "$dir")
        if printf '%s\n' "$active" | grep -qxF "$base"; then
            continue
        fi
        rm -rf "$dir"
    done < <(find "$LAB_DIR/$kind" -mindepth 1 -maxdepth 1 -type d | sort | head -n "-$keep")
}

wait_systemd() {
    local name="$1" state=""
    for _ in $(seq 1 60); do
        state=$(podman exec "$name" systemctl is-system-running 2>/dev/null || true)
        case "$state" in running | degraded) break ;; esac
        sleep 1
    done
    log "systemd in container: ${state:-unknown}"
}


#!/usr/bin/env bash
# lab.sh -- Darjeeling test lab CLI.
#
# Runs on the Mac; every heavy step (npm, pip, pytest, shellcheck, installers)
# happens in disposable rootless podman containers on the lab host. The Mac
# only rsyncs the working tree and prints results. See scripts/lab/README.md.
#
#   scripts/lab/lab.sh ci [--stages plugin,server,shell] [--keep] [--rebuild]
#   scripts/lab/lab.sh install <debian12|debian13|ubuntu2204|ubuntu2404|ubuntu2604|all>... [-j N] [--extended] [--patch node,meshnet,owner|all] [--skip-rerun] [--keep] [--rebuild]
#   scripts/lab/lab.sh e2e [--grep RE] [--obsidian VERSION] [--fetch DIR] [--rebuild] [--keep]
#   scripts/lab/lab.sh screens [--only NAME] [--obsidian VERSION] [--fetch DIR] [--rebuild] [--keep]
#   scripts/lab/lab.sh vault-sync-check [--fetch DIR] [--rebuild] [--keep]
#   scripts/lab/lab.sh docs-check [--distro DISTRO] [--doc PATH] [--fetch DIR] [--rebuild] [--keep]
#   scripts/lab/lab.sh e2e-spike [--fetch DIR]
#   scripts/lab/lab.sh status
#   scripts/lab/lab.sh clean [--all] [--force] [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Per-checkout settings (git-ignored): DJ_LAB_HOST=user@host and friends.
# Environment variables win over the file.
if [ -f "$SCRIPT_DIR/lab.env" ]; then
    while IFS='=' read -r key value; do
        case "$key" in DJ_LAB_*) [ -n "${!key:-}" ] || export "$key=$value" ;; esac
    done <"$SCRIPT_DIR/lab.env"
fi
LAB_HOST="${DJ_LAB_HOST:-}"
LAB_REMOTE_DIR="${DJ_LAB_REMOTE_DIR:-dj-lab}" # relative to the remote $HOME
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=20 -o ServerAliveCountMax=6)
# shellcheck disable=SC2034
ALL_DISTROS=(debian12 debian13 ubuntu2204 ubuntu2404 ubuntu2604)
CURRENT_RUN=""

say() { printf '%s\n' "$*" >&2; }
die() {
    say "lab: $*"
    exit 2
}
# Remote commands are built locally on purpose (SC2029).
# shellcheck disable=SC2029
rssh() { ssh "${SSH_OPTS[@]}" "$LAB_HOST" "$@"; }

usage() {
    sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

new_run_id() {
    printf '%s-%s' "$(date +%Y%m%d-%H%M%S)" "$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')"
}

# Environment forwarded to the host scripts, shell-quoted.
remote_env() {
    local out="env" v
    for v in DJ_LAB_STAGES DJ_LAB_KEEP DJ_LAB_REBUILD DJ_LAB_EXTENDED DJ_LAB_SKIP_RERUN \
        DJ_LAB_SLOTS DJ_LAB_MAX_CONTAINERS DJ_LAB_MEMORY DJ_LAB_CPUS DJ_LAB_INSTALL_TIMEOUT \
        DJ_LAB_KEEP_RUNS DJ_LAB_SLOT_WAIT DJ_LAB_PYTEST_ARGS DJ_LAB_PATCH DJ_LAB_OBSIDIAN_VERSION \
        DJ_LAB_TARBALL DJ_LAB_NETWORK DJ_LAB_SCENARIO DJ_LAB_GREP; do
        if [ -n "${!v:-}" ]; then
            out="$out $v=$(printf '%q' "${!v}")"
        fi
    done
    printf '%s' "$out"
}

# Copy the working tree (not git HEAD: uncommitted work is what we test) to
# ~/dj-lab/<dest>/ on the host. Secrets and build output never leave the Mac.
sync_tree() {
    local dest=$1
    rssh "mkdir -p ~/$LAB_REMOTE_DIR/$dest"
    rsync -a --delete \
        --exclude node_modules --exclude .git --exclude __pycache__ --exclude .pytest_cache \
        --exclude .DS_Store --exclude _lab --exclude dist \
        --exclude server/config.env --exclude server/.token --exclude server/deepseek_sessions \
        --exclude '.env' --exclude '*.pem' --exclude '*.key' --exclude '.credentials.json' \
        -e "ssh ${SSH_OPTS[*]}" "$REPO_ROOT/" "$LAB_HOST:$LAB_REMOTE_DIR/$dest/"
}

on_interrupt() {
    trap - INT TERM
    if [ -n "$CURRENT_RUN" ]; then
        say ""
        say "lab: interrupted; removing containers of run $CURRENT_RUN on the host"
        rssh "podman ps -aq --filter label=dj-lab.run=$CURRENT_RUN | xargs -r podman rm -f >/dev/null" || true
    fi
    exit 130
}
trap on_interrupt INT TERM

available_cmds() {
    local cmd_scripts f name
    cmd_scripts=("$SCRIPT_DIR"/lib/cmd-*.sh)
    for f in "${cmd_scripts[@]}"; do
        [ -e "$f" ] || continue
        name="$(basename "$f" .sh)"
        printf '%s ' "${name#cmd-}"
    done
}

# ------------------------------------------------------------------ main
[ $# -gt 0 ] || usage 2
command -v rsync >/dev/null || die "rsync not found"
case "${1:-}" in -h | --help | help) usage ;; *)
    [ -n "$LAB_HOST" ] || die "no lab host: set DJ_LAB_HOST=user@host or copy scripts/lab/lab.env.example to scripts/lab/lab.env" ;;
esac
sub=$1
shift
cmd_file="$SCRIPT_DIR/lib/cmd-$sub.sh"
if [ -f "$cmd_file" ]; then
    # shellcheck source=/dev/null
    . "$cmd_file"
    "cmd_${sub//-/_}" "$@"
else
    die "unknown command '$sub' (available: $(available_cmds))"
fi

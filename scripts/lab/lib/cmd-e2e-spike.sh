#!/usr/bin/env bash
# cmd-e2e-spike.sh -- lab.sh e2e-spike implementation
set -euo pipefail

# shellcheck disable=SC2034
cmd_e2e_spike() {
    local fetch="" run rc
    while [ $# -gt 0 ]; do
        case "$1" in
            --fetch) fetch="${2:?--fetch needs a local directory}"; shift 2 ;;
            --rebuild) export DJ_LAB_REBUILD=1; shift ;;
            -h | --help) usage ;;
            *) die "e2e-spike: unknown option $1" ;;
        esac
    done
    say "lab e2e-spike: building plugin (npm run build)"
    (cd "$REPO_ROOT" && npm run build)
    run=$(new_run_id)
    CURRENT_RUN=$run
    say "lab e2e-spike: run $run -> $LAB_HOST:~/$LAB_REMOTE_DIR/e2e/$run"
    sync_tree "e2e/$run"
    set +e
    rssh "$(remote_env) bash ~/$LAB_REMOTE_DIR/e2e/$run/scripts/lab/lib/host-e2e.sh $run"
    rc=$?
    set -e
    CURRENT_RUN=""
    if [ -n "$fetch" ]; then
        mkdir -p "$fetch"
        rsync -a -e "ssh ${SSH_OPTS[*]}" "$LAB_HOST:$LAB_REMOTE_DIR/e2e/$run/_lab/e2e/" "$fetch/" || true
        say "lab e2e-spike: artifacts copied to $fetch"
    fi
    return "$rc"
}

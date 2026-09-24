#!/usr/bin/env bash
# cmd-ci.sh -- lab.sh ci implementation
set -euo pipefail

# shellcheck disable=SC2034
cmd_ci() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --stages) export DJ_LAB_STAGES="${2:?--stages needs a list}"; shift 2 ;;
            --keep) export DJ_LAB_KEEP=1; shift ;;
            --rebuild) export DJ_LAB_REBUILD=1; shift ;;
            -h | --help) usage ;;
            *) die "ci: unknown option $1" ;;
        esac
    done
    local run rc
    run=$(new_run_id)
    CURRENT_RUN=$run
    say "lab ci: run $run -> $LAB_HOST:~/$LAB_REMOTE_DIR/ci/$run"
    sync_tree "ci/$run"
    set +e
    rssh "$(remote_env) bash ~/$LAB_REMOTE_DIR/ci/$run/scripts/lab/lib/host-ci.sh $run"
    rc=$?
    set -e
    CURRENT_RUN=""
    say "lab ci: $([ "$rc" -eq 0 ] && echo PASS || echo "FAIL (exit $rc)")  logs: $LAB_HOST:~/$LAB_REMOTE_DIR/ci/$run/_lab/"
    return "$rc"
}

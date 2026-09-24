#!/usr/bin/env bash
# cmd-vault-sync-check.sh -- lab.sh vault-sync-check implementation
set -euo pipefail

# shellcheck disable=SC2034
cmd_vault_sync_check() {
    local fetch="" run rc
    while [ $# -gt 0 ]; do
        case "$1" in
            --fetch) fetch="${2:?--fetch needs a local directory}"; shift 2 ;;
            --rebuild) export DJ_LAB_REBUILD=1; shift ;;
            --keep) export DJ_LAB_KEEP=1; shift ;;
            -h | --help)
                echo "Usage: lab.sh vault-sync-check [--fetch DIR] [--rebuild] [--keep]"
                return 0
                ;;
            *) die "vault-sync-check: unknown option '$1'" ;;
        esac
    done

    run=$(new_run_id)
    CURRENT_RUN=$run
    say "lab vault-sync-check: run $run -> $LAB_HOST:~/$LAB_REMOTE_DIR/vault-sync/$run"
    sync_tree "vault-sync/$run"

    set +e
    rssh "$(remote_env) bash ~/$LAB_REMOTE_DIR/vault-sync/$run/scripts/lab/lib/host-vault-sync-check.sh $run"
    rc=$?
    set -e

    CURRENT_RUN=""
    if [ -n "$fetch" ]; then
        mkdir -p "$fetch"
        rsync -a -e "ssh ${SSH_OPTS[*]}" "$LAB_HOST:$LAB_REMOTE_DIR/vault-sync/$run/_lab/vault-sync/" "$fetch/" || true
        say "lab vault-sync-check: artifacts (logs) copied to $fetch"
    fi
    return "$rc"
}

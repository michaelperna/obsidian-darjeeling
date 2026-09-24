#!/usr/bin/env bash
# cmd-docs-check.sh -- lab.sh docs-check implementation
set -euo pipefail

# shellcheck disable=SC2034
cmd_docs_check() {
    local distro="debian13" doc_path="docs/install-server.md" fetch="" run rc
    while [ $# -gt 0 ]; do
        case "$1" in
            --distro) distro="${2:?--distro needs a distro name}"; shift 2 ;;
            --doc) doc_path="${2:?--doc needs a file path}"; shift 2 ;;
            --fetch) fetch="${2:?--fetch needs a directory}"; shift 2 ;;
            --rebuild) export DJ_LAB_REBUILD=1; shift ;;
            --keep) export DJ_LAB_KEEP=1; shift ;;
            -h | --help)
                echo "Usage: lab.sh docs-check [--distro <distro>] [--doc <path>] [--fetch <dir>] [--rebuild] [--keep]"
                return 0
                ;;
            *) die "docs-check: unknown option '$1'" ;;
        esac
    done

    run=$(new_run_id)
    CURRENT_RUN=$run
    say "lab docs-check: run $run ($distro on $doc_path) -> $LAB_HOST:~/$LAB_REMOTE_DIR/docs-check/$run"
    sync_tree "docs-check/$run"

    set +e
    rssh "$(remote_env) bash ~/$LAB_REMOTE_DIR/docs-check/$run/scripts/lab/lib/host-docs-check.sh $run $distro $doc_path"
    rc=$?
    set -e

    CURRENT_RUN=""
    if [ -n "$fetch" ]; then
        mkdir -p "$fetch"
        rsync -a -e "ssh ${SSH_OPTS[*]}" "$LAB_HOST:$LAB_REMOTE_DIR/docs-check/$run/_lab/docs-check/" "$fetch/" || true
        say "lab docs-check: logs and results copied to $fetch"
    fi
    return "$rc"
}

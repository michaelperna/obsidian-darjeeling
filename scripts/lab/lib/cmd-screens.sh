#!/usr/bin/env bash
# cmd-screens.sh -- lab.sh screens implementation
set -euo pipefail

# shellcheck disable=SC2034
cmd_screens() {
    local fetch="" only="" obs_version="1.13.7" run rc
    while [ $# -gt 0 ]; do
        case "$1" in
            --only) only="${2:?--only needs a filter name}"; shift 2 ;;
            --obsidian) obs_version="${2:?--obsidian needs a version string}"; shift 2 ;;
            --fetch) fetch="${2:?--fetch needs a local directory}"; shift 2 ;;
            --rebuild) export DJ_LAB_REBUILD=1; shift ;;
            --keep) export DJ_LAB_KEEP=1; shift ;;
            -h | --help)
                echo "Usage: lab.sh screens [--only NAME] [--obsidian VERSION] [--fetch DIR] [--rebuild] [--keep]"
                return 0
                ;;
            *) die "screens: unknown option '$1'" ;;
        esac
    done

    export DJ_LAB_OBSIDIAN_VERSION="$obs_version"
    if [ -n "$only" ]; then
        export DJ_LAB_ONLY="$only"
    fi

    say "lab screens: building css and plugin"
    (cd "$REPO_ROOT" && npm run build)

    run=$(new_run_id)
    CURRENT_RUN=$run
    say "lab screens: run $run (only='${only:-all}') -> $LAB_HOST:~/$LAB_REMOTE_DIR/screens/$run"
    sync_tree "screens/$run"

    set +e
    rssh "$(remote_env) bash ~/$LAB_REMOTE_DIR/screens/$run/scripts/lab/lib/host-screens.sh $run"
    rc=$?
    set -e

    CURRENT_RUN=""
    if [ -n "$fetch" ]; then
        mkdir -p "$fetch"
        rsync -a -e "ssh ${SSH_OPTS[*]}" "$LAB_HOST:$LAB_REMOTE_DIR/screens/$run/_lab/screens/" "$fetch/" || true
        say "lab screens: artifacts (screenshots, logs) copied to $fetch"
    fi
    return "$rc"
}

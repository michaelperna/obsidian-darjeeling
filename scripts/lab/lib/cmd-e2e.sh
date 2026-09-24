#!/usr/bin/env bash
# cmd-e2e.sh -- lab.sh e2e implementation
set -euo pipefail

# shellcheck disable=SC2034
cmd_e2e() {
    local fetch="" grep_re="" obs_version="1.13.7" run rc
    while [ $# -gt 0 ]; do
        case "$1" in
            --grep) grep_re="${2:?--grep needs a regex pattern}"; shift 2 ;;
            --obsidian) obs_version="${2:?--obsidian needs a version string}"; shift 2 ;;
            --fetch) fetch="${2:?--fetch needs a local directory}"; shift 2 ;;
            --rebuild) export DJ_LAB_REBUILD=1; shift ;;
            --keep) export DJ_LAB_KEEP=1; shift ;;
            -h | --help)
                echo "Usage: lab.sh e2e [--grep RE] [--obsidian VERSION] [--fetch DIR] [--rebuild] [--keep]"
                return 0
                ;;
            *) die "e2e: unknown option '$1'" ;;
        esac
    done

    export DJ_LAB_OBSIDIAN_VERSION="$obs_version"
    if [ -n "$grep_re" ]; then
        export DJ_LAB_GREP="$grep_re"
    fi

    say "lab e2e: building plugin (npm run build)"
    (cd "$REPO_ROOT" && npm run build)

    run=$(new_run_id)
    CURRENT_RUN=$run
    say "lab e2e: run $run (Obsidian $obs_version, grep='${grep_re:-.*}') -> $LAB_HOST:~/$LAB_REMOTE_DIR/e2e/$run"
    sync_tree "e2e/$run"

    set +e
    rssh "$(remote_env) bash ~/$LAB_REMOTE_DIR/e2e/$run/scripts/lab/lib/host-e2e.sh $run"
    rc=$?
    set -e

    CURRENT_RUN=""
    if [ -n "$fetch" ]; then
        mkdir -p "$fetch"
        rsync -a -e "ssh ${SSH_OPTS[*]}" "$LAB_HOST:$LAB_REMOTE_DIR/e2e/$run/_lab/e2e/" "$fetch/" || true
        say "lab e2e: artifacts (screenshots, logs) copied to $fetch"
    fi
    return "$rc"
}

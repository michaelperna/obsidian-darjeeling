#!/usr/bin/env bash
# cmd-release-dry-run.sh -- lab.sh release-dry-run implementation (S4-E1, G-14)
set -euo pipefail

# shellcheck disable=SC2034
cmd_release_dry_run() {
    local version="1.0.0" fetch_dir=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --fetch) fetch_dir="${2:?--fetch needs a directory}"; shift 2 ;;
            -h | --help) usage ;;
            [0-9]*.[0-9]*.[0-9]*) version="$1"; shift ;;
            *) die "release-dry-run: unknown option or version '$1'" ;;
        esac
    done

    local run rc
    run=$(new_run_id)
    CURRENT_RUN=$run
    say "lab release-dry-run: run $run ($version) -> $LAB_HOST:~/$LAB_REMOTE_DIR/release-dry-run/$run"
    sync_tree "release-dry-run/$run"

    set +e
    rssh "$(remote_env) bash ~/$LAB_REMOTE_DIR/release-dry-run/$run/scripts/lab/lib/host-release-dry-run.sh $run $version"
    rc=$?
    set -e

    if [ -n "$fetch_dir" ] && [ "$rc" -eq 0 ]; then
        mkdir -p "$fetch_dir"
        say "fetching release dry-run artifacts to $fetch_dir"
        rsync -a -e "ssh ${SSH_OPTS[*]}" \
            "$LAB_HOST:~/$LAB_REMOTE_DIR/release-dry-run/$run/dist/" "$fetch_dir/"
    fi

    CURRENT_RUN=""
    say "lab release-dry-run: $([ "$rc" -eq 0 ] && echo PASS || echo "FAIL (exit $rc)")"
    return "$rc"
}

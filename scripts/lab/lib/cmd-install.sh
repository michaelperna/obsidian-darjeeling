#!/usr/bin/env bash
# cmd-install.sh -- lab.sh install implementation
set -euo pipefail

# shellcheck disable=SC2034
cmd_install() {
    local distros=() jobs=1 d tarball="" network="loopback" scenario="fresh"
    while [ $# -gt 0 ]; do
        case "$1" in
            all) distros+=("${ALL_DISTROS[@]}"); shift ;;
            debian12 | debian13 | ubuntu2204 | ubuntu2404 | ubuntu2604) distros+=("$1"); shift ;;
            -j) jobs="${2:?-j needs a number}"; shift 2 ;;
            --tarball) tarball="${2:?--tarball needs a path}"; shift 2 ;;
            --network) network="${2:?--network needs a mode}"; shift 2 ;;
            --scenario) scenario="${2:?--scenario needs a scenario list}"; shift 2 ;;
            --extended) export DJ_LAB_EXTENDED=1; shift ;;
            --patch) export DJ_LAB_PATCH="${2:?--patch needs a list, e.g. pipefail}"; shift 2 ;;
            --skip-rerun) export DJ_LAB_SKIP_RERUN=1; shift ;;
            --keep) export DJ_LAB_KEEP=1; shift ;;
            --rebuild) export DJ_LAB_REBUILD=1; shift ;;
            -h | --help) usage ;;
            *) die "install: unknown distro or option '$1' (${ALL_DISTROS[*]}|all)" ;;
        esac
    done
    [ ${#distros[@]} -gt 0 ] || die "install: name at least one distro (${ALL_DISTROS[*]}|all)"
    case "$jobs" in 1 | 2) ;; *) die "install: -j must be 1 or 2 (the host is the owner's live server)" ;; esac

    export DJ_LAB_NETWORK="$network"
    export DJ_LAB_SCENARIO="$scenario"

    local run tmp rc_all=0 pids=() rc
    run=$(new_run_id)
    CURRENT_RUN=$run
    say "lab install: run $run (${distros[*]}) -> $LAB_HOST:~/$LAB_REMOTE_DIR/install/$run"
    sync_tree "install/$run"
    if [ -n "$tarball" ]; then
        [ -f "$tarball" ] || die "tarball not found at $tarball"
        say "syncing release tarball: $tarball"
        local tb_base
        tb_base="$(basename "$tarball")"
        rsync -a -e "ssh ${SSH_OPTS[*]}" "$tarball" "$LAB_HOST:$LAB_REMOTE_DIR/install/$run/$tb_base"
        export DJ_LAB_TARBALL="$tb_base"
    fi
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/dj-lab.XXXXXX")

    local cmd_prefix
    cmd_prefix="$(remote_env) bash ~/$LAB_REMOTE_DIR/install/$run/scripts/lab/lib/host-install.sh $run"
    if [ "$jobs" -eq 1 ]; then
        for d in "${distros[@]}"; do
            say ""
            say "=== $d ==="
            set +e
            rssh "$cmd_prefix $d" 2>&1 | tee "$tmp/$d.log"
            rc=${PIPESTATUS[0]}
            set -e
            echo "$rc" >"$tmp/$d.rc"
        done
    else
        for d in "${distros[@]}"; do
            (
                set +e
                rssh "$cmd_prefix $d" >"$tmp/$d.log" 2>&1
                echo $? >"$tmp/$d.rc"
            ) &
            pids+=($!)
            # Stagger so the two slots are taken in order.
            sleep 2
            if [ ${#pids[@]} -ge "$jobs" ]; then
                wait "${pids[0]}" || true
                pids=("${pids[@]:1}")
            fi
        done
        for p in ${pids[@]+"${pids[@]}"}; do wait "$p" || true; done
        for d in "${distros[@]}"; do
            say ""
            say "=== $d ==="
            cat "$tmp/$d.log"
        done
    fi
    CURRENT_RUN=""

    say ""
    say "=== install summary (run $run) ==="
    for d in "${distros[@]}"; do
        rc=$(cat "$tmp/$d.rc" 2>/dev/null || echo 99)
        [ "$rc" -eq 0 ] || rc_all=1
        say "$(printf '%-11s %s   %s' "$d" "$([ "$rc" -eq 0 ] && echo PASS || echo "FAIL(rc=$rc)")" \
            "$(grep -E '^RESULT' "$tmp/$d.log" | tail -n 1)")"
    done
    say "results: $LAB_HOST:~/$LAB_REMOTE_DIR/install/$run/_lab/<distro>/results.tsv"
    rm -rf "$tmp"
    return "$rc_all"
}

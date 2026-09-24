#!/usr/bin/env bash
# cmd-scan.sh -- lab.sh scan implementation (gitleaks & trufflehog secret scanning)
set -euo pipefail

# shellcheck disable=SC2034
cmd_scan() {
    local keep=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --keep) keep=1; shift ;;
            -h | --help) usage ;;
            *) die "scan: unknown option $1" ;;
        esac
    done

    say "=== [1/4] Running scrub-guard self-test ==="
    "$REPO_ROOT/scripts/ci/scrub-guard.sh" --self-test

    say "=== [2/4] Running scrub-guard on working tree ==="
    "$REPO_ROOT/scripts/ci/scrub-guard.sh"

    local run
    run=$(new_run_id)
    CURRENT_RUN=$run
    say "=== [3/4] Syncing tree to lab host ($LAB_HOST) for container scans ==="
    sync_tree "scan/$run"

    say "=== [4/4] Running gitleaks and trufflehog in containers ==="
    local gl_rc=0 th_rc=0
    set +e
    say "--> Running Gitleaks..."
    rssh "podman run --rm -v ~/$LAB_REMOTE_DIR/scan/$run:/repo:ro docker.io/zricethezav/gitleaks:latest dir /repo --no-banner -v"
    gl_rc=$?

    say "--> Running Trufflehog..."
    rssh "podman run --rm -v ~/$LAB_REMOTE_DIR/scan/$run:/repo:ro docker.io/trufflesecurity/trufflehog:latest filesystem /repo --no-verification --no-update --fail"
    th_rc=$?
    set -e

    if [ "$keep" -eq 0 ]; then
        rssh "rm -rf ~/$LAB_REMOTE_DIR/scan/$run" || true
    fi
    CURRENT_RUN=""

    if [ "$gl_rc" -ne 0 ] || [ "$th_rc" -ne 0 ]; then
        say "lab scan: FAIL (gitleaks: $gl_rc, trufflehog: $th_rc)"
        return 1
    fi

    say "lab scan: PASS (all scanners clean, 0 findings)"
    return 0
}

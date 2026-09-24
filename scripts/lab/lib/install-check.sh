#!/usr/bin/env bash
# Runs INSIDE a disposable systemd container, as root. Refuses to run anywhere else.
# Drives Project Darjeeling v1 installer and verifies all contract requirements.
#
# Result statuses (results.tsv, one per line: STATUS name detail):
#   PASS  contract holds          FAIL  contract broken (makes the run exit 1)
#   BUG   confirmed defect        WARN  suspicious / needs a decision
#   INFO  observation
set -Eeuo pipefail

if [ ! -f /run/.containerenv ] && [ ! -f /.dockerenv ]; then
    echo "install-check.sh: refusing to run outside a container" >&2
    exit 99
fi

REPO=/home/tester/darjeeling
LIB="$REPO/scripts/lab/lib"
OUT=/opt/dj-lab/out
RES="$OUT/results.tsv"
FAILS=0
mkdir -p "$OUT"
: >"$RES"

res() {
    printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$RES"
    printf '%-5s %-38s %s\n' "$1" "$2" "$3"
    if [ "$1" = FAIL ]; then FAILS=$((FAILS + 1)); fi
    return 0
}

absorb() {
    local prefix=${1:-} s n d
    while IFS=$'\t' read -r s n d; do
        [ -n "$s" ] || continue
        case "$s" in
            PASS | FAIL | WARN | INFO | BUG) res "$s" "$prefix$n" "$d" ;;
            *) res INFO "${prefix}probe-output" "$s $n $d" ;;
        esac
    done
}

scenario_enabled() {
    local target="$1"
    [[ ",${DJ_LAB_SCENARIO:-fresh,rerun}," =~ ,${target}, ]]
}

probe() {
    if [ -x /opt/darjeeling/current/venv/bin/python ]; then
        /opt/darjeeling/current/venv/bin/python "$LIB/probe.py" "$@" 2>&1
    elif command -v python3 >/dev/null 2>&1; then
        python3 "$LIB/probe.py" "$@" 2>&1
    else
        echo "FAIL	probe	no python available to run probe.py"
    fi
}

wait_health() { # base-url, seconds
    local i
    for ((i = 0; i < $2; i++)); do
        curl -fsS -m 2 "$1/health" >/dev/null 2>&1 && return 0
        sleep 1
    done
    return 1
}

# Locate release tarball
TARBALL=""
if [ -n "${DJ_LAB_TARBALL:-}" ]; then
    if [ -f "$REPO/$DJ_LAB_TARBALL" ]; then
        TARBALL="$REPO/$DJ_LAB_TARBALL"
    elif [ -f "$DJ_LAB_TARBALL" ]; then
        TARBALL="$DJ_LAB_TARBALL"
    fi
fi
if [ -z "$TARBALL" ]; then
    TARBALL="$(find "$REPO" -maxdepth 2 -name "darjeeling-server-*.tar.gz" | head -n 1)"
fi

# Locate installer script
INSTALLER=""
if [ -f "$REPO/dist/install.sh" ]; then
    INSTALLER="$REPO/dist/install.sh"
elif [ -f "$REPO/server/install.sh" ]; then
    INSTALLER="$REPO/server/install.sh"
fi

# shellcheck disable=SC1091
. /etc/os-release
res INFO os "$PRETTY_NAME $(uname -m), systemd $(systemctl --version | head -n 1 | awk '{print $2}')"
res INFO installer "$INSTALLER (tarball: ${TARBALL:-none})"
res INFO scenario "${DJ_LAB_SCENARIO:-fresh,rerun}"

if [ -z "$INSTALLER" ] || [ ! -f "$INSTALLER" ]; then
    res FAIL installer.found "installer script not found in $REPO"
    exit 1
fi

NETWORK="${DJ_LAB_NETWORK:-loopback}"
ENV_FILE="/etc/darjeeling/darjeeling.env"
TOKEN_FILE="/var/lib/darjeeling/.token"
BASE="http://127.0.0.1:8765"
TOKEN=""

# ================================================================ Scenario: fresh
if scenario_enabled "fresh"; then
    # 1. Dry run clean check (INST-33)
    log_dry="$OUT/dry-run.log"
    set +e
    bash "$INSTALLER" --dry-run --network "$NETWORK" --yes >"$log_dry" 2>&1
    rc_dry=$?
    set -e
    if [ "$rc_dry" -eq 0 ] && [ ! -d /opt/darjeeling ] && [ ! -d /etc/darjeeling ] && [ ! -d /var/lib/darjeeling ]; then
        res PASS dryrun.clean "install.sh --dry-run exited 0 and left /opt, /etc, /var/lib untouched"
    else
        res FAIL dryrun.clean "dry-run rc=$rc_dry or directories created unexpectedly"
    fi

    # 2. Tailscale serve dry-run check (INST-06, INST-13, ADR-16)
    log_dry_ts="$OUT/dry-run-tailscale.log"
    set +e
    bash "$INSTALLER" --dry-run --network tailscale --yes >"$log_dry_ts" 2>&1
    rc_dry_ts=$?
    set -e
    if [ "$rc_dry_ts" -eq 0 ] && grep -q "tailscale serve --bg --https=" "$log_dry_ts"; then
        res PASS tailscale.dryrun "install.sh --network tailscale --dry-run prints exact serve command"
    else
        res FAIL tailscale.dryrun "install.sh --network tailscale --dry-run missing serve command (rc=$rc_dry_ts)"
    fi

    # 3. Fresh install (run 1) with laptop profile
    log_run1="$OUT/install-run1.log"
    t0=$SECONDS
    set +e
    if [ -n "$TARBALL" ]; then
        bash "$INSTALLER" --tarball "$TARBALL" --laptop --network "$NETWORK" --yes >"$log_run1" 2>&1
    else
        bash "$INSTALLER" --laptop --network "$NETWORK" --yes >"$log_run1" 2>&1
    fi
    rc_run1=$?
    set -e
    secs_run1=$((SECONDS - t0))

    if [ "$rc_run1" -eq 0 ]; then
        res PASS install.run1 "exit 0 in ${secs_run1}s"
    else
        res FAIL install.run1 "exit $rc_run1 after ${secs_run1}s (log: $log_run1)"
        cat "$log_run1" >&2
        exit 1
    fi

    # 4. Service active and enabled
    if systemctl is-active --quiet darjeeling.service; then
        res PASS service.active "darjeeling.service is active"
    else
        res FAIL service.active "darjeeling.service is not active: $(systemctl is-active darjeeling.service 2>&1)"
    fi

    if systemctl is-active --quiet darjeeling-tmux.service; then
        res PASS service.tmux "darjeeling-tmux.service is active"
    else
        res FAIL service.tmux "darjeeling-tmux.service is not active"
    fi

    if systemctl is-enabled --quiet darjeeling.service; then
        res PASS service.enabled "darjeeling.service is enabled"
    else
        res FAIL service.enabled "darjeeling.service is not enabled"
    fi

    # 5. Service runs as dedicated non-root user `darjeeling` (INST-04)
    pid=$(systemctl show -p MainPID --value darjeeling.service 2>/dev/null || true)
    svc_user=$(ps -o user= -p "${pid:-0}" 2>/dev/null | tr -d ' ' || true)
    if [ "$svc_user" = "darjeeling" ]; then
        res PASS service.user "runs as dedicated user 'darjeeling' (PID $pid)"
    else
        res FAIL service.user "runs as '${svc_user:-?}' (expected darjeeling, not root)"
    fi

    # 6. Dedicated user has NO sudo privileges (INST-04)
    set +e
    sudo_out=$(sudo -l -U darjeeling 2>&1)
    sudo_rc=$?
    set -e
    if [[ "$sudo_rc" -ne 0 ]] || [[ "$sudo_out" == *"not in the sudoers"* ]] || [[ "$sudo_out" == *"not allowed to run sudo"* ]]; then
        res PASS sudo.norules "darjeeling user has no sudo rules"
    else
        res FAIL sudo.norules "darjeeling user unexpectedly has sudo privileges: $sudo_out"
    fi

    # 7. File layout and permissions (INST-05, INST-20, ADR-18, ADR-19)
    if [ -f "$ENV_FILE" ]; then
        env_stat=$(stat -c '%a %U %G' "$ENV_FILE" 2>/dev/null || stat -f '%p %u %g' "$ENV_FILE")
        if [[ "$env_stat" == "640 root darjeeling" ]]; then
            res PASS perms.env "0640 root:darjeeling on $ENV_FILE"
        else
            res FAIL perms.env "$ENV_FILE has unexpected perms: $env_stat"
        fi
    else
        res FAIL perms.env "$ENV_FILE missing"
    fi

    if [ -f "$TOKEN_FILE" ]; then
        tok_stat=$(stat -c '%a %U %G' "$TOKEN_FILE" 2>/dev/null || stat -f '%p %u %g' "$TOKEN_FILE")
        if [[ "$tok_stat" == "600 darjeeling darjeeling" ]]; then
            res PASS perms.token "0600 darjeeling:darjeeling on $TOKEN_FILE"
        else
            res FAIL perms.token "$TOKEN_FILE has unexpected perms: $tok_stat"
        fi
        TOKEN=$(cat "$TOKEN_FILE")
        if [ "${#TOKEN}" -ge 32 ]; then
            res PASS token.strength "token length ${#TOKEN} >= 32 chars"
        else
            res FAIL token.strength "token length ${#TOKEN} < 32 chars"
        fi
    else
        res FAIL perms.token "$TOKEN_FILE missing"
        TOKEN=""
    fi

    # 8. ADR-25 Root-owned Claude Code managed settings (G-29, G-30)
    MS_FILE="/etc/claude-code/managed-settings.json"
    if [ -f "$MS_FILE" ]; then
        ms_stat=$(stat -c '%a %U %G' "$MS_FILE" 2>/dev/null || stat -f '%p %u %g' "$MS_FILE")
        if [[ "$ms_stat" == "644 root root" ]] && ! runuser -u darjeeling -- test -w "$MS_FILE"; then
            res PASS managed_settings.root_owned "managed-settings is 0644 root:root and not writable by darjeeling"
        else
            res FAIL managed_settings.root_owned "managed-settings permissions/owner unexpected: $ms_stat"
        fi
    else
        res FAIL managed_settings.root_owned "managed-settings file missing at $MS_FILE"
    fi

    # 9. Laptop profile battery udev rules (INST-24, SRV-23)
    UDEV_FILE="/etc/udev/rules.d/99-darjeeling-battery.rules"
    if [ -f "$UDEV_FILE" ] && grep -q "charge_control_end_threshold" "$UDEV_FILE"; then
        res PASS udev.battery_rules "laptop profile battery rules installed"
    else
        res FAIL udev.battery_rules "battery udev rules missing or incomplete"
    fi

    # 10. Health check & Reachability (INST-34)
    if wait_health "$BASE" 20; then
        res PASS health.reachable "$BASE/health answering 200 OK"
    else
        res FAIL health.reachable "$BASE/health not responding after 20s"
    fi

    # 11. Auth & API probing via probe.py (SRV-01, SRV-02, SRV-03, SRV-04)
    if [ -n "$TOKEN" ]; then
        absorb "" < <(probe --base "$BASE" --token "$TOKEN" health auth agents ws ws-reject terminal)
    fi

    # 12. Tmux session persistence across darjeeling.service restart (INST-07, SRV-10)
    runuser -u darjeeling -- env HOME=/var/lib/darjeeling TMUX_TMPDIR=/var/lib/darjeeling/run tmux -L darjeeling -f /opt/darjeeling/current/tmux.conf new-session -d -s test-lab-session "sleep 300" || true
    sleep 1
    sess_before=1
    if runuser -u darjeeling -- env TMUX_TMPDIR=/var/lib/darjeeling/run tmux -L darjeeling has-session -t test-lab-session >/dev/null 2>&1; then
        sess_before=0
    fi

    systemctl restart darjeeling.service
    sleep 2

    sess_after=1
    if runuser -u darjeeling -- env TMUX_TMPDIR=/var/lib/darjeeling/run tmux -L darjeeling has-session -t test-lab-session >/dev/null 2>&1; then
        sess_after=0
    fi

    if [ "$sess_before" -eq 0 ] && [ "$sess_after" -eq 0 ]; then
        res PASS tmux.survives-restart "tmux session test-lab-session survived darjeeling.service restart"
    else
        res FAIL tmux.survives-restart "tmux session did not survive restart (before=$sess_before, after=$sess_after)"
    fi

    # 13. Darjeeling CLI tests
    if darjeeling status >/dev/null 2>&1; then
        res PASS cli.status "darjeeling status exits 0"
    else
        res FAIL cli.status "darjeeling status returned non-zero"
    fi

    if darjeeling doctor >/dev/null 2>&1; then
        res PASS cli.doctor_healthy "darjeeling doctor exits 0 when healthy"
    else
        res FAIL cli.doctor_healthy "darjeeling doctor failed on healthy system"
    fi

    # Stopped service doctor check (named fix)
    systemctl stop darjeeling.service
    set +e
    doc_out=$(darjeeling doctor 2>&1)
    doc_rc=$?
    set -e
    if [ "$doc_rc" -ne 0 ] && [[ "$doc_out" == *"systemctl start darjeeling.service"* ]]; then
        res PASS cli.doctor_stopped "darjeeling doctor exits non-zero with named fix when stopped"
    else
        res FAIL cli.doctor_stopped "darjeeling doctor missing named fix when stopped (rc=$doc_rc): $doc_out"
    fi
    systemctl start darjeeling.service
    wait_health "$BASE" 15

    set +e
    pair_out=$(darjeeling pair 2>&1)
    pair_rc=$?
    set -e
    if [ "$pair_rc" -eq 0 ] && [[ "$pair_out" == *"obsidian://darjeeling?action=pair"* ]]; then
        res PASS cli.pair "darjeeling pair generates deep-link"
    else
        res FAIL cli.pair "darjeeling pair output unexpected (rc=$pair_rc): $pair_out"
    fi

    if darjeeling devices list >/dev/null 2>&1; then
        res PASS cli.devices_list "darjeeling devices list exits 0"
    else
        res FAIL cli.devices_list "darjeeling devices list returned non-zero"
    fi

    if darjeeling config get permission-ceiling >/dev/null 2>&1; then
        res PASS cli.config_get "darjeeling config get exits 0"
    else
        res FAIL cli.config_get "darjeeling config get returned non-zero"
    fi

    # config set deepseek-api-key writes 0600 file (G-51)
    echo "sk-lab-secret-key-12345" | darjeeling config set deepseek-api-key >/dev/null 2>&1
    env_mode=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%p' "$ENV_FILE")
    if [[ "$env_mode" == "600" || "$env_mode" == *600 ]]; then
        res PASS cli.config_secret_perms "config set deepseek-api-key writes 0600 file"
    else
        res FAIL cli.config_secret_perms "config set deepseek-api-key left mode $env_mode"
    fi

    # Fake turn running blocks upgrade without --force (G-45)
    mkdir -p /var/lib/darjeeling/run
    echo "1" > /var/lib/darjeeling/run/active_turns
    set +e
    up_block_out=$(darjeeling upgrade --tarball "${TARBALL:-/tmp/dummy.tar.gz}" 2>&1)
    up_block_rc=$?
    set -e
    rm -f /var/lib/darjeeling/run/active_turns
    if [ "$up_block_rc" -ne 0 ] && [[ "$up_block_out" == *"Cannot upgrade while"* || "$up_block_out" == *"--force"* ]]; then
        res PASS cli.upgrade_blocked_by_turn "upgrade blocked while turn active without --force"
    else
        res FAIL cli.upgrade_blocked_by_turn "upgrade not blocked when turn active (rc=$up_block_rc): $up_block_out"
    fi

    # Corrupt tarball rejected safely and /health stays up
    echo "corrupted-tarball-payload-for-testing" > /tmp/bad-release.tar.gz
    set +e
    up_bad_out=$(darjeeling upgrade --tarball /tmp/bad-release.tar.gz --force 2>&1)
    up_bad_rc=$?
    set -e
    rm -f /tmp/bad-release.tar.gz
    if [ "$up_bad_rc" -ne 0 ] && wait_health "$BASE" 5; then
        res PASS cli.upgrade_corrupt_tarball "corrupted tarball rejected and /health stays up"
    else
        res FAIL cli.upgrade_corrupt_tarball "corrupted tarball check failed (rc=$up_bad_rc): $up_bad_out"
    fi
fi

# ================================================================ Scenario: rerun
if scenario_enabled "rerun"; then
    if [ "${DJ_LAB_SKIP_RERUN:-0}" != "1" ]; then
        env_hash1=$(sha256sum "$ENV_FILE" | awk '{print $1}')
        tok_hash1=$(sha256sum "$TOKEN_FILE" | awk '{print $1}')

        log_run2="$OUT/install-run2.log"
        set +e
        if [ -n "$TARBALL" ]; then
            bash "$INSTALLER" --tarball "$TARBALL" --laptop --network "$NETWORK" --yes >"$log_run2" 2>&1
        else
            bash "$INSTALLER" --laptop --network "$NETWORK" --yes >"$log_run2" 2>&1
        fi
        rc_run2=$?
        set -e

        if [ "$rc_run2" -eq 0 ]; then
            res PASS rerun.exit "rerun exited 0"
        else
            res FAIL rerun.exit "rerun failed with exit $rc_run2"
        fi

        env_hash2=$(sha256sum "$ENV_FILE" | awk '{print $1}')
        tok_hash2=$(sha256sum "$TOKEN_FILE" | awk '{print $1}')

        if [ "$env_hash1" = "$env_hash2" ]; then
            res PASS rerun.env-identical "darjeeling.env is byte-identical after rerun"
        else
            res FAIL rerun.env-identical "darjeeling.env was modified during rerun"
        fi

        if [ "$tok_hash1" = "$tok_hash2" ]; then
            res PASS rerun.token-identical "authentication token is byte-identical after rerun"
        else
            res FAIL rerun.token-identical "authentication token was rotated during rerun"
        fi

        if systemctl is-active --quiet darjeeling.service && wait_health "$BASE" 15; then
            res PASS rerun.service "service remains active and healthy after rerun"
        else
            res FAIL rerun.service "service not healthy after rerun"
        fi
    fi
fi

# ================================================================ Scenario: upgrade-from-4.1.0
if scenario_enabled "upgrade-from-4.1.0"; then
    systemctl stop darjeeling.service darjeeling-tmux.service >/dev/null 2>&1 || true
    # Replay 4.1.0 legacy layout
    bash "$REPO/tests/legacy/make-4.1.0-layout.sh" "" "darjeeling" "/home/darjeeling"

    log_mig="$OUT/upgrade-410.log"
    set +e
    if [ -n "$TARBALL" ]; then
        bash "$INSTALLER" --tarball "$TARBALL" --network "$NETWORK" --yes >"$log_mig" 2>&1
    else
        bash "$INSTALLER" --network "$NETWORK" --yes >"$log_mig" 2>&1
    fi
    rc_mig=$?
    set -e

    if [ "$rc_mig" -eq 0 ] && systemctl is-active --quiet darjeeling.service && wait_health "$BASE" 15; then
        res PASS upgrade_410.active "v1 server active and healthy after legacy 4.1.0 upgrade"
    else
        res FAIL upgrade_410.active "migration install failed (rc=$rc_mig, log: $log_mig)"
    fi

    # Check token migrated
    MIG_TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null || true)
    if [ "$MIG_TOKEN" = "placeholder-legacy-token-for-test-matrix-32chars" ]; then
        res PASS upgrade_410.token_migrated "legacy token migrated into v1"
    else
        res FAIL upgrade_410.token_migrated "token mismatch: $MIG_TOKEN"
    fi

    # Check permission ceiling set to bypassPermissions
    if grep -q "DARJEELING_PERMISSION_CEILING=bypassPermissions" "$ENV_FILE"; then
        res PASS upgrade_410.ceiling "permission ceiling set to bypassPermissions"
    else
        res FAIL upgrade_410.ceiling "permission ceiling not set to bypassPermissions in $ENV_FILE"
    fi

    # Check vault path carried over
    if grep -q "DARJEELING_VAULT_PATH=/home/darjeeling/vault" "$ENV_FILE"; then
        res PASS upgrade_410.vault "legacy vault path preserved"
    else
        res FAIL upgrade_410.vault "vault path missing or wrong in $ENV_FILE"
    fi

    # Check migration notice and backup
    if [ -f "/home/darjeeling/darjeeling-server/MIGRATED_TO_V1.txt" ]; then
        res PASS upgrade_410.notice "migration notice created in legacy directory"
    else
        res FAIL upgrade_410.notice "migration notice missing"
    fi

    if [ -f "/opt/darjeeling/backups/legacy-4.1.0/darjeeling.service" ]; then
        res PASS upgrade_410.backup "legacy unit backed up for rollback"
    else
        res FAIL upgrade_410.backup "legacy unit backup missing"
    fi

    # Verify legacy token authenticates against v1 API
    if curl -fsS -H "Authorization: Bearer placeholder-legacy-token-for-test-matrix-32chars" "$BASE/api/agents" >/dev/null 2>&1; then
        res PASS upgrade_410.auth "legacy token authenticates against v1 /api/agents"
    else
        res FAIL upgrade_410.auth "legacy token failed to authenticate against v1"
    fi
fi

# ================================================================ Scenario: rollback-to-legacy
if scenario_enabled "rollback-to-legacy"; then
    set +e
    rb_out=$(darjeeling rollback --to-legacy 2>&1)
    rb_rc=$?
    set -e
    if [ "$rb_rc" -eq 0 ] && grep -q "/home/darjeeling/darjeeling-server/server.py" /etc/systemd/system/darjeeling.service; then
        res PASS rollback_legacy.unit_restored "darjeeling rollback --to-legacy restored 4.1.0 unit"
    else
        res FAIL rollback_legacy.unit_restored "rollback to legacy failed (rc=$rb_rc): $rb_out"
    fi

    # Wait for legacy server to start and verify token auth
    sleep 2
    if curl -fsS -H "Authorization: Bearer placeholder-legacy-token-for-test-matrix-32chars" "$BASE/health" >/dev/null 2>&1; then
        res PASS rollback_legacy.token_auth "legacy 4.1.0 server running and authenticated"
    else
        res FAIL rollback_legacy.token_auth "legacy server failed to respond or authenticate"
    fi
fi

# ================================================================ Scenario: uninstall
if scenario_enabled "uninstall"; then
    # If currently in rollback state, reinstall v1 so darjeeling CLI / installer is present
    if [ ! -d /opt/darjeeling ]; then
        if [ -n "$TARBALL" ]; then
            bash "$INSTALLER" --tarball "$TARBALL" --network "$NETWORK" --yes >/dev/null 2>&1 || true
        else
            bash "$INSTALLER" --network "$NETWORK" --yes >/dev/null 2>&1 || true
        fi
    fi

    set +e
    darjeeling uninstall --remove-user --yes >"$OUT/uninstall.log" 2>&1 || bash "$INSTALLER" --uninstall --remove-user --yes >>"$OUT/uninstall.log" 2>&1
    set -e

    if ! systemctl is-active --quiet darjeeling.service && ! systemctl is-enabled --quiet darjeeling.service; then
        res PASS uninstall.services_stopped "services stopped and disabled"
    else
        res FAIL uninstall.services_stopped "services still active or enabled after uninstall"
    fi

    if [ ! -d /opt/darjeeling ] && [ ! -f /usr/local/bin/darjeeling ] && [ ! -f /etc/systemd/system/darjeeling.service ]; then
        res PASS uninstall.files_removed "/opt/darjeeling and /usr/local/bin/darjeeling removed"
    else
        res FAIL uninstall.files_removed "darjeeling installation files still exist"
    fi

    if ! id darjeeling >/dev/null 2>&1; then
        res PASS uninstall.user_removed "service user 'darjeeling' removed"
    else
        res FAIL uninstall.user_removed "service user 'darjeeling' still exists"
    fi

    # Home directory kept per G-50
    if [ -d /home/darjeeling ] || [ -d /var/lib/darjeeling ]; then
        res PASS uninstall.home_preserved "home directory preserved per G-50"
    else
        res FAIL uninstall.home_preserved "home directory unexpectedly deleted"
    fi
fi

# ================================================================ summary
journalctl -u darjeeling.service --no-pager -n 100 >"$OUT/journal-final.log" 2>&1 || true
echo "---"
printf 'RESULT %s: %s  (%d fail, %d warn)\n' "${DJ_LAB_DISTRO:-?}" \
    "$([ "$FAILS" -eq 0 ] && echo PASS || echo FAIL)" "$FAILS" \
    "$(grep -c '^WARN' "$RES" || true)"
[ "$FAILS" -eq 0 ]

#!/usr/bin/env bash
# ==============================================================================
# Project Darjeeling: Server Installation & Lifecycle Script
# ==============================================================================
# Idempotent host installation script for Debian/Ubuntu LTS daemons.
# Manages systemd services, Python virtual environments, auth tokens,
# and overlay network bindings.
# ==============================================================================

set -euo pipefail

# DJ_VERSION and TARBALL_SHA256 are stamped by scripts/release/stamp-install.sh.
# Left empty, the version is read from the VERSION file of the payload being
# installed (tarball, or the directory this script lives in).
DJ_VERSION=""
TARBALL_SHA256=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
STATE_ROOT="/var/lib/darjeeling"
INSTALL_LOG="/var/log/darjeeling-install.log"
if ! { mkdir -p "$(dirname "$INSTALL_LOG")" && : >> "$INSTALL_LOG"; } 2>/dev/null; then
    INSTALL_LOG="${TMPDIR:-/tmp}/darjeeling-install.log"
fi

# shellcheck disable=SC2329  # invoked via the ERR trap
catch_error() {
    local exit_code="$1"
    local line_no="$2"
    echo "==========================================================" >&2
    echo "ERROR: Installation failed at line ${line_no} (exit code ${exit_code})" >&2
    echo "Installer log is located at: ${INSTALL_LOG}" >&2
    echo "==========================================================" >&2
    exit "$exit_code"
}
trap 'catch_error $? $LINENO' ERR

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$INSTALL_LOG" >&2
}

warn() {
    echo "[WARN] $*" | tee -a "$INSTALL_LOG" >&2
}

err() {
    echo "[ERROR] $*" | tee -a "$INSTALL_LOG" >&2
}

# Resolve DJ_VERSION when it was not stamped or passed with --version.
resolve_version() {
    if [[ -z "$DJ_VERSION" && -n "$TARBALL_PATH" && -f "$TARBALL_PATH" ]]; then
        DJ_VERSION="$(tar -xzOf "$TARBALL_PATH" VERSION 2>/dev/null | head -n1 | tr -d '[:space:]' || true)"
    fi
    if [[ -z "$DJ_VERSION" && -f "${SCRIPT_DIR}/VERSION" ]]; then
        DJ_VERSION="$(head -n1 "${SCRIPT_DIR}/VERSION" | tr -d '[:space:]')"
    fi
    if [[ -z "$DJ_VERSION" && -f "${SCRIPT_DIR}/pyproject.toml" ]]; then
        DJ_VERSION="$(sed -n 's/^version *= *"\([^"]*\)".*/\1/p' "${SCRIPT_DIR}/pyproject.toml" | head -n1)"
    fi
    if [[ -z "$DJ_VERSION" ]]; then
        err "Cannot determine the Darjeeling version (no VERSION file). Pass --version <ver> or use a release tarball."
        exit 1
    fi
    if [[ ! "$DJ_VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]*$ ]]; then
        err "Refusing suspicious version string: ${DJ_VERSION}"
        exit 1
    fi
}

# Set KEY=VALUE in an env file in place (keeps line position, owner and mode).
# Values are passed through the environment, so no sed escaping is needed.
set_env_var() {
    local key="$1" val="$2" file="$3"
    local tmp
    tmp="$(mktemp)"
    K="$key" V="$val" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
        index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
        { print }
        END { if (!done) print k "=" v }' "$file" > "$tmp"
    cat "$tmp" > "$file"
    rm -f "$tmp"
}

# Remove every KEY=... line from an env file in place.
unset_env_var() {
    local key="$1" file="$2"
    local tmp
    tmp="$(mktemp)"
    K="$key" awk 'BEGIN { k = ENVIRON["K"] } index($0, k "=") != 1 { print }' "$file" > "$tmp"
    cat "$tmp" > "$file"
    rm -f "$tmp"
}

get_env_var() {
    local key="$1" file="$2"
    [[ -f "$file" ]] || return 0
    K="$key" awk 'BEGIN { k = ENVIRON["K"] } index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { gsub(/^["\x27]|["\x27]$/, "", v); print v }' "$file"
}

# Yes/no question on the terminal. With --yes, or without a terminal, the
# default answer is used. Usage: prompt_yes_no "Question?" y|n
prompt_yes_no() {
    local question="$1" default="$2" answer=""
    if [[ "$NON_INTERACTIVE" == "true" ]] || ! { : < /dev/tty; } 2>/dev/null; then
        [[ "$default" == "y" ]]
        return
    fi
    local hint="[y/N]"
    [[ "$default" == "y" ]] && hint="[Y/n]"
    printf '%s %s ' "$question" "$hint" > /dev/tty
    read -r answer < /dev/tty || answer=""
    answer="${answer:-$default}"
    [[ "$answer" == [Yy]* ]]
}

# Bare address of a DARJEELING_BIND / DARJEELING_HOST value ("address:" and
# brackets removed). interface:/loopback values are returned unchanged.
bind_spec_address() {
    local v="$1"
    v="${v#address:}"
    v="${v#[}"
    v="${v%]}"
    printf '%s\n' "$v"
}

# True for the binds 1.0.4 refuses at startup that 1.0.3 accepted:
# unspecified (0.0.0.0, ::) and link-local addresses.
is_wildcard_bind() {
    local a
    a="$(bind_spec_address "$1")"
    case "$a" in
        0.0.0.0|::|::0|0:0:0:0:0:0:0:0|::ffff:0.0.0.0|169.254.*|[Ff][Ee]80:*) return 0 ;;
    esac
    return 1
}

# IPv4 addresses on overlay interfaces (Tailscale, NordVPN Meshnet), one per line.
list_overlay_addresses() {
    local iface addr
    for iface in tailscale0 nordlynx; do
        addr="$(ip -4 addr show dev "$iface" 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -n1 || true)"
        if [[ -n "$addr" ]]; then
            printf '%s\n' "$addr"
        fi
    done
}

# Upgrade guard for 1.0.3 hosts bound to 0.0.0.0 / :: (refused by 1.0.4 at
# startup, which would leave the host unreachable). Runs before anything is
# changed. Sets PENDING_BIND_VALUE when the env file must be rewritten, or
# stops with instructions. Choice order: --bind, --network <mode>, the single
# overlay address (automatic with --yes, asked otherwise).
PENDING_BIND_VALUE=""
PENDING_BIND_FROM=""
check_existing_bind() {
    local env_file="$1"
    [[ -r "$env_file" ]] || return 0
    local key="DARJEELING_BIND" val
    val="$(get_env_var DARJEELING_BIND "$env_file")"
    if [[ -z "$val" ]]; then
        key="DARJEELING_HOST"
        val="$(get_env_var DARJEELING_HOST "$env_file")"
    fi
    if [[ -z "$val" ]] || ! is_wildcard_bind "$val"; then
        return 0
    fi
    warn "${env_file} has ${key}=${val}. Darjeeling 1.0.4 refuses to listen on every interface and would not start."

    local choice="" overlays="" count=0
    if [[ -n "$BIND_IP" ]]; then
        choice="$BIND_IP"
    elif [[ "$NETWORK_MODE" != "auto" ]]; then
        choice="$(detect_network "$NETWORK_MODE")"
    else
        overlays="$(list_overlay_addresses)"
        count="$(printf '%s' "$overlays" | grep -c . || true)"
        if [[ "$count" -eq 1 ]]; then
            if prompt_yes_no "Bind to the overlay address ${overlays} instead?" y; then
                choice="$overlays"
            fi
        fi
    fi

    if [[ -n "$choice" ]] && is_wildcard_bind "$choice"; then
        err "--bind ${choice} is refused by 1.0.4 as well."
        choice=""
    fi
    if [[ -z "$choice" ]]; then
        err "Choose the address the server should listen on, then re-run the installer:"
        {
            if [[ -n "$overlays" ]]; then
                echo "  Overlay addresses on this host:"
                printf '%s\n' "$overlays" | sed 's/^/    /'
            fi
            echo "  --bind <ip>            listen on one address (e.g. your Tailscale/Meshnet IP)"
            echo "  --network meshnet      NordVPN Meshnet (nordlynx address)"
            echo "  --network wireguard    WireGuard (wg0 address)"
            echo "  --network lan          this host's LAN address"
            echo "  --network loopback     127.0.0.1 only (Tailscale Serve or SSH forwarding)"
            echo "  --network tailscale    127.0.0.1 behind Tailscale Serve"
            echo "Or edit ${env_file} yourself: DARJEELING_BIND=interface:tailscale0,"
            echo "DARJEELING_BIND=address:<ip> or DARJEELING_BIND=loopback."
        } >&2
        exit 4
    fi
    PENDING_BIND_VALUE="$choice"
    PENDING_BIND_FROM="${key}=${val}"
}

# Apply the decision made by check_existing_bind to the env file.
apply_pending_bind() {
    local env_file="$1"
    [[ -n "$PENDING_BIND_VALUE" ]] || return 0
    set_env_var DARJEELING_BIND "$PENDING_BIND_VALUE" "$env_file"
    local host
    host="$(get_env_var DARJEELING_HOST "$env_file")"
    if [[ -n "$host" ]] && is_wildcard_bind "$host"; then
        unset_env_var DARJEELING_HOST "$env_file"
    fi
    log "Rewrote ${PENDING_BIND_FROM} to DARJEELING_BIND=${PENDING_BIND_VALUE} in ${env_file}."
}

# Address to report and health-check for an existing env file's bind.
env_bind_ip() {
    local env_file="$1" val
    val="$(get_env_var DARJEELING_BIND "$env_file")"
    [[ -n "$val" ]] || val="$(get_env_var DARJEELING_HOST "$env_file")"
    case "$val" in
        ""|loopback|localhost) echo "127.0.0.1" ;;
        interface:*)
            local ifip
            ifip="$(ip -4 addr show dev "${val#interface:}" 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -n1 || true)"
            echo "${ifip:-127.0.0.1}"
            ;;
        *) bind_spec_address "$val" ;;
    esac
}

# Hosts migrated from 4.1.0 by the 1.0.3 (or earlier) installer had their
# permission ceiling forced to bypassPermissions. The value is kept (it may be
# the user's choice by now), but it is flagged until someone confirms it.
# Usage: review_forced_ceiling <env_file> <marker_file>
review_forced_ceiling() {
    local env_file="$1" marker="$2"
    {
        echo ""
        echo "=========================================================="
        echo "WARNING: permission ceiling is bypassPermissions"
        echo "=========================================================="
        echo "This host was migrated from Darjeeling 4.1.0 by the 1.0.3 (or older)"
        echo "installer, which set the permission ceiling to bypassPermissions"
        echo "without asking. At that ceiling any paired client can run tools and"
        echo "shell commands on this host without confirmation."
        echo ""
        echo "The installer keeps your current value. To lower it:"
        echo "  sudo darjeeling config set permission-ceiling acceptEdits"
        echo "  sudo systemctl restart darjeeling.service"
        echo "=========================================================="
    } >&2
    if [[ "$NON_INTERACTIVE" == "true" ]] || ! { : < /dev/tty; } 2>/dev/null; then
        warn "Keeping bypassPermissions (--yes). Re-run the installer interactively once to confirm and silence this warning."
        return 0
    fi
    if prompt_yes_no "Keep bypassPermissions?" y; then
        log "Keeping permission ceiling bypassPermissions (confirmed)."
    else
        set_env_var DARJEELING_PERMISSION_CEILING acceptEdits "$env_file"
        log "Lowered DARJEELING_PERMISSION_CEILING to acceptEdits."
    fi
    echo "ceiling-reviewed: yes" >> "$marker"
}

usage() {
    cat << 'EOF'
Usage: sudo bash install.sh [options]

Options:
  --yes, -y              Accept defaults non-interactively
  --dry-run              Print the execution plan and exit without modifying the system
  --tarball <path>       Install from a local release tarball (.tar.gz)
  --network <mode>       Network mode: auto (default), tailscale, meshnet, wireguard, lan, loopback
  --bind <ip>            Explicit IP address to bind server to
  --port <port>          TCP port (default: 8765)
  --user <user>          Service user (default: darjeeling)
  --laptop               Configure logind & udev battery rules for laptop profile
  --no-laptop            Disable laptop profile
  --claude <mode>        Claude Code install mode: native (default), apt, skip
  --with-agy             Install Google Antigravity SDK
  --vault-sync <mode>    Vault sync mode: none (default), obsidian-sync
  --install-nordvpn      Install NordVPN client
  --version <ver>        Override Darjeeling version
  --uninstall            Uninstall Darjeeling services and installer-created files
                         (releases, current symlink, units, CLI link); never
                         deletes anything else under /opt/darjeeling
  --purge                Used with --uninstall to remove /etc and /var/lib directories
  --delete-vault         Used with --uninstall to delete vault directory
  --remove-user          Used with --uninstall to delete service user account
  --help, -h             Show this help message
EOF
}

# Defaults
ACTION="install"
NON_INTERACTIVE=false
DRY_RUN=false
TARBALL_PATH=""
NETWORK_MODE="auto"
BIND_IP=""
PORT=8765
SERVICE_USER="darjeeling"
LAPTOP_PROFILE=false
CLAUDE_MODE="native"
WITH_AGY=false
VAULT_SYNC="${DJ_VAULT_SYNC:-none}"
INSTALL_NORDVPN=false
UNINSTALL_PURGE=false
UNINSTALL_DELETE_VAULT=false
UNINSTALL_REMOVE_USER=false

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --yes|-y)
                NON_INTERACTIVE=true
                shift
                ;;
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --tarball)
                TARBALL_PATH="$2"
                shift 2
                ;;
            --network)
                NETWORK_MODE="$2"
                shift 2
                ;;
            --bind)
                BIND_IP="$2"
                shift 2
                ;;
            --port)
                PORT="$2"
                shift 2
                ;;
            --user)
                SERVICE_USER="$2"
                shift 2
                ;;
            --laptop)
                LAPTOP_PROFILE=true
                shift
                ;;
            --no-laptop)
                LAPTOP_PROFILE=false
                shift
                ;;
            --claude)
                CLAUDE_MODE="$2"
                shift 2
                ;;
            --with-agy)
                WITH_AGY=true
                shift
                ;;
            --vault-sync)
                VAULT_SYNC="$2"
                shift 2
                ;;
            --install-nordvpn)
                INSTALL_NORDVPN=true
                shift
                ;;
            --version)
                DJ_VERSION="$2"
                shift 2
                ;;
            --uninstall)
                ACTION="uninstall"
                shift
                ;;
            --purge)
                UNINSTALL_PURGE=true
                shift
                ;;
            --delete-vault)
                UNINSTALL_DELETE_VAULT=true
                shift
                ;;
            --remove-user)
                UNINSTALL_REMOVE_USER=true
                shift
                ;;
            --help|-h)
                usage
                exit 0
                ;;
            *)
                err "Unknown option: $1"
                usage >&2
                exit 1
                ;;
        esac
    done
}

run_uninstall() {
    if [[ "$EUID" -ne 0 ]]; then
        err "Uninstall must be run as root (use: sudo bash install.sh --uninstall)"
        exit 1
    fi
    log "Uninstalling Project Darjeeling..."
    systemctl stop darjeeling.service darjeeling-tmux.service darjeeling-vault-sync.service 2>/dev/null || true
    systemctl disable darjeeling.service darjeeling-tmux.service darjeeling-vault-sync.service 2>/dev/null || true

    rm -f /etc/systemd/system/darjeeling.service /etc/systemd/system/darjeeling-tmux.service /etc/systemd/system/darjeeling-vault-sync.service
    rm -rf /etc/systemd/system/darjeeling.service.d
    systemctl daemon-reload 2>/dev/null || true

    rm -f /usr/local/bin/darjeeling
    # Only remove what the installer created under /opt/darjeeling. Anything
    # else there (for example a git checkout) is left untouched.
    rm -f /opt/darjeeling/current /opt/darjeeling/previous
    rm -rf /opt/darjeeling/releases /opt/darjeeling/backups
    rmdir /opt/darjeeling 2>/dev/null || true
    if [[ -d /opt/darjeeling ]]; then
        log "Left /opt/darjeeling in place because it contains files the installer did not create."
    fi
    rm -f /etc/udev/rules.d/99-darjeeling-battery.rules 2>/dev/null || true
    rm -f /etc/systemd/logind.conf.d/darjeeling.conf 2>/dev/null || true
    rm -f /etc/claude-code/managed-settings.json 2>/dev/null || true

    if [[ "$UNINSTALL_PURGE" == "true" ]]; then
        rm -rf /etc/darjeeling /var/lib/darjeeling /var/lib/darjeeling-sync
    elif [[ "$UNINSTALL_DELETE_VAULT" == "true" ]]; then
        rm -rf /var/lib/darjeeling/vault
    fi

    if [[ "$UNINSTALL_REMOVE_USER" == "true" ]]; then
        log "Removing system users '${SERVICE_USER}' and 'darjeeling-sync' (home directories are left in place)..."
        userdel "$SERVICE_USER" 2>/dev/null || true
        userdel "darjeeling-sync" 2>/dev/null || true
    fi

    log "Project Darjeeling uninstall complete."
    exit 0
}

run_preflight() {
    log "Running preflight checks..."

    # 1. Root check
    if [[ "$EUID" -ne 0 ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            warn "Running dry run as non-root user."
        else
            err "install.sh must be run as root (use: sudo bash install.sh)"
            exit 1
        fi
    fi

    # 2. OS distribution check
    if [[ ! -f /etc/os-release ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            warn "Cannot determine operating system (/etc/os-release missing; dry run continuing)."
        else
            err "Cannot determine operating system (/etc/os-release missing)"
            exit 1
        fi
    else
        # shellcheck disable=SC1091
        source /etc/os-release
        local os_id="${ID:-}"
        local os_like="${ID_LIKE:-}"
        if [[ "$os_id" != "debian" && "$os_id" != "ubuntu" && "$os_id" != "raspbian" && "$os_like" != *"debian"* && "$os_like" != *"ubuntu"* ]]; then
            err "Unsupported OS: ${os_id}. Project Darjeeling server requires Debian or Ubuntu."
            exit 1
        fi
    fi

    # 3. Architecture check (refuse armv7l)
    local arch
    arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64|aarch64|arm64)
            ;;
        armv7l|armv6l|armhf|i386|i686)
            err "Unsupported CPU architecture: ${arch}. Project Darjeeling requires 64-bit Linux (x86_64 or aarch64)."
            exit 1
            ;;
        *)
            err "Unsupported architecture: ${arch}"
            exit 1
            ;;
    esac

    # 4. systemd check
    if [[ ! -d /run/systemd/system ]] && ! pidof systemd >/dev/null 2>&1; then
        if [[ "$DRY_RUN" == "true" ]]; then
            warn "systemd not detected as PID 1 (dry run continuing)."
        else
            err "systemd is required as PID 1 to manage Project Darjeeling background daemons."
            exit 1
        fi
    fi

    # 5. RAM check for default concurrency
    local mem_total=0
    if [[ -f /proc/meminfo ]]; then
        mem_total="$(grep -i MemTotal /proc/meminfo | awk '{print $2}')"
    fi
    local max_concurrent_turns=2
    if [[ "$mem_total" -gt 0 && "$mem_total" -lt 3800000 ]]; then
        log "System has < 4 GB RAM (${mem_total} kB); capping concurrency to 1 turn."
        max_concurrent_turns=1
    fi

    # 6. Disk space check (need at least 500 MB free on /)
    local free_kb
    free_kb="$(df -k / 2>/dev/null | awk 'NR==2 {print $4}' || echo 1000000)"
    if [[ "$free_kb" -lt 500000 ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            warn "Low disk space (< 500MB) detected (dry run continuing)."
        else
            err "Insufficient disk space: at least 500 MB free space required on root filesystem."
            exit 1
        fi
    fi

    # 7. Python check (Python >= 3.10 required)
    if command -v python3 >/dev/null 2>&1; then
        if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
            if [[ "$DRY_RUN" == "true" ]]; then
                warn "Installed python3 is older than 3.10 (dry run continuing)."
            else
                err "Installed python3 is older than 3.10. Project Darjeeling requires Python >= 3.10."
                exit 1
            fi
        fi
    fi

    # 8. Check if port is already listening by another process
    if command -v ss >/dev/null 2>&1; then
        if ss -tulpn | grep -q ":${PORT} "; then
            warn "Port ${PORT} is already in use. Existing service may be restarted or port conflict may occur."
        fi
    fi

    echo "$max_concurrent_turns"
}

detect_network() {
    local mode="$1"
    local detected_ip=""

    if [[ -n "$BIND_IP" ]]; then
        echo "$BIND_IP"
        return 0
    fi

    case "$mode" in
        loopback)
            echo "127.0.0.1"
            return 0
            ;;
        tailscale)
            # In Tailscale Serve mode, server binds loopback
            echo "127.0.0.1"
            return 0
            ;;
        meshnet)
            detected_ip="$(ip -4 addr show dev nordlynx 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -n1 || true)"
            if [[ -z "$detected_ip" ]]; then
                err "NordVPN Meshnet interface (nordlynx) not found or has no IPv4 address."
                exit 1
            fi
            echo "$detected_ip"
            return 0
            ;;
        wireguard)
            detected_ip="$(ip -4 addr show dev wg0 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -n1 || true)"
            if [[ -z "$detected_ip" ]]; then
                err "WireGuard interface (wg0) not found or has no IPv4 address."
                exit 1
            fi
            echo "$detected_ip"
            return 0
            ;;
        lan)
            detected_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP '(?<=src\s)\d+(\.\d+){3}' | head -n1 || true)"
            if [[ -z "$detected_ip" ]]; then
                detected_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
            fi
            if [[ -z "$detected_ip" ]]; then
                echo "127.0.0.1"
                return 0
            fi
            echo "$detected_ip"
            return 0
            ;;
        auto)
            # Priority order: tailscale0 -> nordlynx -> wg0
            detected_ip="$(ip -4 addr show dev tailscale0 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -n1 || true)"
            if [[ -n "$detected_ip" ]]; then
                log "Detected Tailscale overlay on tailscale0: $detected_ip"
                echo "127.0.0.1"
                return 0
            fi
            detected_ip="$(ip -4 addr show dev nordlynx 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -n1 || true)"
            if [[ -n "$detected_ip" ]]; then
                log "Detected NordVPN Meshnet overlay on nordlynx: $detected_ip"
                echo "$detected_ip"
                return 0
            fi
            detected_ip="$(ip -4 addr show dev wg0 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -n1 || true)"
            if [[ -n "$detected_ip" ]]; then
                log "Detected WireGuard overlay on wg0: $detected_ip"
                echo "$detected_ip"
                return 0
            fi

            # If auto failed to find any overlay network, exit 3 with instructions
            err "No overlay network (Tailscale, NordVPN Meshnet, Wireguard) detected on this host."
            echo "" >&2
            echo "Project Darjeeling requires a secure overlay network or an explicit bind address." >&2
            echo "Options to resolve:" >&2
            echo "  1. Connect to Tailscale, NordVPN Meshnet, or WireGuard, then re-run install.sh" >&2
            echo "  2. Run with --network lan to bind to your local area network" >&2
            echo "  3. Run with --network loopback to bind to 127.0.0.1 (local access or SSH port forwarding)" >&2
            echo "  4. Run with --bind <IP> to specify an explicit IP address" >&2
            exit 3
            ;;
        *)
            err "Unknown network mode: $mode"
            exit 1
            ;;
    esac
}

main() {
    parse_args "$@"

    if [[ "$ACTION" == "uninstall" ]]; then
        run_uninstall
    fi

    resolve_version

    local max_concurrent_turns
    max_concurrent_turns="$(run_preflight)"

    # Upgrading a host bound to 0.0.0.0 / ::? Decide the new bind before
    # changing anything (exits with instructions when there is no safe choice).
    local existing_env="/etc/darjeeling/darjeeling.env"
    check_existing_bind "$existing_env"

    local bind_ip
    if [[ -r "$existing_env" && -z "$BIND_IP" && "$NETWORK_MODE" == "auto" ]]; then
        # Re-run / upgrade: the existing env file's bind is kept, so report
        # and health-check that instead of requiring a detectable overlay.
        bind_ip="${PENDING_BIND_VALUE:-$(env_bind_ip "$existing_env")}"
    else
        bind_ip="$(detect_network "$NETWORK_MODE")"
    fi

    local ts_serve_port=443
    if command -v ss >/dev/null 2>&1 && ss -tulpn 2>/dev/null | grep -q ":443 "; then
        ts_serve_port=8443
    fi
    local ts_serve_cmd="tailscale serve --bg --https=${ts_serve_port} http://127.0.0.1:${PORT}"

    log "Target Darjeeling version: ${DJ_VERSION}"
    log "Service user: ${SERVICE_USER}"
    log "Network bind IP: ${bind_ip}:${PORT}"
    log "Max concurrent turns: ${max_concurrent_turns}"
    if [[ "$NON_INTERACTIVE" == "true" ]]; then
        log "Non-interactive mode requested (--yes)."
    fi

    if [[ "$DRY_RUN" == "true" ]]; then
        log "DRY RUN requested. Printing plan and exiting without making changes."
        cat << EOF

=== Execution Plan (DRY RUN) ===
1. Preflight: Passed (OS, 64-bit CPU, systemd, disk space, python >= 3.10)
2. User: Ensure system user '${SERVICE_USER}' exists (/var/lib/darjeeling)
3. Dependencies: apt install ca-certificates curl tmux python3 python3-venv iproute2
4. Directory Layout:
   - /opt/darjeeling/releases/${DJ_VERSION}
   - /opt/darjeeling/current -> releases/${DJ_VERSION}
   - /etc/darjeeling/darjeeling.env (0640 root:${SERVICE_USER})
   - /var/lib/darjeeling (0700 ${SERVICE_USER}:${SERVICE_USER})
   - /var/lib/darjeeling/vault
   - /usr/local/bin/darjeeling -> /opt/darjeeling/current/bin/darjeeling
5. Systemd Units:
   - /etc/systemd/system/darjeeling-tmux.service
   - /etc/systemd/system/darjeeling.service
6. Network Bind: ${bind_ip}:${PORT}
EOF
        if [[ "$NETWORK_MODE" == "tailscale" ]]; then
            echo "   Tailscale Serve command: ${ts_serve_cmd}"
        fi
        cat << EOF
7. Health Check: poll http://127.0.0.1:${PORT}/health
EOF
        exit 0
    fi

    # Check for legacy 4.1.0 layout
    local is_legacy_migration=false
    local legacy_cfg=""
    local legacy_token=""
    local legacy_vault=""
    local legacy_deepseek=""
    local legacy_ceiling=""
    local legacy_marker=""
    local ceiling_forced_by_old=false

    for cand in "/home/${SERVICE_USER}/darjeeling-server/config.env" /home/*/darjeeling-server/config.env; do
        if [[ -f "$cand" ]]; then
            legacy_cfg="$cand"
            break
        fi
    done

    if [[ -n "$legacy_cfg" ]]; then
        is_legacy_migration=true
        log "Detected legacy Darjeeling 4.1.0 layout at ${legacy_cfg}."
        local legacy_dir
        legacy_dir="$(dirname "$legacy_cfg")"
        local legacy_user
        legacy_user="$(stat -c '%U' "$legacy_cfg" 2>/dev/null || stat -f '%u' "$legacy_cfg" 2>/dev/null || echo "$SERVICE_USER")"
        if [[ -n "$legacy_user" && "$legacy_user" != "root" ]]; then
            SERVICE_USER="$legacy_user"
        fi

        legacy_token="$(grep -E '^DARJEELING_TOKEN=' "$legacy_cfg" | cut -d'=' -f2- | tr -d "'\"" || true)"
        legacy_vault="$(grep -E '^DARJEELING_VAULT=' "$legacy_cfg" | cut -d'=' -f2- | tr -d "'\"" || true)"
        legacy_deepseek="$(grep -E '^DEEPSEEK_API_KEY=' "$legacy_cfg" | cut -d'=' -f2- | tr -d "'\"" || true)"
        legacy_ceiling="$(grep -E '^DARJEELING_PERMISSION_CEILING=' "$legacy_cfg" | tail -n1 | cut -d'=' -f2- | tr -d "'\"" || true)"

        if command -v sudo >/dev/null 2>&1; then
            if sudo -l -U "$SERVICE_USER" 2>/dev/null | grep -q "NOPASSWD"; then
                warn "User '${SERVICE_USER}' has NOPASSWD sudo privileges. Hardening recommends removing sudo rules."
            fi
        fi

        # Back up the 4.1.0 unit once; on re-runs the installed unit is ours.
        if [[ -f /etc/systemd/system/darjeeling.service && ! -f /opt/darjeeling/backups/legacy-4.1.0/darjeeling.service ]]; then
            mkdir -p "/opt/darjeeling/backups/legacy-4.1.0"
            cp -p /etc/systemd/system/darjeeling.service "/opt/darjeeling/backups/legacy-4.1.0/darjeeling.service"
            log "Backed up legacy unit to /opt/darjeeling/backups/legacy-4.1.0/darjeeling.service"
        fi

        mkdir -p /etc/systemd/system/darjeeling.service.d
        cat << EOF > /etc/systemd/system/darjeeling.service.d/legacy-env.conf
[Service]
Environment="PATH=/usr/local/bin:/usr/bin:/bin:/home/${SERVICE_USER}/.bun/bin:/home/${SERVICE_USER}/.npm-global/bin:/home/${SERVICE_USER}/.local/bin"
EOF

        # The marker 1.0.3 and earlier left has no "ceiling-policy" line; those
        # installers forced the ceiling to bypassPermissions. Keep that fact
        # in the marker so later runs still know about it.
        legacy_marker="${legacy_dir}/MIGRATED_TO_V1.txt"
        if [[ -f "$legacy_marker" ]]; then
            if grep -q '^ceiling-forced-by-1.0.3: yes' "$legacy_marker"; then
                ceiling_forced_by_old=true
            elif ! grep -q '^ceiling-policy: preserve' "$legacy_marker"; then
                ceiling_forced_by_old=true
                printf '%s\n' "ceiling-forced-by-1.0.3: yes" "ceiling-policy: preserve" >> "$legacy_marker"
            fi
            if grep -q '^ceiling-reviewed: yes' "$legacy_marker"; then
                ceiling_forced_by_old=false
            fi
        else
            cat << EOF > "$legacy_marker"
This Darjeeling 4.1.0 installation has been migrated to Project Darjeeling ${DJ_VERSION}.
Managed configuration is now located at /etc/darjeeling/darjeeling.env
Server daemon is managed under /opt/darjeeling/current
ceiling-policy: preserve
EOF
        fi
    fi

    # 1. Create or verify dedicated service user
    if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
        log "Creating dedicated service user: ${SERVICE_USER}"
        useradd -r -s /bin/bash -d /var/lib/darjeeling -m "$SERVICE_USER"
    else
        log "Service user '${SERVICE_USER}' already exists."
        usermod -s /bin/bash "$SERVICE_USER" 2>/dev/null || true
    fi

    # The service user's real home directory (used for HOME in the units and
    # for the per-user Claude Code install).
    local user_home
    user_home="$(getent passwd "$SERVICE_USER" 2>/dev/null | cut -d: -f6 || echo "")"
    if [[ -z "$user_home" || ! -d "$user_home" ]]; then
        user_home="$STATE_ROOT"
    fi

    # Check if service user has sudo permissions
    if command -v sudo >/dev/null 2>&1; then
        if sudo -l -U "$SERVICE_USER" 2>/dev/null | grep -q "(ALL"; then
            warn "User '${SERVICE_USER}' currently has sudo permissions. Hardening recommends removing sudo rules."
        fi
    fi

    # 2. Install apt prerequisites
    log "Installing apt dependencies (DPkg::Lock::Timeout=600)..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq -o DPkg::Lock::Timeout=600
    apt-get install -y --no-install-recommends -o DPkg::Lock::Timeout=600 \
        ca-certificates curl tmux python3 python3-venv iproute2

    # 3. Create directory tree
    log "Setting up directory structure under /opt/darjeeling and /var/lib/darjeeling..."
    local release_dir="/opt/darjeeling/releases/${DJ_VERSION}"
    # The release that is live now: kept untouched as the rollback target.
    local prev_release=""
    prev_release="$(readlink -f /opt/darjeeling/current 2>/dev/null || true)"
    if [[ -d "$release_dir" ]]; then
        if [[ -n "$prev_release" && "$(readlink -f "$release_dir")" == "$prev_release" ]]; then
            log "Reinstalling ${DJ_VERSION} in place (it is the current release)."
            prev_release=""
        else
            log "Replacing stale ${release_dir} (not the current release)."
            rm -rf "$release_dir"
        fi
    fi
    mkdir -p "$release_dir"
    mkdir -p "/etc/darjeeling"
    mkdir -p "/var/lib/darjeeling/run"
    mkdir -p "/var/lib/darjeeling/vault"

    chown -R "$SERVICE_USER:$SERVICE_USER" "/var/lib/darjeeling"
    chmod 0700 "/var/lib/darjeeling"
    chmod 0700 "/var/lib/darjeeling/run"

    if [[ "$VAULT_SYNC" == "obsidian-sync" ]]; then
        log "Configuring vault synchronization for obsidian-sync..."
        if ! id -u "darjeeling-sync" >/dev/null 2>&1; then
            log "Creating dedicated sync user 'darjeeling-sync'..."
            useradd -r -s /usr/sbin/nologin -g "$SERVICE_USER" -d /var/lib/darjeeling-sync -m darjeeling-sync 2>/dev/null || true
        else
            usermod -a -G "$SERVICE_USER" darjeeling-sync 2>/dev/null || true
        fi
        chmod 2775 "/var/lib/darjeeling/vault"
        chown -R "$SERVICE_USER:$SERVICE_USER" "/var/lib/darjeeling/vault"
    else
        chmod 0700 "/var/lib/darjeeling/vault"
    fi

    # 4. Extract or copy release payload into release directory
    local script_dir="$SCRIPT_DIR"

    local source_tarball=""
    if [[ -n "$TARBALL_PATH" ]]; then
        source_tarball="$TARBALL_PATH"
    elif [[ -f "${script_dir}/darjeeling-server-${DJ_VERSION}.tar.gz" ]]; then
        source_tarball="${script_dir}/darjeeling-server-${DJ_VERSION}.tar.gz"
    fi

    if [[ -z "$source_tarball" && ! -d "${script_dir}/darjeeling_server" && "$DJ_VERSION" != *-dev ]]; then
        log "Downloading darjeeling-server-${DJ_VERSION}.tar.gz from GitHub release..."
        source_tarball="/tmp/darjeeling-server-${DJ_VERSION}.tar.gz"
        curl -fsSL "https://github.com/michaelperna/obsidian-darjeeling/releases/download/${DJ_VERSION}/darjeeling-server-${DJ_VERSION}.tar.gz" -o "$source_tarball"
    fi

    if [[ -n "$source_tarball" ]]; then
        if [[ ! -f "$source_tarball" ]]; then
            err "Specified tarball not found: $source_tarball"
            exit 1
        fi
        if [[ -n "$TARBALL_SHA256" ]]; then
            log "Verifying release tarball SHA256..."
            local actual_sha
            if command -v sha256sum >/dev/null 2>&1; then
                actual_sha="$(sha256sum "$source_tarball" | awk '{print $1}')"
            else
                actual_sha="$(python3 -c "import hashlib; print(hashlib.sha256(open('$source_tarball', 'rb').read()).hexdigest())")"
            fi
            if [[ "$actual_sha" != "$TARBALL_SHA256" ]]; then
                err "TARBALL SHA256 mismatch! Expected: $TARBALL_SHA256, Got: $actual_sha"
                exit 1
            fi
            log "Tarball SHA256 verified successfully ($actual_sha)."
        fi
        log "Extracting tarball: $source_tarball..."
        tar -xzf "$source_tarball" -C "$release_dir"
    elif [[ -d "${script_dir}/darjeeling_server" ]]; then
        log "Installing from source files at ${script_dir}..."
        cp -R "${script_dir}/darjeeling_server" "$release_dir/"
        cp "${script_dir}/requirements.lock" "$release_dir/"
        cp -R "${script_dir}/units" "$release_dir/"
        if [[ -d "${script_dir}/udev" ]]; then
            cp -R "${script_dir}/udev" "$release_dir/"
        fi
        cp "${script_dir}/tmux.conf" "$release_dir/"
        cp -R "${script_dir}/bin" "$release_dir/"
        cp -R "${script_dir}/catalog" "$release_dir/"
        mkdir -p "$release_dir/config"
        cp "${script_dir}/config/darjeeling.env.example" "$release_dir/config/"
        cp "${script_dir}/pyproject.toml" "$release_dir/" 2>/dev/null || true
        cp "${script_dir}/install.sh" "$release_dir/install.sh" 2>/dev/null || true
        echo "$DJ_VERSION" > "$release_dir/VERSION"
    else
        err "No release payload found (neither --tarball, nor adjacent tarball, nor source directory)."
        exit 1
    fi

    # Ensure files under /opt/darjeeling are owned by root:root
    chown -R root:root "/opt/darjeeling"
    chmod -R 0755 "$release_dir"
    chmod +x "$release_dir/bin/darjeeling" 2>/dev/null || true

    # Link /opt/darjeeling/current atomically; remember the release it
    # pointed at for `darjeeling rollback`.
    if [[ -n "$prev_release" && -d "$prev_release" && "$prev_release" != "$(readlink -f "$release_dir")" ]]; then
        ln -sfn "$prev_release" /opt/darjeeling/previous
        log "Previous release kept for rollback: ${prev_release}"
    fi
    ln -sfn "releases/${DJ_VERSION}" /opt/darjeeling/current
    ln -sfn /opt/darjeeling/current/bin/darjeeling /usr/local/bin/darjeeling

    # 5. Build Python venv from requirements.lock with --require-hashes
    log "Creating Python virtual environment..."
    python3 -m venv "$release_dir/venv"
    log "Installing pinned dependencies with hash verification..."
    "$release_dir/venv/bin/pip" install -q --no-deps --require-hashes -r "$release_dir/requirements.lock"
    # Ensure darjeeling_server package is importable from any directory
    find "$release_dir/venv/lib" -maxdepth 2 -type d -name "site-packages" -exec sh -c 'echo "/opt/darjeeling/current" > "$1/darjeeling.pth"' _ {} \;

    # 6. Setup Token (idempotent: never overwrite an existing token)
    local token_file="${STATE_ROOT}/.token"
    if [[ "$is_legacy_migration" == "true" && -n "$legacy_token" && ! -s "$token_file" ]]; then
        log "Migrating legacy authentication token..."
        echo -n "$legacy_token" > "$token_file"
        chown "$SERVICE_USER:$SERVICE_USER" "$token_file"
        chmod 0600 "$token_file"
        log "Authentication token migrated at ${token_file}."

        local dev_file="${STATE_ROOT}/devices.json"
        # Only seed devices.json once; re-running the installer must never
        # wipe devices that were paired after the migration.
        [[ -f "$dev_file" ]] || DJ_LEGACY_TOKEN="$legacy_token" DJ_DEV_FILE="$dev_file" python3 -c "
import hashlib, json, datetime, os
tok = os.environ['DJ_LEGACY_TOKEN']
record = {
    'device_id': 'legacy',
    'token_hash': hashlib.sha256(tok.encode('utf-8')).hexdigest(),
    'device_name': 'Legacy 4.1.0 client',
    'platform': 'legacy',
    'created': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'last_seen': None,
    'revoked': False
}
with open(os.environ['DJ_DEV_FILE'], 'w') as f:
    json.dump([record], f, indent=2)
" 2>/dev/null || true
        chown "$SERVICE_USER:$SERVICE_USER" "$dev_file" 2>/dev/null || true
        chmod 0600 "$dev_file" 2>/dev/null || true
    elif [[ ! -f "$token_file" ]]; then
        log "Generating 256-bit authentication token..."
        local new_token
        new_token="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
        echo -n "$new_token" > "$token_file"
        chown "$SERVICE_USER:$SERVICE_USER" "$token_file"
        chmod 0600 "$token_file"
        log "Authentication token configured at ${token_file}."
    else
        log "Existing authentication token preserved at ${token_file}."
    fi

    # Older CLIs minted a stray root-owned token at ${STATE_ROOT}/token when run
    # without the env file. The server never reads it; remove it if .token exists.
    local stray_token="${STATE_ROOT}/token"
    if [[ -f "$stray_token" && -s "$token_file" ]]; then
        if [[ "$(stat -c '%U' "$stray_token" 2>/dev/null || echo "")" == "root" ]]; then
            rm -f "$stray_token"
            log "Removed stray root-owned token file ${stray_token} (the server uses ${token_file})."
        fi
    fi

    # 7. Setup Configuration /etc/darjeeling/darjeeling.env (Idempotent)
    local env_file="/etc/darjeeling/darjeeling.env"
    if [[ "$is_legacy_migration" == "true" ]]; then
        log "Applying legacy migration configuration to ${env_file}..."
        local env_is_new=false
        if [[ ! -f "$env_file" ]]; then
            cp "$release_dir/config/darjeeling.env.example" "$env_file"
            sed -i "s|^# DARJEELING_BIND=.*|DARJEELING_BIND=${bind_ip}|" "$env_file"
            sed -i "s|^DARJEELING_PORT=.*|DARJEELING_PORT=${PORT}|" "$env_file"
            sed -i "s|^DARJEELING_MAX_CONCURRENT_TURNS=.*|DARJEELING_MAX_CONCURRENT_TURNS=${max_concurrent_turns}|" "$env_file"
            env_is_new=true
        fi
        # Permission ceiling: keep an explicit value (from the existing env file,
        # or from the legacy config on first migration); otherwise acceptEdits.
        # The installer never raises the ceiling on its own.
        local ceiling=""
        if [[ "$env_is_new" != "true" ]]; then
            ceiling="$(get_env_var DARJEELING_PERMISSION_CEILING "$env_file")"
        fi
        if [[ -z "$ceiling" ]]; then
            case "$legacy_ceiling" in
                plan|acceptEdits|bypassPermissions) ceiling="$legacy_ceiling" ;;
                *) ceiling="acceptEdits" ;;
            esac
            set_env_var DARJEELING_PERMISSION_CEILING "$ceiling" "$env_file"
        fi
        log "Permission ceiling: ${ceiling}"
        if [[ "$ceiling" == "bypassPermissions" && "$ceiling_forced_by_old" == "true" && "$legacy_ceiling" != "bypassPermissions" ]]; then
            review_forced_ceiling "$env_file" "$legacy_marker"
        elif [[ "$ceiling" != "bypassPermissions" ]]; then
            log "  To allow bypassPermissions turns: sudo darjeeling config set permission-ceiling bypassPermissions && sudo systemctl restart darjeeling.service"
        fi
        # Vault: set from the legacy config on first migration, or once when
        # converting 1.0.3's DARJEELING_VAULT_PATH (a key the server never
        # read). Otherwise the env file's value is the user's and is kept.
        local vault_path_1_0_3 current_vault
        vault_path_1_0_3="$(get_env_var DARJEELING_VAULT_PATH "$env_file")"
        current_vault="$(get_env_var DARJEELING_VAULT "$env_file")"
        if [[ -n "$legacy_vault" && ( "$env_is_new" == "true" || -n "$vault_path_1_0_3" ) ]]; then
            if [[ "$env_is_new" != "true" && -n "$current_vault" && "$current_vault" != "$legacy_vault" ]]; then
                warn "Vault changes from ${current_vault} to your 4.1.0 vault ${legacy_vault}: 1.0.3 wrote it as DARJEELING_VAULT_PATH, which the server ignored."
                warn "  To keep using ${current_vault}: sudo darjeeling config set vault ${current_vault} && sudo systemctl restart darjeeling.service"
            fi
            set_env_var DARJEELING_VAULT "$legacy_vault" "$env_file"
        fi
        if [[ -n "$vault_path_1_0_3" ]]; then
            unset_env_var DARJEELING_VAULT_PATH "$env_file"
        fi
        chown "root:${SERVICE_USER}" "$env_file"
        chmod 0640 "$env_file"
    elif [[ ! -f "$env_file" ]]; then
        log "Creating initial configuration at ${env_file}..."
        cp "$release_dir/config/darjeeling.env.example" "$env_file"
        
        # Configure BIND and PORT
        sed -i "s|^# DARJEELING_BIND=.*|DARJEELING_BIND=${bind_ip}|" "$env_file"
        sed -i "s|^DARJEELING_PORT=.*|DARJEELING_PORT=${PORT}|" "$env_file"
        sed -i "s|^DARJEELING_MAX_CONCURRENT_TURNS=.*|DARJEELING_MAX_CONCURRENT_TURNS=${max_concurrent_turns}|" "$env_file"
        if grep -q "^DARJEELING_VAULT_SYNC=" "$env_file"; then
            sed -i "s|^DARJEELING_VAULT_SYNC=.*|DARJEELING_VAULT_SYNC=${VAULT_SYNC}|" "$env_file"
        else
            echo "DARJEELING_VAULT_SYNC=${VAULT_SYNC}" >> "$env_file"
        fi

        chown "root:${SERVICE_USER}" "$env_file"
        chmod 0640 "$env_file"
    else
        log "Existing configuration preserved at ${env_file}."
        if [[ "$(get_env_var DARJEELING_PERMISSION_CEILING "$env_file")" == "bypassPermissions" ]]; then
            warn "Permission ceiling bypassPermissions is kept. The 1.0.3 example config used it as the default; to lower it: sudo darjeeling config set permission-ceiling acceptEdits"
        fi
    fi
    apply_pending_bind "$env_file"

    # DeepSeek API key: the server reads ${STATE_ROOT}/secrets/deepseek_api_key
    # first and only falls back to DEEPSEEK_API_KEY in the environment, so keep
    # secrets out of the env file.
    local secrets_dir="${STATE_ROOT}/secrets"
    local deepseek_secret="${secrets_dir}/deepseek_api_key"
    local env_deepseek=""
    env_deepseek="$(get_env_var DEEPSEEK_API_KEY "$env_file")"
    # The env file is the live configuration; the legacy 4.1.0 config.env is
    # only a fallback (it may hold a key that was rotated since migration).
    local deepseek_value="${env_deepseek:-$legacy_deepseek}"
    if [[ -n "$deepseek_value" && ! -s "$deepseek_secret" ]]; then
        install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$secrets_dir"
        ( umask 077; printf '%s\n' "$deepseek_value" > "$deepseek_secret" )
        chown "$SERVICE_USER:$SERVICE_USER" "$deepseek_secret"
        chmod 0600 "$deepseek_secret"
        log "DeepSeek API key stored at ${deepseek_secret} (0600)."
    fi
    if [[ -n "$env_deepseek" && -s "$deepseek_secret" ]]; then
        unset_env_var DEEPSEEK_API_KEY "$env_file"
        log "Moved DEEPSEEK_API_KEY out of ${env_file} into ${deepseek_secret}."
    fi

    # 8. Claude Code Native Install
    if [[ "$CLAUDE_MODE" == "native" ]]; then
        local claude_bin="${user_home}/.local/bin/claude"
        if runuser -u "$SERVICE_USER" -- which claude >/dev/null 2>&1; then
            log "Claude Code already installed for ${SERVICE_USER}; skipping install."
        elif [[ ! -x "$claude_bin" ]]; then
            log "Installing Claude Code CLI natively for user ${SERVICE_USER}..."
            local c_tmp
            c_tmp="$(mktemp)"
            chmod 0644 "$c_tmp"
            if curl -fsSL -m 15 https://claude.ai/install.sh -o "$c_tmp" 2>/dev/null; then
                runuser -u "$SERVICE_USER" -- bash "$c_tmp" || true
            else
                warn "Could not download Claude Code installer (offline or rate limited); skipping."
            fi
            rm -f "$c_tmp"
        fi
    fi

    # Root-owned Claude Code managed settings
    log "Configuring Claude Code managed settings..."
    mkdir -p /etc/claude-code
    cat << 'EOF' > /etc/claude-code/managed-settings.json
{
  "denyRules": [
    "**/.claude/**",
    "**/.obsidian/**"
  ],
  "disableBypass": true
}
EOF
    chown root:root /etc/claude-code/managed-settings.json
    chmod 0644 /etc/claude-code/managed-settings.json

    # Optional add-ons
    if [[ "$WITH_AGY" == "true" ]]; then
        log "Installing Google Antigravity SDK (--with-agy)..."
        runuser -u "$SERVICE_USER" -- bash -c "python3 -m pip install --user google-antigravity 2>/dev/null || true"
    fi

    if [[ "$INSTALL_NORDVPN" == "true" ]]; then
        log "Installing NordVPN client (--install-nordvpn)..."
        sh <(curl -sSf https://downloads.nordcdn.com/apps/linux/install.sh) -n 2>/dev/null || true
    fi

    # 9. Laptop Profile
    if [[ "$LAPTOP_PROFILE" == "true" ]]; then
        log "Configuring laptop profile..."
        # 1. Lid switch handling
        mkdir -p /etc/systemd/logind.conf.d
        cat << 'EOF' > /etc/systemd/logind.conf.d/darjeeling.conf
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
EOF
        systemctl kill -s HUP systemd-logind 2>/dev/null || true

        # 2. Battery threshold control udev rules
        if [[ -f "$release_dir/udev/99-darjeeling-battery.rules" ]]; then
            mkdir -p /etc/udev/rules.d
            cp "$release_dir/udev/99-darjeeling-battery.rules" /etc/udev/rules.d/
            if command -v udevadm >/dev/null 2>&1; then
                udevadm control --reload-rules 2>/dev/null || true
                udevadm trigger --subsystem-match=power_supply 2>/dev/null || true
            fi
            log "Configured battery threshold udev rules for group ${SERVICE_USER}."
        fi
    fi

    # 10. Install and Start Systemd Units
    log "Configuring systemd service units..."
    local tmux_unit="/etc/systemd/system/darjeeling-tmux.service"
    local srv_unit="/etc/systemd/system/darjeeling.service"

    cp "$release_dir/units/darjeeling-tmux.service" "$tmux_unit"
    cp "$release_dir/units/darjeeling.service" "$srv_unit"

    if [[ "$SERVICE_USER" != "darjeeling" ]]; then
        sed -i "s|User=darjeeling|User=${SERVICE_USER}|g" "$tmux_unit" "$srv_unit"
    fi
    # HOME must be the service user's real home directory (the units ship with
    # the default /var/lib/darjeeling).
    if [[ "$user_home" != "$STATE_ROOT" ]]; then
        sed -i -e "s|Environment=HOME=${STATE_ROOT} |Environment=HOME=${user_home} |" \
               -e "s|Environment=PATH=${STATE_ROOT}/.local/bin:|Environment=PATH=${user_home}/.local/bin:|" \
               "$tmux_unit" "$srv_unit"
    fi

    if [[ "$VAULT_SYNC" == "obsidian-sync" && -f "$release_dir/units/darjeeling-vault-sync.service" ]]; then
        local sync_unit="/etc/systemd/system/darjeeling-vault-sync.service"
        cp "$release_dir/units/darjeeling-vault-sync.service" "$sync_unit"
        if [[ "$SERVICE_USER" != "darjeeling" ]]; then
            sed -i "s|Group=darjeeling|Group=${SERVICE_USER}|g" "$sync_unit"
        fi
        systemctl enable darjeeling-vault-sync.service 2>/dev/null || true
    fi

    systemctl daemon-reload
    systemctl enable darjeeling-tmux.service
    systemctl enable darjeeling.service

    log "Starting darjeeling-tmux.service..."
    systemctl restart darjeeling-tmux.service

    log "Starting darjeeling.service..."
    systemctl restart darjeeling.service

    # Configure Tailscale Serve if network mode is tailscale
    if [[ "$NETWORK_MODE" == "tailscale" ]]; then
        if command -v tailscale >/dev/null 2>&1; then
            log "Configuring Tailscale Serve..."
            log "Executing: ${ts_serve_cmd}"
            if ! tailscale serve --bg --https="${ts_serve_port}" "http://127.0.0.1:${PORT}" 2>/dev/null; then
                warn "Tailscale Serve failed (HTTPS might be disabled on your tailnet)."
                local ts_ip
                ts_ip="$(ip -4 addr show dev tailscale0 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -n1 || tailscale ip -4 2>/dev/null || echo '127.0.0.1')"
                warn "Falling back to tailnet IP over http: http://${ts_ip}:${PORT}"
                warn "To enable HTTPS in Tailscale: Open Tailscale Admin Console > DNS > Enable HTTPS Certificates."
            fi
        else
            warn "tailscale command not found. Run manually when available:"
            warn "  ${ts_serve_cmd}"
        fi
    fi

    # Print firewall notice if relevant
    local iface=""
    case "$NETWORK_MODE" in
        tailscale) iface="tailscale0" ;;
        meshnet) iface="nordlynx" ;;
        wireguard) iface="wg0" ;;
        *) iface="" ;;
    esac

    if [[ -n "$iface" ]]; then
        if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
            log "Firewall notice: ufw is active. Allow Darjeeling port if required:"
            log "  sudo ufw allow in on ${iface} to any port ${PORT} proto tcp comment 'Darjeeling server'"
        elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
            log "Firewall notice: firewalld is active. Allow Darjeeling port if required:"
            log "  sudo firewall-cmd --zone=trusted --add-interface=${iface} --permanent && sudo firewall-cmd --reload"
        fi
    fi

    # 11. Health endpoint poll
    log "Polling http://127.0.0.1:${PORT}/health for readiness..."
    local healthy=false
    for _ in $(seq 1 15); do
        if curl -s -f -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || curl -s -f -m 2 "http://${bind_ip}:${PORT}/health" >/dev/null 2>&1; then
            healthy=true
            break
        fi
        sleep 1
    done

    if [[ "$healthy" == "true" ]]; then
        log "Project Darjeeling server is ACTIVE and healthy on ${bind_ip}:${PORT}!"
        echo ""
        echo "=========================================================="
        echo "Project Darjeeling ${DJ_VERSION} installed successfully!"
        echo "=========================================================="
        echo "Endpoint:    http://${bind_ip}:${PORT}"
        echo "Config:      /etc/darjeeling/darjeeling.env"
        echo "Version:     ${DJ_VERSION}"
        echo "Token path:  ${STATE_ROOT}/.token"
        echo ""
        echo "--- Pairing Instructions ---"
        # Run as the service user so pairing.json stays readable by the server.
        # Pass the state dir and token path up front: the package reads its
        # configuration at import time, before the CLI loads the env file.
        local pair_tokfile
        pair_tokfile="$(get_env_var DARJEELING_TOKEN_FILE "$env_file")"
        if ! (cd / && runuser -u "$SERVICE_USER" -- env DARJEELING_ENV="$env_file" \
                DARJEELING_STATE_DIR="$STATE_ROOT" DARJEELING_TOKEN_FILE="${pair_tokfile:-${STATE_ROOT}/.token}" \
                "$release_dir/venv/bin/python" -m darjeeling_server.cli pair --state-dir "$STATE_ROOT"); then
            warn "Could not create a pairing code. Run later: sudo darjeeling pair"
        fi
        echo ""
        echo "--- Agent Authentication ---"
        echo "Log in Claude Code for the service user:"
        if runuser -u "$SERVICE_USER" -- sh -c 'command -v claude' >/dev/null 2>&1; then
            echo "  sudo runuser -u ${SERVICE_USER} -- claude login"
        else
            echo "  sudo runuser -u ${SERVICE_USER} -- ${user_home}/.local/bin/claude login"
        fi
        echo ""
        echo "--- Vault Sync ---"
        local v_path
        v_path="$(get_env_var DARJEELING_VAULT "$env_file")"
        v_path="${v_path:-/var/lib/darjeeling/vault}"
        echo "Target Obsidian Vault directory: ${v_path}"
        echo "Sync notes via Obsidian Sync, Syncthing, or Git. Exclude .obsidian/ in both directions."
        if [[ "$is_legacy_migration" == "true" ]]; then
            echo ""
            echo "Notice: Tmux sessions on the old default socket have ended."
            echo "New persistent sessions run under socket 'darjeeling'."
        fi
        echo "=========================================================="
        exit 0
    else
        err "Server failed to respond to /health check within 15 seconds."
        echo "--- Recent journald logs ---" >&2
        journalctl -u darjeeling.service -n 50 --no-pager >&2 || true
        exit 1
    fi
}

# DJ_INSTALL_SOURCE_ONLY=1 lets the test suite source the helpers above
# without running the installer.
if [[ -z "${DJ_INSTALL_SOURCE_ONLY:-}" ]]; then
    main "$@"
fi

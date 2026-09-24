#!/usr/bin/env bash
# ==============================================================================
# Project Darjeeling: Server Installation & Lifecycle Script
# ==============================================================================
# Idempotent host installation script for Debian/Ubuntu LTS daemons.
# Manages systemd services, Python virtual environments, auth tokens,
# and overlay network bindings.
# ==============================================================================

set -euo pipefail

DJ_VERSION="1.0.0-dev"
TARBALL_SHA256=""
INSTALL_LOG="/var/log/darjeeling-install.log"
mkdir -p "$(dirname "$INSTALL_LOG")" 2>/dev/null || INSTALL_LOG="/tmp/darjeeling-install.log"

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
  --vault-sync <mode>    Vault sync mode: none (default), obsidian-sync (OD-25, G-32)
  --install-nordvpn      Install NordVPN client
  --version <ver>        Override Darjeeling version
  --uninstall            Uninstall Darjeeling services and files
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
    log "Uninstalling Project Darjeeling..."
    systemctl stop darjeeling.service darjeeling-tmux.service darjeeling-vault-sync.service 2>/dev/null || true
    systemctl disable darjeeling.service darjeeling-tmux.service darjeeling-vault-sync.service 2>/dev/null || true

    rm -f /etc/systemd/system/darjeeling.service /etc/systemd/system/darjeeling-tmux.service /etc/systemd/system/darjeeling-vault-sync.service
    rm -rf /etc/systemd/system/darjeeling.service.d
    systemctl daemon-reload 2>/dev/null || true

    rm -f /usr/local/bin/darjeeling
    rm -rf /opt/darjeeling
    rm -f /etc/udev/rules.d/99-darjeeling-battery.rules 2>/dev/null || true
    rm -f /etc/claude-code/managed-settings.json 2>/dev/null || true

    if [[ "$UNINSTALL_PURGE" == "true" ]]; then
        rm -rf /etc/darjeeling /var/lib/darjeeling /var/lib/darjeeling-sync
    elif [[ "$UNINSTALL_DELETE_VAULT" == "true" ]]; then
        rm -rf /var/lib/darjeeling/vault
    fi

    if [[ "$UNINSTALL_REMOVE_USER" == "true" ]]; then
        log "Removing system users '${SERVICE_USER}' and 'darjeeling-sync' (leaving home directories in place per G-50)..."
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

    # 3. Architecture check (refuse armv7l per INST-28)
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

    # 5. RAM check for default concurrency (INST-28)
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
            # In Tailscale Serve mode per ADR-16, server binds loopback
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

            # If auto failed to find any overlay network, exit 3 with instructions (INST-17, F-04)
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

    local max_concurrent_turns
    max_concurrent_turns="$(run_preflight)"

    local bind_ip
    bind_ip="$(detect_network "$NETWORK_MODE")"

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

        if command -v sudo >/dev/null 2>&1; then
            if sudo -l -U "$SERVICE_USER" 2>/dev/null | grep -q "NOPASSWD"; then
                warn "User '${SERVICE_USER}' has NOPASSWD sudo privileges. Hardening recommends removing sudo rules."
            fi
        fi

        if [[ -f /etc/systemd/system/darjeeling.service ]]; then
            mkdir -p "/opt/darjeeling/backups/legacy-4.1.0"
            cp -p /etc/systemd/system/darjeeling.service "/opt/darjeeling/backups/legacy-4.1.0/darjeeling.service"
            log "Backed up legacy unit to /opt/darjeeling/backups/legacy-4.1.0/darjeeling.service"
        fi

        mkdir -p /etc/systemd/system/darjeeling.service.d
        cat << EOF > /etc/systemd/system/darjeeling.service.d/legacy-env.conf
[Service]
Environment="PATH=/usr/local/bin:/usr/bin:/bin:/home/${SERVICE_USER}/.bun/bin:/home/${SERVICE_USER}/.npm-global/bin:/home/${SERVICE_USER}/.local/bin"
EOF

        cat << EOF > "${legacy_dir}/MIGRATED_TO_V1.txt"
This Darjeeling 4.1.0 installation has been migrated to Project Darjeeling v1.0.0.
Managed configuration is now located at /etc/darjeeling/darjeeling.env
Server daemon is managed under /opt/darjeeling/current
EOF
    fi

    # 1. Create or verify dedicated service user
    if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
        log "Creating dedicated service user: ${SERVICE_USER}"
        useradd -r -s /bin/bash -d /var/lib/darjeeling -m "$SERVICE_USER"
    else
        log "Service user '${SERVICE_USER}' already exists."
        usermod -s /bin/bash "$SERVICE_USER" 2>/dev/null || true
    fi

    # Check if service user has sudo permissions (INST-04)
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
    mkdir -p "$release_dir"
    mkdir -p "/etc/darjeeling"
    mkdir -p "/var/lib/darjeeling/run"
    mkdir -p "/var/lib/darjeeling/vault"

    chown -R "$SERVICE_USER:$SERVICE_USER" "/var/lib/darjeeling"
    chmod 0700 "/var/lib/darjeeling"
    chmod 0700 "/var/lib/darjeeling/run"

    if [[ "$VAULT_SYNC" == "obsidian-sync" ]]; then
        log "Configuring vault synchronization for obsidian-sync (OD-25, G-32)..."
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
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

    local source_tarball=""
    if [[ -n "$TARBALL_PATH" ]]; then
        source_tarball="$TARBALL_PATH"
    elif [[ -f "${script_dir}/darjeeling-server-${DJ_VERSION}.tar.gz" ]]; then
        source_tarball="${script_dir}/darjeeling-server-${DJ_VERSION}.tar.gz"
    fi

    if [[ -z "$source_tarball" && ! -d "${script_dir}/darjeeling_server" && -n "$DJ_VERSION" && "$DJ_VERSION" != "1.0.0-dev" ]]; then
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
        cp "${BASH_SOURCE[0]}" "$release_dir/install.sh" 2>/dev/null || true
        echo "$DJ_VERSION" > "$release_dir/VERSION"
    else
        err "No release payload found (neither --tarball, nor adjacent tarball, nor source directory)."
        exit 1
    fi

    # Ensure files under /opt/darjeeling are owned by root:root
    chown -R root:root "/opt/darjeeling"
    chmod -R 0755 "$release_dir"
    chmod +x "$release_dir/bin/darjeeling" 2>/dev/null || true

    # Link /opt/darjeeling/current atomically
    ln -sfn "releases/${DJ_VERSION}" /opt/darjeeling/current
    ln -sfn /opt/darjeeling/current/bin/darjeeling /usr/local/bin/darjeeling

    # 5. Build Python venv from requirements.lock with --require-hashes
    log "Creating Python virtual environment..."
    python3 -m venv "$release_dir/venv"
    log "Installing pinned dependencies with hash verification..."
    "$release_dir/venv/bin/pip" install -q --no-deps --require-hashes -r "$release_dir/requirements.lock"
    # Ensure darjeeling_server package is importable from any directory
    find "$release_dir/venv/lib" -maxdepth 2 -type d -name "site-packages" -exec sh -c 'echo "/opt/darjeeling/current" > "$1/darjeeling.pth"' _ {} \;

    # 6. Setup Token (Idempotent: never overwrite existing token per QA-16)
    local token_file="/var/lib/darjeeling/.token"
    if [[ "$is_legacy_migration" == "true" && -n "$legacy_token" ]]; then
        log "Migrating legacy authentication token..."
        echo -n "$legacy_token" > "$token_file"
        chown "$SERVICE_USER:$SERVICE_USER" "$token_file"
        chmod 0600 "$token_file"
        log "Authentication token migrated at ${token_file}."

        local dev_file="/var/lib/darjeeling/devices.json"
        python3 -c "
import hashlib, json, datetime
tok = '${legacy_token}'
record = {
    'device_id': 'legacy',
    'token_hash': hashlib.sha256(tok.encode('utf-8')).hexdigest(),
    'device_name': 'Legacy 4.1.0 client',
    'platform': 'legacy',
    'created': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'last_seen': None,
    'revoked': False
}
with open('${dev_file}', 'w') as f:
    json.dump([record], f, indent=2)
" 2>/dev/null || true
        chown "$SERVICE_USER:$SERVICE_USER" "$dev_file" 2>/dev/null || true
        chmod 0600 "$dev_file" 2>/dev/null || true
    elif [[ ! -f "$token_file" ]]; then
        log "Generating secure 32-character authentication token..."
        local new_token
        new_token="$(head -c 16 /dev/urandom | xxd -p 2>/dev/null || python3 -c 'import secrets; print(secrets.token_hex(16))')"
        echo -n "$new_token" > "$token_file"
        chown "$SERVICE_USER:$SERVICE_USER" "$token_file"
        chmod 0600 "$token_file"
        log "Authentication token configured at ${token_file}."
    else
        log "Existing authentication token preserved at ${token_file}."
    fi

    # 7. Setup Configuration /etc/darjeeling/darjeeling.env (Idempotent per QA-16)
    local env_file="/etc/darjeeling/darjeeling.env"
    if [[ "$is_legacy_migration" == "true" ]]; then
        log "Applying legacy migration configuration to ${env_file}..."
        if [[ ! -f "$env_file" ]]; then
            cp "$release_dir/config/darjeeling.env.example" "$env_file"
            sed -i "s|^# DARJEELING_BIND=.*|DARJEELING_BIND=${bind_ip}|" "$env_file"
            sed -i "s|^DARJEELING_PORT=.*|DARJEELING_PORT=${PORT}|" "$env_file"
            sed -i "s|^DARJEELING_MAX_CONCURRENT_TURNS=.*|DARJEELING_MAX_CONCURRENT_TURNS=${max_concurrent_turns}|" "$env_file"
        fi
        if grep -q "^DARJEELING_PERMISSION_CEILING=" "$env_file"; then
            sed -i "s|^DARJEELING_PERMISSION_CEILING=.*|DARJEELING_PERMISSION_CEILING=bypassPermissions|" "$env_file"
        else
            echo "DARJEELING_PERMISSION_CEILING=bypassPermissions" >> "$env_file"
        fi
        if [[ -n "$legacy_vault" ]]; then
            if grep -q "^DARJEELING_VAULT_PATH=" "$env_file"; then
                sed -i "s|^DARJEELING_VAULT_PATH=.*|DARJEELING_VAULT_PATH=${legacy_vault}|" "$env_file"
            else
                echo "DARJEELING_VAULT_PATH=${legacy_vault}" >> "$env_file"
            fi
        fi
        if [[ -n "$legacy_deepseek" ]]; then
            if grep -q "^DEEPSEEK_API_KEY=" "$env_file"; then
                sed -i "s|^DEEPSEEK_API_KEY=.*|DEEPSEEK_API_KEY=${legacy_deepseek}|" "$env_file"
            else
                echo "DEEPSEEK_API_KEY=${legacy_deepseek}" >> "$env_file"
            fi
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
    fi

    # 8. Claude Code Native Install (INST-10, QA-14)
    if [[ "$CLAUDE_MODE" == "native" ]]; then
        local claude_bin="/var/lib/darjeeling/.local/bin/claude"
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

    # ADR-25: Root-owned Claude Code managed settings
    log "Configuring Claude Code managed settings (ADR-25)..."
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

    # 9. Laptop Profile (INST-08, INST-24, SRV-23, SRV-27, QA-17)
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

        # 2. Battery threshold control udev rules (INST-24, SRV-23)
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

    # 10. Install and Start Systemd Units (INST-05, INST-07)
    log "Configuring systemd service units..."
    local tmux_unit="/etc/systemd/system/darjeeling-tmux.service"
    local srv_unit="/etc/systemd/system/darjeeling.service"

    cp "$release_dir/units/darjeeling-tmux.service" "$tmux_unit"
    cp "$release_dir/units/darjeeling.service" "$srv_unit"

    local user_home
    user_home="$(getent passwd "$SERVICE_USER" 2>/dev/null | cut -d: -f6 || echo "")"
    if [[ -z "$user_home" || ! -d "$user_home" ]]; then
        user_home="/home/${SERVICE_USER}"
    fi

    if [[ "$SERVICE_USER" != "darjeeling" ]]; then
        sed -i "s|User=darjeeling|User=${SERVICE_USER}|g" "$tmux_unit" "$srv_unit"
        sed -i "s|HOME=/home/darjeeling|HOME=${user_home}|g" "$tmux_unit" "$srv_unit"
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

    # 11. Health endpoint poll (INST-34)
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
        echo "Token path:  /var/lib/darjeeling/.token"
        echo ""
        echo "--- Pairing Instructions ---"
        "$release_dir/venv/bin/python" -m darjeeling_server.cli pair --state-dir "/var/lib/darjeeling" 2>/dev/null || true
        echo ""
        echo "--- Agent Authentication ---"
        echo "Log in Claude Code for the service user:"
        echo "  sudo runuser -u ${SERVICE_USER} -- claude login"
        echo ""
        echo "--- Vault Sync ---"
        local v_path="/var/lib/darjeeling/vault"
        if [[ "$is_legacy_migration" == "true" && -n "$legacy_vault" ]]; then
            v_path="$legacy_vault"
        fi
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

main "$@"

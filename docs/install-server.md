# Companion Server Installation & Lifecycle Guide

This document describes how to install, configure, verify, upgrade, and maintain the Project Darjeeling companion server daemon (`darjeeling-server`) on Debian and Ubuntu Linux systems.

---

## 1. Supported Operating Systems & Architecture

Darjeeling companion daemon is supported on 64-bit architectures: `x86_64` (GA) and `aarch64` / `arm64` (Beta), running:
* **Debian 12 ("Bookworm")** and **Debian 13 ("Trixie")**
* **Ubuntu 22.04 LTS ("Jammy")**, **Ubuntu 24.04 LTS ("Noble")**, and **Ubuntu 26.04 LTS**

### Minimum Requirements
* Systemd service manager
* Python 3.10 or newer (with `python3-venv`)
* Dedicated unprivileged user account (default: `darjeeling`, created by the installer)
* 1 GB available RAM (2 GB+ recommended for concurrent agent turns)

---

## 2. Prerequisites

Install the tools used to download and verify the release (the installer adds `tmux`, `iproute2` and the rest itself):

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git python3 python3-venv
```

`git` is only needed if you install from a clone instead of a release download.

---

## 3. Installation

### Option A: Release download (recommended)

Every release on [github.com/michaelperna/obsidian-darjeeling/releases](https://github.com/michaelperna/obsidian-darjeeling/releases) ships a stamped `install.sh`, a reproducible server tarball `darjeeling-server-<version>.tar.gz`, and a `SHA256SUMS` file covering every asset.

```bash
VER=1.0.4
BASE="https://github.com/michaelperna/obsidian-darjeeling/releases/download/${VER}"
mkdir -p ~/darjeeling-install && cd ~/darjeeling-install
curl -fsSL -O "${BASE}/install.sh" -O "${BASE}/darjeeling-server-${VER}.tar.gz" -O "${BASE}/SHA256SUMS"
sha256sum --ignore-missing -c SHA256SUMS
sudo bash install.sh --yes --network auto
```

`sha256sum` must print `OK` for both files before you run anything. The stamped `install.sh` carries the version and the tarball's SHA-256, picks up the tarball sitting next to it, and checks the hash again before extracting.

Pick the network mode that matches your host: `--network tailscale`, `--network meshnet`, `--network wireguard`, `--network lan` or `--network loopback`. See [Networking](networking.md).

### Option B: Install from a git clone

Clone the repository somewhere that is **not** under `/opt/darjeeling` (the installer owns that tree), check out a release tag, and run the installer from the checkout:

```bash
git clone https://github.com/michaelperna/obsidian-darjeeling.git ~/obsidian-darjeeling
cd ~/obsidian-darjeeling
git checkout 1.0.4
sudo bash server/install.sh --yes --network auto
```

The version comes from `server/VERSION` in the checkout.

### What the Installer Configures
The installer is idempotent; re-running it keeps your token, configuration and paired devices.
1. **Service User**: Creates the system user `darjeeling` (`--user <name>`) with home directory `/var/lib/darjeeling`. Its login shell is `/bin/bash` so the remote terminal works; it has no sudo rights.
2. **Release Layout**: Installs the server to `/opt/darjeeling/releases/<version>`, points `/opt/darjeeling/current` at it, and links `/usr/local/bin/darjeeling` to the management CLI.
3. **Virtual Environment**: Builds `/opt/darjeeling/releases/<version>/venv` from the hash-pinned `requirements.lock`.
4. **Authentication Token**: Generates a 256-bit token (64 hex characters) at `/var/lib/darjeeling/.token`, owned by the service user, mode `0600`. An existing token is never replaced.
5. **Configuration**: Writes `/etc/darjeeling/darjeeling.env` (`root:darjeeling`, mode `0640`). API keys are kept out of it: a DeepSeek key lives in `/var/lib/darjeeling/secrets/deepseek_api_key` (mode `0600`).
6. **Permission Ceiling**: New installs use `DARJEELING_PERMISSION_CEILING=acceptEdits`. The installer never raises an existing value. See [Permission ceiling](#6-permission-ceiling).
7. **Systemd Services**: Deploys `darjeeling.service` and `darjeeling-tmux.service` running as the service user with `NoNewPrivileges=yes` and `ProtectSystem=full`, `HOME` set to the service user's home.
8. **Claude Code**: Installs Claude Code for the service user (`--claude skip` to opt out) and writes root-owned managed settings to `/etc/claude-code/managed-settings.json`.
9. **Laptop Mode** (`--laptop`): Ignores the lid switch and installs `/etc/udev/rules.d/99-darjeeling-battery.rules` so battery charge thresholds can be set without root.
10. **Service Activation**: Enables and starts the services on port `8765`, waits for `/health`, and prints an 8-digit pairing code and the `claude login` command for the service user.

---

## 4. Verification

Verify that the systemd service is active:

```bash
systemctl is-active darjeeling.service
```

Query the unauthenticated health endpoint (the reported version must match the release you installed):

```bash
curl -fsS http://127.0.0.1:8765/health
darjeeling version
```

Query the authenticated `/api/agents` endpoint using the generated bearer token:

```bash
curl -fsS -H "Authorization: Bearer $(sudo cat /var/lib/darjeeling/.token)" http://127.0.0.1:8765/api/agents
```

Log in Claude Code as the service user (the installer prints the exact command; use the full path `/var/lib/darjeeling/.local/bin/claude` if `claude` is not on the service user's `PATH`):

```bash
sudo runuser -u darjeeling -- claude login
```

Create a pairing code for a new device (valid for 10 minutes; see [Pairing](pairing.md)):

```bash
sudo darjeeling pair
```

---

## 5. Installer Options & Flags Reference

You can review all options by passing `--help`:

```bash
bash install.sh --help
```

| Flag | Argument | Default | Description |
|---|---|---|---|
| `--yes`, `-y` | none | interactive | Accept all defaults non-interactively. |
| `--dry-run` | none | false | Print execution plan without making filesystem or systemd modifications. |
| `--network` | `<mode>` | `auto` | Network detection mode: `auto`, `tailscale`, `meshnet`, `wireguard`, `lan`, or `loopback`. |
| `--bind` | `<ip>` | derived | Explicit IP address for the daemon to bind to. |
| `--port` | `<port>` | `8765` | TCP port for HTTP and WebSocket listeners. |
| `--user` | `<user>` | `darjeeling` | System user to run the daemon. |
| `--tarball` | `<path>` | adjacent tarball | Install from a specific release tarball. |
| `--version` | `<ver>` | stamped / `VERSION` file | Override the version (used for the release directory name). |
| `--laptop` | none | off | Enable battery charge threshold rules and ignore the lid switch. |
| `--no-laptop` | none | off | Disable the laptop profile. |
| `--claude` | `<mode>` | `native` | Claude Code install mode: `native` (per-user install) or `skip`. |
| `--with-agy` | none | disabled | Install Google Antigravity SDK CLI (experimental). |
| `--vault-sync` | `<mode>` | `none` | Vault synchronization mode: `none` or `obsidian-sync`. |
| `--install-nordvpn` | none | disabled | Install the NordVPN client. |
| `--uninstall` | none | false | Uninstall services and installer-created files. |
| `--purge` | none | false | Used with `--uninstall` to delete `/etc/darjeeling` and `/var/lib/darjeeling`. |
| `--delete-vault` | none | false | Used with `--uninstall` to delete `/var/lib/darjeeling/vault`. |
| `--remove-user` | none | false | Used with `--uninstall` to remove the service user account. |

---

## 6. Permission Ceiling

`DARJEELING_PERMISSION_CEILING` in `/etc/darjeeling/darjeeling.env` is the highest permission mode a client may request. Requests above it are lowered to it.

| Value | Meaning |
|---|---|
| `plan` | Read-only analysis; no file edits. |
| `acceptEdits` | May edit files in the vault/workspace (default). |
| `bypassPermissions` | Runs tools and shell commands without asking. |

To raise it:

```bash
sudo darjeeling config set permission-ceiling bypassPermissions
sudo systemctl restart darjeeling.service
```

Installs migrated by 1.0.3 or earlier from the legacy 4.1.0 layout were forced to `bypassPermissions`, and 1.0.3's example config also defaulted to it. 1.0.4 keeps an existing value and warns when it is `bypassPermissions`, so check yours with `sudo darjeeling config get permission-ceiling`.

---

## 7. Upgrades, Rollbacks & Virtual Environment Repair

### Upgrading the Server
Always upgrade with the **new** release's `install.sh`. Download it together with the tarball and `SHA256SUMS`, verify, then run it:

```bash
VER=1.0.4
BASE="https://github.com/michaelperna/obsidian-darjeeling/releases/download/${VER}"
mkdir -p ~/darjeeling-upgrade && cd ~/darjeeling-upgrade
curl -fsSL -O "${BASE}/install.sh" -O "${BASE}/darjeeling-server-${VER}.tar.gz" -O "${BASE}/SHA256SUMS"
sha256sum --ignore-missing -c SHA256SUMS
sudo bash install.sh --tarball "darjeeling-server-${VER}.tar.gz" --yes
```

`sha256sum` must print `OK` for both files. The upgrade keeps the host token, `devices.json` (paired devices), `/etc/darjeeling/darjeeling.env` and an explicitly set permission ceiling. The release being replaced stays in `/opt/darjeeling/releases/` and is recorded as `/opt/darjeeling/previous`.

> **Upgrading from 1.0.3:** do not run `sudo darjeeling upgrade` on a 1.0.3 host. The 1.0.3 CLI runs the old installer from `/opt/darjeeling/current`, which is hard-coded to version `1.0.0-dev` and forces `bypassPermissions` on hosts migrated from 4.1.0. Use the commands above.

On 1.0.4 and later, `sudo darjeeling upgrade --tarball "darjeeling-server-${VER}.tar.gz"` does the same thing: it runs the `install.sh` shipped with the new release (the stamped one next to the tarball if its version matches, otherwise the one inside the tarball), never the installed one.
* The upgrade refuses to run while agent turns are executing (use `--force` to override).
* After installing, it polls `/health`; if the new release does not come up, it switches `/opt/darjeeling/current` back to the previous release.
* Roll back manually with `sudo darjeeling rollback` (it uses `/opt/darjeeling/previous`).

#### Hosts bound to `0.0.0.0` or `::`
Since 1.0.4 the server refuses to listen on every interface (`0.0.0.0`, `::`) or on a link-local address, and will not start with such a `DARJEELING_BIND` or `DARJEELING_HOST`. The installer checks this before changing anything:
* With `--bind <ip>` or `--network <mode>`, it rewrites the env file to that address.
* With `--yes` and exactly one Tailscale or NordVPN Meshnet address on the host, it rewrites the env file to that address.
* Otherwise it stops (exit code 4) and lists the choices. Re-run with, for example, `--bind 100.101.102.103`, `--network meshnet`, `--network lan` or `--network loopback`.

To fix it by hand, set one of these in `/etc/darjeeling/darjeeling.env` and restart the service:

```bash
DARJEELING_BIND=interface:tailscale0      # or interface:nordlynx
DARJEELING_BIND=address:100.101.102.103   # a specific overlay or LAN address
DARJEELING_BIND=loopback                  # Tailscale Serve or SSH forwarding
```

#### Permission ceiling after a 1.0.3 migration
If the host was migrated from 4.1.0 by the 1.0.3 installer and the ceiling is still `bypassPermissions`, the installer keeps it and prints a warning. Interactive runs ask whether to keep it; `--yes` keeps it. To lower it:

```bash
sudo darjeeling config set permission-ceiling acceptEdits
sudo systemctl restart darjeeling.service
```

### Rebuilding Virtual Environments After Distro Upgrades
When upgrading your underlying Linux distribution (e.g., Debian 12 with Python 3.11 to Debian 13 with Python 3.13), existing virtual environments break because the underlying Python binary is replaced.

Run `darjeeling doctor` to diagnose the condition:
```bash
darjeeling doctor
```
If Python version mismatch is detected, repair the virtual environment:
```bash
sudo darjeeling upgrade --rebuild-venv
```

---

## 8. Automated Cloud-Init Deployment

For headless virtual machines (AWS, GCP, Hetzner, Proxmox), deploy using `cloud-init`:

```yaml
#cloud-config
package_update: true
packages:
  - ca-certificates
  - curl
  - python3
  - python3-venv

runcmd:
  - mkdir -p /root/darjeeling-install
  - cd /root/darjeeling-install && curl -fsSL -O https://github.com/michaelperna/obsidian-darjeeling/releases/download/1.0.4/install.sh -O https://github.com/michaelperna/obsidian-darjeeling/releases/download/1.0.4/darjeeling-server-1.0.4.tar.gz -O https://github.com/michaelperna/obsidian-darjeeling/releases/download/1.0.4/SHA256SUMS
  - cd /root/darjeeling-install && sha256sum --ignore-missing -c SHA256SUMS && bash install.sh --yes --network auto
```

---

## 9. Service Management & Troubleshooting

Inspect service logs via `journalctl`:
```bash
journalctl -u darjeeling.service -n 50 --no-pager
```

Restart or stop the service:
```bash
sudo systemctl restart darjeeling.service
sudo systemctl stop darjeeling.service
```

### Uninstalling

```bash
sudo darjeeling uninstall --purge --remove-user
```

This runs the installed copy of the installer, `/opt/darjeeling/current/install.sh --uninstall`, which you can also call directly:

```bash
sudo bash /opt/darjeeling/current/install.sh --uninstall --purge --remove-user
```

Uninstall stops and removes the systemd units, `/usr/local/bin/darjeeling`, `/opt/darjeeling/releases`, `/opt/darjeeling/current`, `/opt/darjeeling/backups`, the laptop-mode udev and logind files, and `/etc/claude-code/managed-settings.json`. Anything else under `/opt/darjeeling` is left in place. Without `--purge`, your configuration (`/etc/darjeeling`), state and vault (`/var/lib/darjeeling`) are kept.

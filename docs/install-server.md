# Companion Server Installation & Lifecycle Guide

This document describes how to install, configure, verify, upgrade, and maintain the Project Darjeeling companion server daemon (`darjeeling-server`) on Debian and Ubuntu Linux systems.

---

## 1. Supported Operating Systems & Architecture

Darjeeling companion daemon is supported on 64-bit architectures: `x86_64` (GA) and `aarch64` / `arm64` (Beta per OC-15), running:
* **Debian 12 ("Bookworm")** and **Debian 13 ("Trixie")**
* **Ubuntu 22.04 LTS ("Jammy")**, **Ubuntu 24.04 LTS ("Noble")**, and **Ubuntu 26.04 LTS**

### Minimum Requirements
* Systemd service manager
* Python 3.10 or newer (with `python3-venv`)
* Dedicated unprivileged user account (default: `darjeeling`)
* 1 GB available RAM (2 GB+ recommended for concurrent agent turns)

---

## 2. Prerequisites

Install system dependencies via `apt-get`:

```bash
sudo apt-get update && sudo apt-get install -y curl python3 python3-venv systemd
```

---

## 3. Quick Start Installation

Clone the repository or download the release distribution:

<!-- not-run: provided by host or lab runner -->
```bash
git clone https://github.com/darjeeling-agent/darjeeling.git /opt/darjeeling
```

Run the official installer script with desired options:

```bash
sudo bash /home/tester/darjeeling/server/install.sh --yes --network loopback
```

> [!NOTE]
> If installing outside of the test lab, run `sudo bash server/install.sh --yes --network auto` or select your overlay network (`--network tailscale` or `--network meshnet`).

### What the Installer Configures
The installer executes an idempotent, audited setup:
1. **Service User**: Creates the dedicated system service user `darjeeling` (`--user <name>`) with home directory `/var/lib/darjeeling` and shell disabled.
2. **Virtual Environment**: Provisions an isolated Python virtual environment at `/opt/darjeeling/current/venv` with pinned dependencies.
3. **Master Authentication Token**: Generates a 256-bit cryptographically secure token at `/var/lib/darjeeling/.token` (read-only for the service user, mode `0600`).
4. **Configuration**: Writes service environment variables to `/etc/darjeeling/darjeeling.env`.
5. **Systemd Service**: Deploys `/etc/systemd/system/darjeeling.service` configured with sandboxing directives (`ProtectSystem=strict`, `ProtectHome=read-only`, `NoNewPrivileges=yes`, `PrivateTmp=yes`).
6. **Hardware Rules (Laptop Mode)**: Installs `/etc/udev/rules.d/99-darjeeling-battery.rules` on supported hardware to allow setting battery charge thresholds without root.
7. **Service Activation**: Enables and starts `darjeeling.service` on port `8765`.

---

## 4. Verification

Verify that the systemd service is active:

```bash
systemctl is-active darjeeling.service
```

Query the unauthenticated health endpoint:

```bash
curl -fsS http://127.0.0.1:8765/health
```

Query the authenticated `/api/agents` endpoint using the generated bearer token:

```bash
curl -fsS -H "Authorization: Bearer $(cat /var/lib/darjeeling/.token)" http://127.0.0.1:8765/api/agents
```

---

## 5. Installer Options & Flags Reference

You can review all options by passing `--help`:

<!-- not-run: informational command -->
```bash
sudo bash install.sh --help
```

| Flag | Argument | Default | Description |
|---|---|---|---|
| `--yes`, `-y` | none | interactive | Accept all defaults non-interactively. |
| `--dry-run` | none | false | Print execution plan without making filesystem or systemd modifications. |
| `--network` | `<mode>` | `auto` | Network detection mode: `auto`, `tailscale`, `meshnet`, `wireguard`, `lan`, or `loopback`. |
| `--bind` | `<ip>` | derived | Explicit IP address for the daemon to bind to. |
| `--port` | `<port>` | `8765` | TCP port for HTTP and WebSocket listeners. |
| `--user` | `<user>` | `darjeeling` | System user to run the daemon (QA-34). |
| `--tarball` | `<path>` | none | Install from a local pre-built release tarball. |
| `--laptop` | none | auto | Enable battery charge threshold rules and power management. |
| `--no-laptop` | none | auto | Disable laptop power profile checks. |
| `--claude` | `<mode>` | `native` | Claude Code CLI installation mode: `native`, `apt`, or `skip`. |
| `--with-agy` | none | disabled | Install Google Antigravity SDK CLI (experimental). |
| `--vault-sync` | `<mode>` | `none` | Vault synchronization mode: `none` or `obsidian-sync` (OD-25, G-32). |
| `--uninstall` | none | false | Uninstall service units and symlinks. |
| `--purge` | none | false | Used with `--uninstall` to delete configuration and data directories. |
| `--delete-vault` | none | false | Used with `--uninstall` to purge the vault workspace directory. |
| `--remove-user` | none | false | Used with `--uninstall` to remove the service user account. |

---

## 6. Upgrades, Rollbacks & Virtual Environment Repair

### Upgrading the Server
Upgrades verify release checksums against `SHA256SUMS` before touching the running service:

<!-- not-run: operational upgrade command -->
```bash
sudo darjeeling upgrade
```
* The upgrade utility verifies that no agent turns are actively executing before proceeding (use `--force` to override).
* A pre-upgrade health check probes the running instance; if the upgraded version fails health checks, it automatically rolls back to the previous release symlink.

### Rebuilding Virtual Environments After Distro Upgrades (G-46)
When upgrading your underlying Linux distribution (e.g., Debian 12 with Python 3.11 to Debian 13 with Python 3.13), existing virtual environments break because the underlying Python binary is replaced.

Run `darjeeling doctor` to diagnose the condition:
<!-- not-run: diagnostic command -->
```bash
darjeeling doctor
```
If Python version mismatch is detected, repair the virtual environment:
<!-- not-run: repair command -->
```bash
sudo darjeeling upgrade --rebuild-venv
```

---

## 7. Automated Cloud-Init Deployment

For headless virtual machines (AWS, GCP, Hetzner, Proxmox), deploy using `cloud-init`:

<!-- not-run: cloud-init yaml configuration -->
```yaml
#cloud-config
package_update: true
packages:
  - curl
  - python3
  - python3-venv
  - git

runcmd:
  - git clone https://github.com/darjeeling-agent/darjeeling.git /tmp/darjeeling-repo
  - bash /tmp/darjeeling-repo/server/install.sh --yes --network auto
  - rm -rf /tmp/darjeeling-repo
```

---

## 8. Service Management & Troubleshooting

Inspect service logs via `journalctl`:
<!-- not-run: diagnostic command -->
```bash
journalctl -u darjeeling.service -n 50 --no-pager
```

Restart or stop the service:
<!-- not-run: operational command -->
```bash
sudo systemctl restart darjeeling.service
sudo systemctl stop darjeeling.service
```

Uninstall Darjeeling completely:
<!-- not-run: destructive uninstall command -->
```bash
sudo bash /opt/darjeeling/current/server/install.sh --uninstall --purge --remove-user
```

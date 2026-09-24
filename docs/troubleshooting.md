# Troubleshooting Guide by Symptom

This guide helps you diagnose and resolve common connectivity, authentication, and execution issues with Project Darjeeling.

---

## 1. Unreachable Server

**Symptoms:** The host chip displays `Unreachable`, or requests fail with `Network error`, `ECONNREFUSED`, or timeout.

### Check 1: Private Overlay Network Status
- Verify that your overlay VPN (Tailscale, NordVPN Meshnet, or WireGuard) is active and connected on **both** your client device and your companion server.
- On your client device, test network reachability to the host IP (e.g. `ping 100.101.102.103`).

### Check 2: Service Status on the Server
Verify that the `darjeeling.service` systemd daemon is active and running:
<!-- not-run: diagnostic command -->
```bash
systemctl status darjeeling.service
```
If the service is stopped or failed, check recent logs:
<!-- not-run: diagnostic command -->
```bash
journalctl -u darjeeling.service -n 50 --no-pager
```
Restart the service if needed:
<!-- not-run: operational command -->
```bash
sudo systemctl restart darjeeling.service
```

### Check 3: Firewall Configuration
If you use `ufw` on your Linux server, ensure incoming traffic on port `8765` is allowed over your overlay network interface:
<!-- not-run: operational command -->
```bash
sudo ufw allow in on tailscale0 to any port 8765
```

---

## 2. Token Rejected (HTTP 401 / WebSocket 4401)

**Symptoms:** Connection fails with `Token rejected` or WebSocket close code `4401`.

### Resolution: Re-pair the Device
The device token is invalid, expired, or was revoked on the server.
1. On your server, generate a fresh pairing code:
<!-- not-run: operational command -->
```bash
darjeeling pair
```
2. In Obsidian on your device, navigate to **Settings > Darjeeling > Connections**.
3. Select your server, enter the new 8-digit code, and tap **Pair**.

---

## 3. Not Logged In (Agent Authentication Failure)

**Symptoms:** Chat displays `Agent not logged in` or prompts fail immediately with exit code 1.

### Resolution: Authenticate the Service User
The agent CLI must be authenticated under the dedicated service user account (`darjeeling`), not your personal login account:
1. Log in via SSH:
<!-- not-run: operational command -->
```bash
sudo -u darjeeling -i claude login
```
2. Open the printed authorization link in any web browser and complete the login.
3. Alternatively, supply an API key in `/etc/darjeeling/darjeeling.env`:
<!-- not-run: configuration example -->
```ini
ANTHROPIC_API_KEY="sk-ant-..."
```
Then restart the service: `sudo systemctl restart darjeeling.service`.

---

## 4. Server at Capacity (HTTP 429)

**Symptoms:** Turns fail with `Server at capacity (429)` or WebSocket error `at capacity`.

### Resolution:
- The server limits concurrent agent turns (`DARJEELING_MAX_TURNS`, default: `2`) to prevent CPU overload and thermal throttling.
- Wait for current turns to finish, or open the **Conversations** panel and stop any stuck turns.
- If your host machine has adequate CPU cores and RAM, you can increase the cap in `/etc/darjeeling/darjeeling.env`:
<!-- not-run: configuration example -->
```ini
DARJEELING_MAX_TURNS=4
```
Then restart `darjeeling.service`.

---

## 5. Model Differs from Requested (Model Substituted)

**Symptoms:** You selected `claude-sonnet-5`, but the turn header indicates fallback to another model.

### Resolution:
- The agent CLI installed on your server may be an older release that does not recognize newer model identifiers.
- Update the CLI on your companion server:
<!-- not-run: update command -->
```bash
sudo npm update -g @anthropic-ai/claude-code
```

---

## 6. iOS HTTP / WebSocket Failures

**Symptoms:** Connection fails on iPhone or iPad, but works on desktop.

### Resolution:
1. **Hostname vs. IP Literal (ADR-16)**: Apple App Transport Security (ATS) blocks plain `http://` and `ws://` to domain names (e.g. `http://server.local:8765`). On iOS, use either:
   - A numeric IP literal: `http://100.x.y.z:8765`
   - An HTTPS endpoint: `https://workstation.tailnet.ts.net` via Tailscale Serve.
2. **Local Network Permission (G-40)**: If connecting over LAN Wi-Fi, ensure Obsidian has permission to access the local network:
   - Go to iOS **Settings > Obsidian**.
   - Ensure **Local Network** is toggled **ON**.
3. **Conflicting VPNs**: iOS only permits one active VPN at a time. If an external VPN profile disconnected Tailscale or Meshnet, re-enable the mesh VPN in iOS Settings.

---

## 7. Mobile Camera Access & Pairing
**Symptoms:** Mobile Obsidian cannot scan QR codes or open the camera.

### Resolution:
Obsidian Mobile (iOS and Android) operates inside a secure WebView sandbox without camera entitlements (`NSCameraUsageDescription`), so plugins cannot access camera hardware in-app.
Instead, use the universal 8-digit pairing code:
1. Run `darjeeling pair` on your companion server terminal (or click **Generate pairing code** in desktop Darjeeling settings).
2. On your phone or tablet, open Command Palette and select **Darjeeling: Pair with server** (or navigate to **Settings > Darjeeling > Connections**).
3. Enter your Server URL and the 8-digit pairing code, then tap **Pair Device**.


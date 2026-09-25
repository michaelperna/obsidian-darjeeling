# Device Pairing & Authentication

Project Darjeeling uses an authenticated pairing handshake to connect desktop and mobile Obsidian clients to a companion server without exposing raw API keys or sending sensitive master tokens across networks.

---

## 1. How Pairing Works

When connecting a new device:
1. The server (`sudo darjeeling pair`) or an already paired client (`POST /api/pair/code`) generates a temporary **8-digit pairing code**, valid for 10 minutes (600 s). Codes are single use and stored only as hashes.
2. The client submits the 8-digit code along with its device name to `POST /api/pair`.
3. The server validates the code, registers the device, and returns a unique 256-bit device bearer token.
4. The client securely persists the token in local storage (`SecretStorage` or private app storage).

### Brute-force protection
Failed claims are limited per client address: after 10 failures within 10 minutes that address gets `429 Too Many Requests` (with `Retry-After`) until the window passes, and a looser global cap applies across all clients. A wrong guess does not burn anyone else's code, so an attacker cannot lock you out of a code you are about to use. A successful claim clears that address's counter.

---

## 2. Pairing Methods

### A. 8-Digit Pairing Code (Primary & Universal)
Because Obsidian Mobile (iOS and Android) operates inside a sandboxed WebView without OS camera entitlements, plugins cannot access device cameras or scan barcodes in-app. The temporary 8-digit pairing code is the fastest, most reliable way to connect any mobile device or laptop.

1. **Generate a temporary code** (valid for 10 minutes):
   - **On your companion server terminal**:
   ```bash
   sudo darjeeling pair
   # Output:
   # Pairing Code:  4829 1038
   # Valid for:     10 minutes
   ```
   - **Or in desktop Obsidian**: At the end of onboarding or in **Settings > Darjeeling > Connections**, click **Generate pairing code**.

2. **Claim on your phone or secondary device**:
   - Open Obsidian on your phone or tablet.
   - Open the Command Palette (`Cmd/Ctrl+P` or pull down) and select **Darjeeling: Pair with server** (or navigate to **Settings > Darjeeling > Connections**).
   - Enter your Server URL (e.g. `http://100.x.y.z:8765` or `https://workstation.tailnet.ts.net`).
   - Enter the 8-digit pairing code (e.g. `4829 1038`; spaces and dashes are ignored).
   - Tap **Pair Device**.
   - The server validates the code, registers the device, and persists an authenticated bearer token.

### B. Obsidian Protocol Deep Links
If opened via an external browser or deep link:
- A link formatted as `obsidian://darjeeling?action=pair&url=https%3A%2F%2Fworkstation.tailnet.ts.net&code=48291038` opens Obsidian and presents the **Pairing Confirmation Modal** prefilled with host details.
- Tap **Confirm & Pair** to complete authorization.


---

## 3. Managing Connected Devices & Revocation

### Viewing Devices
Open **Settings > Darjeeling > Connections > Devices** to view all active pairings, including:
- Device label (e.g. `MacBook Pro`, `iPhone 16`)
- Pairing date and last active timestamp
- Transport connection status

### Revoking a Device
If a device is lost or decommissioned:
1. Click **Revoke** next to the device entry in settings, or run:
```bash
sudo darjeeling devices revoke <device-id>
```
2. The server invalidates the device token immediately.
3. **Active WebSocket Termination**: Any open agent turns or terminal streams tied to that token are closed instantaneously with WebSocket close code `4401 Token Rejected`.

### Revoking Everything
To disconnect every paired device, list them and revoke each one:
```bash
sudo darjeeling devices list
sudo darjeeling devices revoke <device-id>
```
To also replace the host token in `/var/lib/darjeeling/.token` (the one used by the `legacy` device entry), delete it and restart; the server writes a new one:
```bash
sudo rm /var/lib/darjeeling/.token
sudo systemctl restart darjeeling.service
```
Affected clients see `Token Rejected` and need to pair again.

---

## 4. Multi-Server Environments

Darjeeling allows configuring multiple companion servers (e.g. `lab-desktop`, `cloud-runner`, `home-nas`):
- Add each server via its pairing code or URL in **Settings > Darjeeling > Connections**.
- Switch active hosts at any time via the **Host Selector Chip** in the chat header or through the command palette (`Darjeeling: Switch Host`).

# Device Pairing & Authentication

Project Darjeeling uses an authenticated pairing handshake to connect desktop and mobile Obsidian clients to a companion server without exposing raw API keys or sending sensitive master tokens across networks.

---

## 1. How Pairing Works

When connecting a new device:
1. The server or existing paired client generates a temporary **8-digit pairing code** (valid for 5 minutes).
2. The client submits the 8-digit code along with its device name to `POST /api/pair/claim`.
3. The server validates the code, registers the device, and returns a unique 256-bit device bearer token.
4. The client securely persists the token in local storage (`SecretStorage` or private app storage).

---

## 2. Pairing Methods

### A. QR Code Pairing (Desktop to Mobile)
The fastest way to connect a smartphone or tablet:
1. In desktop Obsidian, open **Settings > Darjeeling > Connections > Pair New Device** (or run `darjeeling pair` on the server terminal).
2. A QR code is displayed encoding a secure deep-link URI:
   `obsidian://darjeeling?action=pair&url=https%3A%2F%2Fworkstation.tailnet.ts.net&code=48291038`
3. Scan the QR code with your phone camera or barcode scanner.
4. Obsidian opens and displays the **Pairing Confirmation Modal**, naming the server and target host URL.
5. Tap **Confirm & Pair** to complete authentication.

### B. Manual Code Entry
If you cannot scan a QR code:
1. On your companion server, generate a code:
<!-- not-run: operational command -->
```bash
darjeeling pair
# Output:
# Temporary pairing code: 4829-1038 (valid for 5 minutes)
```
2. In Obsidian on your phone or laptop:
   - Open **Settings > Darjeeling > Connections**.
   - Enter your server URL (e.g. `https://workstation.tailnet.ts.net` or `http://100.101.102.103:8765`).
   - Enter the 8-digit pairing code.
   - Tap **Pair Device**.

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
<!-- not-run: operational command -->
```bash
darjeeling devices revoke <device-id>
```
2. The server invalidates the device token immediately.
3. **Active WebSocket Termination**: Any open agent turns or terminal streams tied to that token are closed instantaneously with WebSocket close code `4401 Token Rejected`.

### Rotating All Tokens
To reset all credentials and disconnect all paired devices at once:
<!-- not-run: operational command -->
```bash
sudo darjeeling token rotate
```
All connected clients will transition to `Token Rejected` and require re-pairing.

---

## 4. Multi-Server Environments

Darjeeling allows configuring multiple companion servers (e.g. `lab-desktop`, `cloud-runner`, `home-nas`):
- Add each server via its pairing code or URL in **Settings > Darjeeling > Connections**.
- Switch active hosts at any time via the **Host Selector Chip** in the chat header or through the command palette (`Darjeeling: Switch Host`).

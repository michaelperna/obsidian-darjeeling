# Networking & Private Overlays

The Darjeeling companion daemon (`darjeeling-server`) listens by default on port `8765`. To protect vault data, prompts, and authentication tokens in transit without managing public CA certificates or exposed ports, Darjeeling is designed to run exclusively over **encrypted private overlay networks**.

---

## 1. Network Architectures

```
                    ┌───────────────────────────────┐
                    │  Obsidian Client (Mac/Phone)  │
                    └───────────────┬───────────────┘
                                    │
               Encrypted Overlay Network (Peer-to-Peer)
           ┌────────────────────────┼────────────────────────┐
           ▼                        ▼                        ▼
    Tailscale Serve            NordVPN Meshnet           WireGuard / LAN
(wss://node.tailnet.ts.net) (ws://100.x.y.z:8765)  (ws://192.168.x.x:8765)
           │                        │                        │
           └────────────────────────┼────────────────────────┘
                                    ▼
                    ┌───────────────────────────────┐
                    │ darjeeling-server (Port 8765) │
                    └───────────────────────────────┘
```

---

## 2. Recommended: Tailscale Serve

Tailscale provides seamless mesh connectivity with automated TLS certificate provisioning via MagicDNS.

### Setup Steps
1. Install Tailscale on your server and client devices.
2. On your Linux companion server, enable background TLS serving on port 8765:
<!-- not-run: operational command -->
```bash
tailscale serve --bg 8765
```
3. Use the resulting HTTPS URL (e.g. `https://workstation.tailnet.ts.net`) in Darjeeling settings or pairing deep links. WebSockets automatically upgrade to `wss://`.

### Machine Naming & Certificate Transparency (G-41)
> [!IMPORTANT]
> Use a **neutral machine name** for your server (e.g., `workstation`, `dev-node`, `srv-alpha`).
> All TLS certificates issued for Tailscale MagicDNS domains (`*.ts.net`) are published to public Certificate Transparency logs. Do not include personal names, internal project code names, or private vault titles in your machine's hostname.

---

## 3. NordVPN Meshnet

NordVPN Meshnet connects devices directly via encrypted WireGuard tunnels using private `100.x.y.z` IP literals.

### Setup Steps
1. Enable Meshnet on both your server and your client devices.
2. Note your server's Meshnet IP (e.g., `100.101.102.103`).
3. Connect using `http://100.101.102.103:8765`.
4. WebSockets will connect to `ws://100.101.102.103:8765`.

---

## 4. Local Area Network (LAN) & Wi-Fi

When connected to the same home or office Wi-Fi network, you can connect directly to your server's LAN IP address (e.g., `http://192.168.1.50:8765`).

### The iOS Local Network Prompt (G-40)
When accessing a local LAN IP address on iOS or iPadOS, iOS prompts:
`"Obsidian" would like to find and connect to devices on your local network.`
You **must tap "Allow"**. If dismissed or denied, iOS blocks all network calls to LAN endpoints. You can verify or enable this at any time in iOS **Settings > Obsidian > Local Network**.

---

## 5. Mobile & iOS Network Rules (ADR-16)

### A. Apple App Transport Security (ATS) Rules
Apple's ATS security policy enforces specific constraints on iOS:
- **IP Literals Allowed**: ATS exempts numeric IP literals (`100.x.y.z`, `192.168.x.x`, `127.0.0.1`), allowing cleartext `http://` and `ws://` connections.
- **Hostnames Require HTTPS**: ATS blocks cleartext `http://` and `ws://` to domain names or local mDNS names (e.g. `http://my-server.local:8765`).
- **Plugin Enforcement**: If you enter an `http://<hostname>` address on iOS, the plugin displays a helpful notice rather than failing silently, directing you to use either an IP literal or an HTTPS endpoint (such as Tailscale Serve).

### B. Mobile VPN Tunnel Limits
Mobile operating systems (iOS and Android) support only **one active VPN or Network Extension tunnel at a time**.
If you connect your phone to Tailscale or Meshnet, launching another corporate or commercial VPN profile will deactivate the overlay tunnel, temporarily disconnecting your Darjeeling session until the overlay VPN is re-enabled.

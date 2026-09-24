#!/usr/bin/env python3
"""
sync_test.py -- Syncthing verification between client and server vaults.
Validates G-28:
1. Documented .stignore rules prevent .obsidian/, .trash/, and *.tmp from reaching server.
2. Notes written or edited by agents on server sync back to client without being deleted.
3. Client configuration in .obsidian/ is never modified or deleted by sync.
"""
import os
import sys
import time
import shutil
import subprocess
import xml.etree.ElementTree as ET

CLIENT_HOME = "/tmp/st-client-home"
SERVER_HOME = "/tmp/st-server-home"
CLIENT_VAULT = "/tmp/st-client-vault"
SERVER_VAULT = "/tmp/st-server-vault"

def cleanup():
    subprocess.run(["pkill", "-9", "-f", "syncthing"], stderr=subprocess.DEVNULL)
    for p in [CLIENT_HOME, SERVER_HOME, CLIENT_VAULT, SERVER_VAULT]:
        if os.path.exists(p):
            shutil.rmtree(p, ignore_errors=True)

def generate_configs():
    os.makedirs(CLIENT_VAULT, exist_ok=True)
    os.makedirs(SERVER_VAULT, exist_ok=True)
    
    subprocess.run(["syncthing", "generate", f"--home={CLIENT_HOME}"], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["syncthing", "generate", f"--home={SERVER_HOME}"], check=True, stdout=subprocess.DEVNULL)

    # Read device IDs
    client_tree = ET.parse(f"{CLIENT_HOME}/config.xml")
    server_tree = ET.parse(f"{SERVER_HOME}/config.xml")

    client_id = client_tree.find(".//device").attrib["id"]
    server_id = server_tree.find(".//device").attrib["id"]

    print(f"[*] Client Device ID: {client_id[:7]}...")
    print(f"[*] Server Device ID: {server_id[:7]}...")

    # Configure Client
    client_root = client_tree.getroot()
    # Change listen address to avoid conflicts
    for opt in client_root.findall(".//listenAddress"):
        opt.text = "tcp://127.0.0.1:22000"
    for gui in client_root.findall(".//gui/address"):
        gui.text = "127.0.0.1:8384"
    
    # Add server device
    dev = ET.SubElement(client_root, "device", id=server_id, name="server", compression="metadata", introducer="false", skipIntroductionRemovals="false", introducedBy="")
    ET.SubElement(dev, "address").text = "tcp://127.0.0.1:22001"
    
    # Add folder
    f = ET.SubElement(client_root, "folder", id="vault", label="vault", path=CLIENT_VAULT, type="sendreceive", rescanIntervalS="1", fsWatcherEnabled="true", fsWatcherDelayS="1")
    ET.SubElement(f, "device", id=client_id, introducedBy="")
    ET.SubElement(f, "device", id=server_id, introducedBy="")
    client_tree.write(f"{CLIENT_HOME}/config.xml")

    # Configure Server
    server_root = server_tree.getroot()
    for opt in server_root.findall(".//listenAddress"):
        opt.text = "tcp://127.0.0.1:22001"
    for gui in server_root.findall(".//gui/address"):
        gui.text = "127.0.0.1:8385"
    
    # Add client device
    dev = ET.SubElement(server_root, "device", id=client_id, name="client", compression="metadata", introducer="false", skipIntroductionRemovals="false", introducedBy="")
    ET.SubElement(dev, "address").text = "tcp://127.0.0.1:22000"
    
    # Add folder
    f = ET.SubElement(server_root, "folder", id="vault", label="vault", path=SERVER_VAULT, type="sendreceive", rescanIntervalS="1", fsWatcherEnabled="true", fsWatcherDelayS="1")
    ET.SubElement(f, "device", id=server_id, introducedBy="")
    ET.SubElement(f, "device", id=client_id, introducedBy="")
    server_tree.write(f"{SERVER_HOME}/config.xml")

def seed_client_vault():
    # Documented .stignore from docs/vault-sync.md
    stignore_content = "(?d).obsidian\n(?d).obsidian/**\n(?d).trash\n(?d).trash/**\n(?d)*.tmp\n"
    with open(f"{CLIENT_VAULT}/.stignore", "w") as fp:
        fp.write(stignore_content)

    with open(f"{CLIENT_VAULT}/Garden plan.md", "w") as fp:
        fp.write("# Garden Plan\n- [ ] Plant tomatoes\n")
    with open(f"{CLIENT_VAULT}/Reading list.md", "w") as fp:
        fp.write("# Reading List\n- Kleppmann\n")

    # Sensitive client config that MUST NEVER reach server
    os.makedirs(f"{CLIENT_VAULT}/.obsidian/plugins/darjeeling", exist_ok=True)
    with open(f"{CLIENT_VAULT}/.obsidian/plugins/darjeeling/data.json", "w") as fp:
        fp.write('{"authToken": "secret-meshnet-token"}\n')

    os.makedirs(f"{CLIENT_VAULT}/.trash", exist_ok=True)
    with open(f"{CLIENT_VAULT}/.trash/deleted.md", "w") as fp:
        fp.write("# Discarded\n")

    with open(f"{CLIENT_VAULT}/draft.tmp", "w") as fp:
        fp.write("temporary draft\n")

def main():
    print("=== Syncthing Vault Sync Isolation Check (G-28) ===")
    cleanup()
    
    print("[1/4] Generating Syncthing configs and seeding client vault...")
    generate_configs()
    seed_client_vault()

    print("[2/4] Starting Syncthing daemons...")
    c_proc = subprocess.Popen(["syncthing", "serve", f"--home={CLIENT_HOME}", "--no-browser", "--no-restart"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    s_proc = subprocess.Popen(["syncthing", "serve", f"--home={SERVER_HOME}", "--no-browser", "--no-restart"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        # Wait for sync to server
        print("[3/4] Waiting for initial sync to server...")
        synced = False
        for _ in range(30):
            if os.path.exists(f"{SERVER_VAULT}/Garden plan.md") and os.path.exists(f"{SERVER_VAULT}/Reading list.md"):
                synced = True
                break
            time.sleep(1)

        if not synced:
            print("FAIL: Initial notes failed to sync to server within 30s")
            return 1
        print("  ✓ Notes synced to server (Garden plan.md, Reading list.md)")

        # Verify exclusions
        if os.path.exists(f"{SERVER_VAULT}/.obsidian"):
            print("FAIL (CRITICAL): .obsidian/ directory leaked to server vault!")
            return 1
        print("  ✓ PASS: .obsidian/ was NOT synced to server")

        if os.path.exists(f"{SERVER_VAULT}/.trash"):
            print("FAIL: .trash/ was synced to server")
            return 1
        print("  ✓ PASS: .trash/ was NOT synced to server")

        if os.path.exists(f"{SERVER_VAULT}/draft.tmp"):
            print("FAIL: *.tmp was synced to server")
            return 1
        print("  ✓ PASS: *.tmp was NOT synced to server")

        # Simulate agent writing files on server
        print("[4/4] Simulating agent creating and modifying notes on server...")
        with open(f"{SERVER_VAULT}/Agent Summary.md", "w") as fp:
            fp.write("# Sprint Summary\nGenerated by Darjeeling Companion Server.\n")
        with open(f"{SERVER_VAULT}/Garden plan.md", "a") as fp:
            fp.write("- [x] Planted tomatoes (agent confirmed)\n")

        # Wait for sync back to client
        agent_synced = False
        for _ in range(30):
            if os.path.exists(f"{CLIENT_VAULT}/Agent Summary.md"):
                with open(f"{CLIENT_VAULT}/Garden plan.md") as fp:
                    if "agent confirmed" in fp.read():
                        agent_synced = True
                        break
            time.sleep(1)

        if not agent_synced:
            print("FAIL: Agent changes failed to sync back to client")
            return 1
        print("  ✓ PASS: Agent note synced back to client without deletion")

        # Verify client .obsidian is intact
        with open(f"{CLIENT_VAULT}/.obsidian/plugins/darjeeling/data.json") as fp:
            data = fp.read()
            if "secret-meshnet-token" not in data:
                print("FAIL: Client .obsidian configuration was corrupted or deleted!")
                return 1
        print("  ✓ PASS: Client .obsidian config remained 100% intact")

        print("\n=== SUCCESS: All Syncthing vault sync isolation checks passed! ===")
        return 0

    finally:
        c_proc.terminate()
        s_proc.terminate()
        cleanup()

if __name__ == "__main__":
    sys.exit(main())

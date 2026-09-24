# Vault Synchronization & File Safety

When using the remote companion server, agents run directly against a working directory on your server. To see changes immediately on your desktop or phone, you will need a file synchronization strategy between your devices and your server.

---

## 1. The Core Rule: Exclude `.obsidian/` (G-30)

> [!CAUTION]
> **You must strictly exclude the entire `.obsidian/` directory in both directions across all synchronization tools.**

### Why `.obsidian/` Must Be Excluded:
1. **Security Isolation**: Agents executing commands on the server must never have a write path that automatically deploys JavaScript plugins or CSS snippets (`.obsidian/plugins/`, `.obsidian/snippets/`) to your personal desktop and mobile devices.
2. **Platform Incompatibilities**: Obsidian configuration files contain device-specific window states, zoom levels, and cache indices that conflict when shared between headless Linux servers and mobile touchscreens.

---

## 2. Sync Engines

### Option A: Syncthing (Recommended Self-Hosted)
Syncthing provides continuous, peer-to-peer encrypted synchronization across desktop, Android, and Linux servers.

Create a `.stignore` file in the root of your vault on every device:

<!-- not-run: configuration example -->
```
(?d).obsidian
(?d).obsidian/**
(?d).trash
(?d).trash/**
(?d)*.tmp
```

### Option B: Obsidian Headless Sync
If you subscribe to official Obsidian Sync, you can run the headless Obsidian CLI sync client on your Linux server:

> [!IMPORTANT]
> **Run as a Separate Dedicated Sync User (OD-25)**:
> Do not run Obsidian Headless under the `darjeeling` service account. Create a separate, isolated system user (e.g., `obssync`) with read/write access only to the vault folder.

In your Obsidian Sync settings:
- **Disable Configuration Sync**: Ensure Sync settings, Core plugin settings, Community plugins, Installed themes, and Snippets are toggled **OFF**.
- Enable only: Notes and Media files.

### Option C: Git
For version-controlled vaults:
1. Initialize a git repository in your vault.
2. Add `.obsidian/` to `.gitignore`:
<!-- not-run: configuration example -->
```gitignore
# .gitignore
.obsidian/
.trash/
```
3. Use a post-commit hook or periodic pull/commit job to keep branches synchronized.

---

## 3. The `rsync` Warning: Never Use `--delete` (DOC-09)

> [!WARNING]
> **Never use `rsync --delete` to sync your vault to the server.**

If an AI agent generates new notes, architectural plans, or project code on the server, running `rsync -av --delete ~/vault/ server:~/vault/` will treat those newly created files as "untracked extra files" and **permanently delete all agent outputs**.

`rsync` should only be used as a one-time initial seed:
<!-- not-run: one-time migration command -->
```bash
# Safe: one-time initial copy without --delete
rsync -avP --exclude='.obsidian' ~/MyVault/ darjeeling@server:~/vault/
```

---

## 4. What a Phone-Only User Needs (G-53)

If you use Obsidian exclusively on an iPhone, iPad, or Android phone without a personal computer:
- **iOS / iPadOS**: Use official **Obsidian Sync** paired with an Obsidian Headless runner on your server (with `.obsidian/` excluded), or sync Markdown repositories via **Working Copy** (git).
- **Android**: Use **Syncthing-Fork** from F-Droid to continuously sync your vault folder directly with your companion server using the `.stignore` rules above.

# Desktop Local Mode

Desktop Local Mode allows you to run CLI agents (`claude`, `agy`) and an embedded interactive PTY terminal directly on your desktop computer, using your local CPU and environment without a companion server.

---

## 1. Operating System Support

| Platform | Local Mode Support | Notes |
|---|---|---|
| **macOS** | **Supported** | Tested on macOS 14 & 15 (Apple Silicon & Intel). |
| **Linux Desktop** | **Supported** | Tested on modern Linux distributions (systemd, glibc). |
| **Windows Desktop** | **Untested** | May work via WSL; marked untested in 1.0 (G-57). |
| **iOS / Android** | **Not Supported** | Mobile operating systems forbid spawning local subprocesses. Use Direct API mode or the Companion Server. |

---

## 2. Environment & PATH Detection

Desktop applications launched via graphical launchers (such as macOS Spotlight or Dock) do not inherit environment variables from your shell dotfiles (`~/.zshrc`, `~/.bashrc`, `~/.profile`).

To find CLI tools like `claude`, `git`, or `node`:
- Darjeeling executes an asynchronous login shell query on startup (`$SHELL -l -c 'echo $PATH'`).
- Discovered paths are merged with standard binary directories (`/usr/local/bin`, `/opt/homebrew/bin`, `~/.cargo/bin`, `~/.nvm/versions/node/*/bin`).
- Results are cached in memory, ensuring zero UI blocking during normal vault operation.

---

## 3. Local Terminal Requirements: Python 3

To provide a fully-functional interactive terminal (with ANSI truecolor, raw cursor control, and terminal signals) without compiling fragile native C++ node-gyp extensions inside Obsidian, the local terminal bridge utilizes Python's built-in `pty` library:

- **Prerequisite**: `python3` must be installed and accessible on your system PATH.
- Verify in your terminal:
<!-- not-run: check command -->
```bash
python3 --version
```
If Python 3 is missing, install it via Homebrew (`brew install python3` on macOS) or your Linux package manager (`sudo apt install python3`).

---

## 4. Working Directory & Filesystem Access

- **Working Directory**: Local agents are spawned with their current working directory (`cwd`) set to the root of your active Obsidian vault.
- **Privilege Boundary**: Subprocesses run with your personal user account permissions. They have access to read and edit files according to the selected permission mode (`plan`, `acceptEdits`, or `bypassPermissions`).

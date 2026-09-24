#!/usr/bin/env bash
# make-4.1.0-layout.sh -- Replays the captured 4.1.0 installer layout
# Used by test suites and lab upgrade/migration scenarios (G-19).
set -Eeuo pipefail

TARGET_ROOT="${1:-}"
USER_NAME="${2:-darjeeling}"
HOME_DIR="${3:-/home/$USER_NAME}"

if [ -n "$TARGET_ROOT" ]; then
    TARGET_HOME="$TARGET_ROOT$HOME_DIR"
    TARGET_ETC="$TARGET_ROOT/etc"
    TARGET_BIN="$TARGET_ROOT/usr/local/bin"
else
    TARGET_HOME="$HOME_DIR"
    TARGET_ETC="/etc"
    TARGET_BIN="/usr/local/bin"
fi

SRV_DIR="$TARGET_HOME/darjeeling-server"
UNIT_DIR="$TARGET_ETC/systemd/system"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAYOUT_DIR="$SCRIPT_DIR/layout-4.1.0"

mkdir -p "$SRV_DIR" "$TARGET_HOME/vault" "$UNIT_DIR" "$TARGET_BIN"
mkdir -p "$TARGET_HOME/.bun/bin" "$TARGET_HOME/.npm-global/bin" "$SRV_DIR/venv/bin"

# Install unit file
cp "$LAYOUT_DIR/darjeeling.service" "$UNIT_DIR/darjeeling.service"
sed -i.bak -e "s|User=darjeeling|User=$USER_NAME|g" \
    -e "s|/home/darjeeling|$HOME_DIR|g" \
    "$UNIT_DIR/darjeeling.service" && rm -f "$UNIT_DIR/darjeeling.service.bak"
chmod 0644 "$UNIT_DIR/darjeeling.service"

# Install config.env and token
cp "$LAYOUT_DIR/config.env" "$SRV_DIR/config.env"
sed -i.bak -e "s|/home/darjeeling|$HOME_DIR|g" "$SRV_DIR/config.env" && rm -f "$SRV_DIR/config.env.bak"
chmod 0600 "$SRV_DIR/config.env"

TOKEN=$(sed -n "s/^DARJEELING_TOKEN=//p" "$SRV_DIR/config.env" | head -n 1)
printf '%s\n' "$TOKEN" >"$SRV_DIR/.token"
chmod 0600 "$SRV_DIR/.token"

# Dummy server files
printf '# requirements.txt\nfastapi>=0.110.0\nuvicorn>=0.28.0\n' >"$SRV_DIR/requirements.txt"
chmod 0644 "$SRV_DIR/requirements.txt"
cat << 'EOF' > "$SRV_DIR/server.py"
#!/usr/bin/env python3
import http.server
import os
import sys

PORT = int(os.environ.get("DARJEELING_PORT", 8765))
TOKEN = os.environ.get("DARJEELING_TOKEN", "")

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        auth = self.headers.get("Authorization", "")
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok","legacy":true}')
        elif auth == f"Bearer {TOKEN}":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"authenticated":true,"legacy":true}')
        else:
            self.send_response(401)
            self.end_headers()
            self.wfile.write(b'Unauthorized')

    def log_message(self, format, *args):
        pass

if __name__ == "__main__":
    http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
EOF
chmod 0755 "$SRV_DIR/server.py"

# Dummy bun
cat >"$TARGET_HOME/.bun/bin/bun" <<'EOF'
#!/bin/sh
echo "bun 1.4.2"
EOF
chmod 0755 "$TARGET_HOME/.bun/bin/bun"
ln -sf "$HOME_DIR/.bun/bin/bun" "$TARGET_HOME/.bun/bin/bunx"
ln -sf "$HOME_DIR/.bun/bin/bun" "$TARGET_BIN/bun"

# Dummy claude
cat >"$TARGET_HOME/.npm-global/bin/claude" <<'EOF'
#!/bin/sh
echo "2.1.280 (Claude Code)"
EOF
chmod 0755 "$TARGET_HOME/.npm-global/bin/claude"
ln -sf "$HOME_DIR/.npm-global/bin/claude" "$TARGET_BIN/claude"

# Dummy tmux.conf
cat >"$TARGET_HOME/.tmux.conf" <<'EOF'
set -g mouse on
set -g status-left "[darjeeling] "
EOF
chmod 0644 "$TARGET_HOME/.tmux.conf"

# Dummy venv python
cat >"$SRV_DIR/venv/bin/python" <<'EOF'
#!/bin/sh
exec python3 "$@"
EOF
chmod 0755 "$SRV_DIR/venv/bin/python"
ln -sf python "$SRV_DIR/venv/bin/python3"

# Fix ownership if user exists on system
if id "$USER_NAME" >/dev/null 2>&1; then
    chown -R "$USER_NAME:$USER_NAME" "$TARGET_HOME/.bun" "$TARGET_HOME/.npm-global" "$SRV_DIR" "$TARGET_HOME/.tmux.conf" "$TARGET_HOME/vault"
fi

echo "Created 4.1.0 layout for $USER_NAME at $SRV_DIR"

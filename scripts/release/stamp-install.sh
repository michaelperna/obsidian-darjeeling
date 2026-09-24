#!/usr/bin/env bash
# Embeds DJ_VERSION and TARBALL_SHA256 into dist/install.sh
set -Eeuo pipefail

VERSION="${1:-1.0.0}"
TARBALL_SHA256="${2:-}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

mkdir -p "$ROOT_DIR/dist"

if [[ -z "$TARBALL_SHA256" && -f "$ROOT_DIR/dist/darjeeling-server-${VERSION}.tar.gz" ]]; then
    if command -v sha256sum >/dev/null 2>&1; then
        TARBALL_SHA256="$(sha256sum "$ROOT_DIR/dist/darjeeling-server-${VERSION}.tar.gz" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
        TARBALL_SHA256="$(shasum -a 256 "$ROOT_DIR/dist/darjeeling-server-${VERSION}.tar.gz" | awk '{print $1}')"
    fi
fi

echo "Stamping dist/install.sh with DJ_VERSION=${VERSION} and TARBALL_SHA256=${TARBALL_SHA256}"

sed -e "s|^DJ_VERSION=.*|DJ_VERSION=\"${VERSION}\"|" \
    -e "s|^TARBALL_SHA256=.*|TARBALL_SHA256=\"${TARBALL_SHA256}\"|" \
    "$ROOT_DIR/server/install.sh" > "$ROOT_DIR/dist/install.sh"

chmod +x "$ROOT_DIR/dist/install.sh"
echo "Stamped dist/install.sh ready."

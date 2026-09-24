#!/usr/bin/env bash
# Produces reproducible dist/darjeeling-server-<version>.tar.gz and stamped dist/install.sh
set -Eeuo pipefail

VERSION="${1:-1.0.0-dev}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"

mkdir -p "$DIST_DIR"

# Determine reproducible SOURCE_DATE_EPOCH
if [[ -z "${SOURCE_DATE_EPOCH:-}" ]]; then
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        SOURCE_DATE_EPOCH="$(git log -1 --format=%ct 2>/dev/null || date +%s)"
    else
        SOURCE_DATE_EPOCH="$(date +%s)"
    fi
fi
export SOURCE_DATE_EPOCH

STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

echo "Staging release files for darjeeling-server-${VERSION}..."
cp -R "$ROOT_DIR/server/darjeeling_server" "$STAGE_DIR/"
cp "$ROOT_DIR/server/requirements.lock" "$STAGE_DIR/"
cp -R "$ROOT_DIR/server/units" "$STAGE_DIR/"
cp "$ROOT_DIR/server/tmux.conf" "$STAGE_DIR/"
cp -R "$ROOT_DIR/server/bin" "$STAGE_DIR/"
cp -R "$ROOT_DIR/server/udev" "$STAGE_DIR/"
cp -R "$ROOT_DIR/server/catalog" "$STAGE_DIR/"
mkdir -p "$STAGE_DIR/config"
cp "$ROOT_DIR/server/config/darjeeling.env.example" "$STAGE_DIR/config/"
cp "$ROOT_DIR/server/pyproject.toml" "$STAGE_DIR/"
cp "$ROOT_DIR/LICENSE" "$STAGE_DIR/"
cp "$ROOT_DIR/server/install.sh" "$STAGE_DIR/"
echo "$VERSION" > "$STAGE_DIR/VERSION"

# Clean any __pycache__ or temporary files
find "$STAGE_DIR" -name "__pycache__" -type d -exec rm -rf {} +
find "$STAGE_DIR" -name "*.pyc" -delete

OUTPUT_TARBALL="$DIST_DIR/darjeeling-server-${VERSION}.tar.gz"

echo "Building reproducible tarball at $OUTPUT_TARBALL (mtime=${SOURCE_DATE_EPOCH})..."

# Use python helper to ensure 100% byte reproducibility across Linux (GNU) and macOS (BSD)
python3 - "$STAGE_DIR" "$OUTPUT_TARBALL" "$SOURCE_DATE_EPOCH" << 'EOF'
import sys
import os
import tarfile
import gzip

staging_dir = sys.argv[1]
output_file = sys.argv[2]
epoch = int(sys.argv[3])

temp_tar = output_file + ".tmp.tar"
with tarfile.open(temp_tar, "w", format=tarfile.PAX_FORMAT) as tar:
    for root, dirs, files in os.walk(staging_dir):
        dirs.sort()
        files.sort()
        for d in dirs:
            full_path = os.path.join(root, d)
            rel_path = os.path.relpath(full_path, staging_dir)
            tarinfo = tar.gettarinfo(full_path, arcname=rel_path)
            tarinfo.uid = 0
            tarinfo.gid = 0
            tarinfo.uname = ""
            tarinfo.gname = ""
            tarinfo.mtime = epoch
            tarinfo.mode = 0o755
            tar.addfile(tarinfo)
        for f in files:
            full_path = os.path.join(root, f)
            rel_path = os.path.relpath(full_path, staging_dir)
            tarinfo = tar.gettarinfo(full_path, arcname=rel_path)
            tarinfo.uid = 0
            tarinfo.gid = 0
            tarinfo.uname = ""
            tarinfo.gname = ""
            tarinfo.mtime = epoch
            if os.access(full_path, os.X_OK):
                tarinfo.mode = 0o755
            else:
                tarinfo.mode = 0o644
            with open(full_path, "rb") as fp:
                tar.addfile(tarinfo, fp)

with open(temp_tar, "rb") as f_in:
    with open(output_file, "wb") as f_out:
        with gzip.GzipFile(filename="", mode="wb", fileobj=f_out, mtime=0) as gz:
            while True:
                chunk = f_in.read(65536)
                if not chunk:
                    break
                gz.write(chunk)

os.remove(temp_tar)
EOF

if command -v sha256sum >/dev/null 2>&1; then
    SHA="$(sha256sum "$OUTPUT_TARBALL" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
    SHA="$(shasum -a 256 "$OUTPUT_TARBALL" | awk '{print $1}')"
else
    SHA="$(python3 -c "import hashlib; print(hashlib.sha256(open('$OUTPUT_TARBALL', 'rb').read()).hexdigest())")"
fi

echo "SHA256: $SHA"
echo "$SHA  darjeeling-server-${VERSION}.tar.gz" > "$DIST_DIR/darjeeling-server-${VERSION}.tar.gz.sha256"

# Stamp dist/install.sh
"$ROOT_DIR/scripts/release/stamp-install.sh" "$VERSION" "$SHA"

echo "Build complete."

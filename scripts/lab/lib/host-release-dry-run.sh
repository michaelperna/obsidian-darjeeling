#!/usr/bin/env bash
# Host side of `lab.sh release-dry-run`. Runs in the CI container on the lab host:
#   bash ~/dj-lab/release-dry-run/<run>/scripts/lab/lib/host-release-dry-run.sh <run> <version>
set -euo pipefail

LAB_RUN=${1:?usage: host-release-dry-run.sh <run-id> <version>}
VERSION=${2:-1.0.0}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR source=host-common.sh
. "$HERE/host-common.sh"

TREE="$LAB_DIR/release-dry-run/$LAB_RUN"
OUT="$TREE/_lab"
NAME="dj-lab-release-dry-run-$LAB_RUN"
IMAGE="localhost/dj-lab/ci:node22"
[ -f "$TREE/package.json" ] || die "no synced tree at $TREE"
mkdir -p "$OUT"

cleanup() {
    podman rm -f "$NAME" >/dev/null 2>&1 || true
    release_slot_marker
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

acquire_slot
reap_stale

if ! ensure_image "$IMAGE" "$TREE/scripts/lab/images/Containerfile.ci" \
    "$TREE/scripts/lab/images" "BASE=docker.io/library/node:22-bookworm" \
    >"$OUT/image-build.log" 2>&1; then
    tail -n 30 "$OUT/image-build.log" >&2
    die "CI image build failed (log: $OUT/image-build.log)"
fi
ensure_volume dj-lab-npm-cache
ensure_volume dj-lab-pip-cache

wait_container_budget
set_labels release-dry-run
log "running release dry-run container $NAME (${LAB_CPUS} cpu, ${LAB_MEM})"

set +e
podman run --rm --name "$NAME" "${LAB_LABELS[@]}" \
    --memory "$LAB_MEM" --cpus "$LAB_CPUS" --pids-limit 4096 \
    -v "$TREE:/work" \
    -v dj-lab-npm-cache:/root/.npm \
    -v dj-lab-pip-cache:/root/.cache/pip \
    -e DJ_LAB_RUN="$LAB_RUN" \
    -e RELEASE_VERSION="$VERSION" \
    -e DJ_LAB_IN_CONTAINER=1 \
    "$IMAGE" bash -c '
set -euo pipefail
cd /work
export SOURCE_DATE_EPOCH=1700000000

echo "=== Release Dry-Run: Build 1 ==="
npm ci --ignore-scripts
npm run build
npm test

python3 -m venv /tmp/venv
/tmp/venv/bin/pip install --upgrade pip
/tmp/venv/bin/pip install --require-hashes -r server/requirements.lock
/tmp/venv/bin/pip install pytest pyflakes
/tmp/venv/bin/pyflakes server/
/tmp/venv/bin/pytest -v tests/server/

./scripts/release/build-server-tarball.sh "$RELEASE_VERSION"

cd dist
sha256sum ../main.js ../manifest.json ../styles.css "darjeeling-server-${RELEASE_VERSION}.tar.gz" install.sh > /tmp/SHA256SUMS.1
cd /work

echo "=== Release Dry-Run: Build 2 (Clean Rebuild) ==="
rm -rf dist main.js styles.css
npm run build
./scripts/release/build-server-tarball.sh "$RELEASE_VERSION"

cd dist
sha256sum ../main.js ../manifest.json ../styles.css "darjeeling-server-${RELEASE_VERSION}.tar.gz" install.sh > /tmp/SHA256SUMS.2

echo "=== Comparing SHA256SUMS across builds ==="
if diff -u /tmp/SHA256SUMS.1 /tmp/SHA256SUMS.2; then
    echo "PASS: Release assets are 100% byte-reproducible across builds!"
    cp /tmp/SHA256SUMS.2 SHA256SUMS
else
    echo "FAIL: Non-reproducible build output detected!"
    exit 1
fi

# Verify embedded hash in install.sh matches
TARBALL_SHA=$(sha256sum "darjeeling-server-${RELEASE_VERSION}.tar.gz" | cut -d" " -f1)
if grep -q "TARBALL_SHA256=\"$TARBALL_SHA\"" install.sh; then
    echo "PASS: install.sh embeds matching TARBALL_SHA256 ($TARBALL_SHA)"
else
    echo "FAIL: install.sh TARBALL_SHA256 does not match tarball hash ($TARBALL_SHA)!"
    exit 1
fi

# Build dry-run manual zip
python3 -c "
import zipfile, sys
with zipfile.ZipFile(\"darjeeling-${RELEASE_VERSION}.zip\", \"w\", compression=zipfile.ZIP_DEFLATED) as z:
    z.write(\"../main.js\", \"main.js\")
    z.write(\"../manifest.json\", \"manifest.json\")
    z.write(\"../styles.css\", \"styles.css\")
print(\"PASS: Built darjeeling-${RELEASE_VERSION}.zip manual test bundle\")
"

echo "=== Release Dry-Run Complete ==="
cat SHA256SUMS
'
rc=$?
set -e

prune_runs release-dry-run "${DJ_LAB_KEEP_RUNS:-8}"
log "logs: $LAB_DIR/release-dry-run/$LAB_RUN/_lab/"
exit "$rc"

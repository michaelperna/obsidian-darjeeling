#!/bin/bash
# make-public-tree.sh -- Fresh-root public repository generator and verifier (S4-E1, PLAN.md:1408, PRIV-02, PRIV-06)
#
# Copies git ls-files to a fresh root scratch repo, initializes single-commit history
# under public noreply identity, verifies zero leaks/secrets, clones to a secondary test
# workspace, and verifies npm ci, build, and unit tests.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

OUT_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out|-o)
      OUT_DIR="$2"
      shift 2
      ;;
    *)
      if [[ -z "$OUT_DIR" ]]; then
        OUT_DIR="$1"
        shift
      else
        echo "Unknown argument: $1" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/darjeeling-public-root-XXXXXX")"
else
  mkdir -p "$OUT_DIR"
fi

PUBLIC_EMAIL="${DJ_PUBLIC_EMAIL:-darjeeling@users.noreply.github.com}"
PUBLIC_NAME="${DJ_PUBLIC_NAME:-Project Darjeeling}"

echo "==> Preparing fresh-root public tree at: $OUT_DIR"
echo "==> Source repository: $REPO_ROOT"

# Clean destination scratch directory
rm -rf "${OUT_DIR:?}"/* "${OUT_DIR:?}"/.[!.]* 2>/dev/null || true

# 1. Copy only git-tracked files (git ls-files)
echo "==> Copying tracked files via git archive / tar..."
(cd "$REPO_ROOT" && git archive --format=tar HEAD) | (cd "$OUT_DIR" && tar -xf -)

# 2. Initialize fresh git repo with single commit
echo "==> Initializing fresh git repository with single public commit..."
(
  cd "$OUT_DIR"
  git init -b main
  git config user.name "$PUBLIC_NAME"
  git config user.email "$PUBLIC_EMAIL"
  git add -A
  git commit -m "Darjeeling 1.0.0"
)

# 3. Verify exactly one commit
COMMIT_COUNT=$(git -C "$OUT_DIR" rev-list --count HEAD)
if [[ "$COMMIT_COUNT" -ne 1 ]]; then
  echo "FAIL: Fresh-root repository has $COMMIT_COUNT commits (expected 1)" >&2
  exit 1
fi

COMMIT_AUTHOR=$(git -C "$OUT_DIR" log --all --format='%an <%ae>')
echo "==> Fresh-root commit author: $COMMIT_AUTHOR"
if [[ "$COMMIT_AUTHOR" != *"$PUBLIC_EMAIL"* ]]; then
  echo "FAIL: Commit author $COMMIT_AUTHOR does not match expected public email $PUBLIC_EMAIL" >&2
  exit 1
fi

# 4. Run scrub-guard on the fresh root
echo "==> Running scrub-guard on fresh-root tree..."
(cd "$OUT_DIR" && bash scripts/ci/scrub-guard.sh)

# 5. Clone scratch repo to an isolated verification directory
VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/darjeeling-public-verify-XXXXXX")"
echo "==> Cloning fresh root to verification workspace: $VERIFY_DIR"
git clone "$OUT_DIR" "$VERIFY_DIR"

echo "==> Installing dependencies in clean clone..."
npm --prefix "$VERIFY_DIR" ci

echo "==> Building plugin in clean clone..."
npm --prefix "$VERIFY_DIR" run build

echo "==> Running test suite in clean clone..."
npm --prefix "$VERIFY_DIR" test

echo "==> Running CSS linter..."
node "$VERIFY_DIR/scripts/ci/css-lint.mjs"

echo "==> Checking bundle size limits..."
node "$VERIFY_DIR/scripts/ci/bundle-size.mjs"

# Cleanup verify directory
rm -rf "$VERIFY_DIR"

echo ""
echo "================================================================="
echo "✅ Fresh-root public tree successfully generated and verified!"
echo "Tree path:     $OUT_DIR"
echo "Commit:        $(git -C "$OUT_DIR" rev-parse HEAD)"
echo "Commit Author: $COMMIT_AUTHOR"
echo "Commit Count:  $COMMIT_COUNT"
echo "Remotes:       None (PRIV-02/PRIV-06 enforced)"
echo "================================================================="

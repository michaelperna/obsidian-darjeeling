#!/usr/bin/env bash
# scrub-guard.sh -- Fail when the tree contains personal or private data.
#
# Usage:
#   scripts/ci/scrub-guard.sh [--self-test] [--allowlist PATH] [DIR...]
#
# Built-in rules catch generic leaks (home-directory paths, private-network
# addresses outside the documentation ranges, private keys). Project-specific
# patterns -- names, employers, hostnames you never want published -- must
# NOT live in this repository, since a published pattern list leaks exactly
# what it guards. Supply them privately, one `name=regex` per line, via:
#
#   - the file scripts/ci/scrub-guard.patterns.local (gitignored), or
#   - the SCRUB_GUARD_PATTERNS environment variable (e.g. a CI secret).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ALLOWLIST="${REPO_ROOT}/scripts/ci/scrub-guard.allowlist"
LOCAL_PATTERNS="${REPO_ROOT}/scripts/ci/scrub-guard.patterns.local"
SELF_TEST=0
DIRS=()

while [ $# -gt 0 ]; do
    case "$1" in
        --self-test)
            SELF_TEST=1
            shift
            ;;
        --allowlist)
            ALLOWLIST="${2:?--allowlist requires a path}"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [--self-test] [--allowlist PATH] [DIR...]"
            exit 0
            ;;
        *)
            DIRS+=("$1")
            shift
            ;;
    esac
done

if [ ${#DIRS[@]} -eq 0 ]; then
    DIRS=("$REPO_ROOT")
fi

python3 - "$SELF_TEST" "$ALLOWLIST" "$LOCAL_PATTERNS" "${DIRS[@]}" << 'PY'
import fnmatch
import os
import re
import sys
from pathlib import Path

# 100.64.0.0/10 (CGNAT: Tailscale, Meshnet) except 100.64.0.0/24, which the
# docs and tests use as placeholders, Tailscale's documented example address
# 100.101.102.103, its 100.100.100.100 resolver, and the range's upper bound.
CGNAT = re.compile(
    r'\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b'
)
CGNAT_OK = re.compile(
    r'100\.64\.0\.\d{1,3}|100\.100\.100\.100|100\.101\.102\.103|100\.127\.255\.255'
)

BUILTIN = [
    ("Home path", re.compile(r'/Users/[A-Za-z0-9_.-]+')),
    ("Private key", re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----')),
]


def load_extra(local_path):
    lines = []
    if os.path.exists(local_path):
        with open(local_path, "r", encoding="utf-8") as f:
            lines += f.read().splitlines()
    lines += os.environ.get("SCRUB_GUARD_PATTERNS", "").splitlines()
    extra = []
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, regex = line.split("=", 1)
        extra.append((name.strip(), re.compile(regex.strip())))
    return extra


def match(line, patterns):
    for m in CGNAT.finditer(line):
        if not CGNAT_OK.fullmatch(m.group(0)):
            return "Private network address"
    for name, pat in patterns:
        if pat.search(line):
            return name
    return None


def run_self_test():
    patterns = BUILTIN + [("Example", re.compile(r'\bAcmeCorp\b'))]
    negatives = [
        "This is a prompt for the model.",
        "Connecting to 100.64.0.10:8765",
        "Tailscale DNS is 100.100.100.100",
        "HOME=/home/darjeeling",
        "acmecorporate is not a match",
    ]
    positives = [
        ("Connecting to 100.101.4.2...", "Private network address"),
        ("Found at /Users/someone/vault", "Home path"),
        ("-----BEGIN OPENSSH PRIVATE KEY-----", "Private key"),
        ("Welcome to AcmeCorp.", "Example"),
    ]
    for text in negatives:
        got = match(text, patterns)
        if got:
            print(f"FAIL: '{text}' falsely matched '{got}'")
            sys.exit(1)
    for text, expected in positives:
        got = match(text, patterns)
        if got != expected:
            print(f"FAIL: '{text}' expected '{expected}', got '{got}'")
            sys.exit(1)
    print("scrub-guard: self-test PASS")
    sys.exit(0)


self_test_flag = int(sys.argv[1])
allowlist_path = sys.argv[2]
local_path = sys.argv[3]
search_dirs = sys.argv[4:]

if self_test_flag:
    run_self_test()

extra = load_extra(local_path)
patterns = BUILTIN + extra
print(f"scrub-guard: {len(BUILTIN)} built-in rules + {len(extra)} private pattern(s)")

allowrules = []
if os.path.exists(allowlist_path):
    with open(allowlist_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if ":" in line:
                fpat, cpat = line.split(":", 1)
                allowrules.append((fpat.strip(), re.compile(cpat.strip())))


def is_allowed(rel_path, line_text):
    for fpat, cregex in allowrules:
        if fnmatch.fnmatch(rel_path, fpat) and cregex.search(line_text):
            return True
    return False


IGNORE_DIRS = {
    ".git", "node_modules", "_lab", "dist", ".venv", "venv",
    "__pycache__", ".pytest_cache", ".ruff_cache"
}
IGNORE_FILES = {
    "main.js", "styles.css", "lab.env", ".DS_Store",
    "scrub-guard.sh", "scrub-guard.allowlist", "scrub-guard.patterns.local",
}
BINARY = (".png", ".jpg", ".ico", ".icns", ".tar.gz", ".zip", ".woff", ".woff2")

violations = []
for search_dir in search_dirs:
    root = Path(search_dir).resolve()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS]
        for fname in filenames:
            if fname in IGNORE_FILES or fname.endswith(BINARY):
                continue
            fpath = Path(dirpath) / fname
            if fpath.is_symlink():
                continue
            rel_path = fpath.relative_to(root).as_posix()
            try:
                with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                    for lno, line in enumerate(f, 1):
                        name = match(line, patterns)
                        if name and not is_allowed(rel_path, line):
                            violations.append((rel_path, lno, name))
            except OSError:
                pass

if violations:
    # Print locations only: echoing the matched line would leak it into CI logs.
    print(f"scrub-guard: FAIL ({len(violations)} violation(s)):")
    for rpath, lno, name in violations:
        print(f"  {rpath}:{lno} [{name}]")
    sys.exit(1)
print("scrub-guard: PASS")
PY

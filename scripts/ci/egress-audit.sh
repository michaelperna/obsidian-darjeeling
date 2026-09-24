#!/usr/bin/env bash
# egress-audit.sh -- Audit all network and outbound call sites in src/
# Enforces AC-14, G-22, G-33:
# Every requestUrl, new WebSocket, and window.open must be annotated with
#   // egress: <row-id>
# and mapped to a corresponding row in README.md's "Network use and data" table.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
README="$REPO_ROOT/README.md"
SRC_DIR="$REPO_ROOT/src"

REPORT_MODE=0
if [ "${1:-}" = "--report" ]; then
    REPORT_MODE=1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dj-egress.XXXXXX")"
cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

README_IDS_FILE="$TMP_DIR/readme_ids.txt"
USED_IDS_FILE="$TMP_DIR/used_ids.txt"
UNANNOTATED_FILE="$TMP_DIR/unannotated.txt"
TOTAL_FILE="$TMP_DIR/total.txt"
touch "$README_IDS_FILE" "$USED_IDS_FILE" "$UNANNOTATED_FILE" "$TOTAL_FILE"

# 1. Parse declared egress IDs from README.md
if [ -f "$README" ]; then
    grep -E '^\|[[:space:]]*`[a-zA-Z0-9_-]+`[[:space:]]*\|' "$README" 2>/dev/null | while IFS= read -r line; do
        id=$(echo "$line" | sed -E 's/^\|[[:space:]]*`([a-zA-Z0-9_-]+)`.*/\1/')
        if [ -n "$id" ]; then
            echo "$id" >> "$README_IDS_FILE"
        fi
    done || true
    if [ -s "$README_IDS_FILE" ]; then
        sort -u "$README_IDS_FILE" -o "$README_IDS_FILE"
    fi
fi

# 2. Find and check all network call sites in src/
echo "=== Darjeeling Outbound Egress Audit ==="
echo ""

while IFS= read -r file; do
    [ -f "$file" ] || continue
    # Grep lines with network calls (|| true prevents pipefail when file has no calls)
    (grep -nE "(requestUrl\(|new[[:space:]]+WebSocket\(|window\.open\()" "$file" 2>/dev/null || true) | while IFS= read -r match; do
        [ -n "$match" ] || continue
        echo 1 >> "$TOTAL_FILE"
        line_num="${match%%:*}"
        line="${match#*:}"
        call=$(echo "$line" | grep -oE "(requestUrl\(|new[[:space:]]+WebSocket\(|window\.open\()" | head -n 1)

        # Check current line first
        egress_id=""
        if echo "$line" | grep -qE "//+[[:space:]]*egress:[[:space:]]*[a-zA-Z0-9_-]+"; then
            egress_id=$(echo "$line" | sed -E 's/.*\/+[[:space:]]*egress:[[:space:]]*([a-zA-Z0-9_-]+).*/\1/')
        elif [ "$line_num" -gt 1 ]; then
            # Check previous line
            prev_line=$(sed -n "$((line_num - 1))p" "$file")
            if echo "$prev_line" | grep -qE "//+[[:space:]]*egress:[[:space:]]*[a-zA-Z0-9_-]+"; then
                egress_id=$(echo "$prev_line" | sed -E 's/.*\/+[[:space:]]*egress:[[:space:]]*([a-zA-Z0-9_-]+).*/\1/')
            fi
        fi

        rel_file="${file#"$REPO_ROOT/"}"
        if [ -n "$egress_id" ]; then
            echo "$egress_id" >> "$USED_IDS_FILE"
            printf "  PASS  %-38s line %-4d [%-18s] (%s)\n" "$rel_file" "$line_num" "$egress_id" "$call"
        else
            echo 1 >> "$UNANNOTATED_FILE"
            printf "  FAIL  %-38s line %-4d UNANNOTATED        (%s)\n" "$rel_file" "$line_num" "$call"
        fi
    done
done < <(find "$SRC_DIR" -type f -name "*.ts" | sort)

TOTAL_CALLS=$(wc -l < "$TOTAL_FILE" | tr -d ' ')
UNANNOTATED_COUNT=$(wc -l < "$UNANNOTATED_FILE" | tr -d ' ')

if [ -s "$USED_IDS_FILE" ]; then
    sort -u "$USED_IDS_FILE" -o "$USED_IDS_FILE"
fi

echo ""
echo "Summary: $TOTAL_CALLS network call sites found. $UNANNOTATED_COUNT unannotated."

# Check README ids coverage
UNUSED_IDS=()
if [ -s "$README_IDS_FILE" ]; then
    while IFS= read -r id; do
        [ -n "$id" ] || continue
        if ! grep -q "^${id}$" "$USED_IDS_FILE" 2>/dev/null; then
            UNUSED_IDS+=("$id")
        fi
    done < "$README_IDS_FILE"
fi

if [ ${#UNUSED_IDS[@]} -gt 0 ]; then
    echo "Warning: Unused egress IDs declared in README.md: ${UNUSED_IDS[*]}"
fi

if [ "$REPORT_MODE" -eq 1 ]; then
    echo "Egress audit report completed (--report mode)."
    exit 0
fi

if [ "$UNANNOTATED_COUNT" -gt 0 ]; then
    echo "Error: $UNANNOTATED_COUNT call sites are missing // egress: <id> annotations." >&2
    exit 1
fi

if [ ${#UNUSED_IDS[@]} -gt 0 ]; then
    echo "Error: README contains unused egress row IDs." >&2
    exit 1
fi

echo "All network call sites cleanly annotated and accounted for."
exit 0

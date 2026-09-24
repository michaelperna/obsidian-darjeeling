#!/usr/bin/env python3
"""
extract-doc-blocks.py -- Extracts executable shell blocks from markdown documentation.
Honours <!-- not-run: <reason> --> annotations placed immediately before or after a code block.
"""

import sys
import re
from pathlib import Path

def extract_blocks(md_path: Path):
    text = md_path.read_text(encoding="utf-8")
    lines = text.splitlines()

    blocks = []
    in_block = False
    current_block = []
    block_start_line = 0
    pre_comment = None

    for i, line in enumerate(lines):
        # Look for pre-comment
        comment_match = re.search(r"<!--\s*not-run:\s*(.*?)\s*-->", line, re.IGNORECASE)
        if not in_block:
            if comment_match:
                pre_comment = comment_match.group(1).strip()
            elif line.strip().startswith("```bash") or line.strip().startswith("```sh"):
                in_block = True
                block_start_line = i + 1
                current_block = []
            else:
                if line.strip() and not line.strip().startswith("<!--"):
                    pre_comment = None
        else:
            if line.strip().startswith("```"):
                in_block = False
                # Look ahead for post-comment in next 3 lines
                post_comment = None
                for j in range(i + 1, min(i + 4, len(lines))):
                    post_match = re.search(r"<!--\s*not-run:\s*(.*?)\s*-->", lines[j], re.IGNORECASE)
                    if post_match:
                        post_comment = post_match.group(1).strip()
                        break
                    if lines[j].strip() and not lines[j].strip().startswith("<!--"):
                        break

                reason = pre_comment or post_comment
                # Also check inside block
                inside_match = None
                for b_line in current_block:
                    inside_m = re.search(r"<!--\s*not-run:\s*(.*?)\s*-->", b_line, re.IGNORECASE)
                    if inside_m:
                        inside_match = inside_m.group(1).strip()
                        break
                if inside_match:
                    reason = inside_match

                code = "\n".join(current_block).strip()
                blocks.append({
                    "line": block_start_line,
                    "code": code,
                    "skip_reason": reason,
                })
                pre_comment = None
                current_block = []
            else:
                current_block.append(line)

    return blocks

def main():
    if len(sys.argv) < 2:
        print("Usage: extract-doc-blocks.py <doc.md> [--out-dir <dir>]", file=sys.stderr)
        sys.exit(1)

    md_path = Path(sys.argv[1])
    if not md_path.is_file():
        print(f"Error: file not found: {md_path}", file=sys.stderr)
        sys.exit(1)

    out_dir = None
    if "--out-dir" in sys.argv:
        idx = sys.argv.index("--out-dir")
        out_dir = Path(sys.argv[idx + 1])
        out_dir.mkdir(parents=True, exist_ok=True)

    blocks = extract_blocks(md_path)
    print(f"Found {len(blocks)} shell blocks in {md_path.name}")

    for idx, b in enumerate(blocks, start=1):
        if b["skip_reason"]:
            print(f"[{idx}] Line {b['line']}: SKIP ({b['skip_reason']})")
        else:
            print(f"[{idx}] Line {b['line']}: RUN")
            if out_dir:
                script_path = out_dir / f"step-{idx:02d}.sh"
                script_path.write_text("#!/usr/bin/env bash\nset -euo pipefail\n" + b["code"] + "\n", encoding="utf-8")
                script_path.chmod(0o755)

if __name__ == "__main__":
    main()

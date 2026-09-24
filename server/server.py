#!/usr/bin/env python3
"""Backwards-compatible shim for darjeeling_server."""

import sys
from pathlib import Path

# Ensure the server directory is on sys.path so darjeeling_server can be imported
SERVER_DIR = Path(__file__).resolve().parent
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from darjeeling_server import app, VERSION  # noqa: E402
from darjeeling_server.__main__ import main  # noqa: E402

__all__ = ["app", "VERSION", "main"]

if __name__ == "__main__":
    main()

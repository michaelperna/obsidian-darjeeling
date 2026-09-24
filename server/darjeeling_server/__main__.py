"""Entrypoint for `python -m darjeeling_server`."""

import os

import uvicorn

from darjeeling_server.agents import AGENTS
from darjeeling_server.app import app
from darjeeling_server.config import (
    ARTIFACT_DIR,
    AUTH_TOKEN,
    TOKEN_FILE,
    VAULT_PATH,
    VERSION,
    default_bind,
    log,
)


def main() -> None:
    host = default_bind()
    port = int(os.environ.get("DARJEELING_PORT", "8765"))

    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)

    log.info("Darjeeling v%s starting on %s:%s", VERSION, host, port)
    log.info("Vault: %s (exists=%s)", VAULT_PATH, VAULT_PATH.exists())
    log.info("Artifacts: %s", ARTIFACT_DIR)
    for key, spec in AGENTS.items():
        log.info(
            "Agent %-7s %s%s",
            key,
            "available" if spec.available else "NOT INSTALLED",
            f" ({spec.version()})" if spec.available and spec.version() else "",
        )
    if AUTH_TOKEN:
        log.info("Auth: token required. Read it with: cat %s", TOKEN_FILE)
    else:
        log.warning(
            "Auth: DISABLED. Anyone who can reach %s:%s has a shell here.",
            host,
            port,
        )

    from darjeeling_server.config import ACCESS_LOG
    uvicorn.run(app, host=host, port=port, log_level="info", access_log=ACCESS_LOG)


if __name__ == "__main__":
    main()

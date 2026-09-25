"""Darjeeling server package."""

# Imported lazily: loading config resolves (and may mint) the auth token, so an
# eager import made every `python -m darjeeling_server.cli ...` touch token
# state before the CLI had loaded the env file that says where it lives.

__all__ = ["app", "VERSION", "__version__"]


def __getattr__(name):
    if name == "app":
        from darjeeling_server.app import app

        return app
    if name in ("VERSION", "__version__"):
        from darjeeling_server.config import VERSION

        return VERSION
    raise AttributeError(f"module 'darjeeling_server' has no attribute {name!r}")

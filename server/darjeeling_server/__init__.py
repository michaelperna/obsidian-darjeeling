"""Darjeeling server package."""

from darjeeling_server.app import app
from darjeeling_server.config import VERSION

__version__ = VERSION

__all__ = ["app", "VERSION", "__version__"]

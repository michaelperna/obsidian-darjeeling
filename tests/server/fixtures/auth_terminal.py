"""Fixtures for authentication, origin validation, and terminal sessions."""

import pytest
from typing import Dict, List


@pytest.fixture
def auth_headers(server) -> Dict[str, str]:
    """Valid Bearer authorization header."""
    return {"Authorization": f"Bearer {server.token}"}


@pytest.fixture
def bad_auth_headers() -> Dict[str, str]:
    """Invalid Bearer authorization header."""
    return {"Authorization": "Bearer definitely-invalid-token-12345"}


@pytest.fixture
def allowed_origins() -> List[str]:
    """Allow-listed origins for Darjeeling."""
    return [
        "app://obsidian.md",
        "capacitor://localhost",
        "http://localhost",
        "http://127.0.0.1",
    ]


@pytest.fixture
def disallowed_origin() -> str:
    """Disallowed external origin."""
    return "https://malicious-website.example.com"

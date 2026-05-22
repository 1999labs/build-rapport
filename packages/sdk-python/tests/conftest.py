"""Shared fixtures."""

import pytest
import requests


@pytest.fixture
def reset_session_request():
    """Save and restore ``requests.Session.request`` so intercept() tests don't
    leak monkey-patches between cases."""
    original = requests.Session.request
    try:
        yield
    finally:
        requests.Session.request = original  # type: ignore[method-assign]

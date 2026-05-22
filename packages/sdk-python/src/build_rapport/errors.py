"""Typed error surface for the SDK. Mirrors the TS ``RapportError`` codes."""

from __future__ import annotations

from typing import Literal, Optional

RapportErrorCode = Literal[
    "invalid_request",
    "unauthorized",
    "not_found",
    "network_error",
    "verification_failed",
]


class RapportError(Exception):
    """Raised by every public SDK method on failure.

    Attributes:
        code: A stable, machine-readable error code.
        message: Human-readable description.
        status: HTTP status, when the error originated from an API response.
    """

    def __init__(
        self,
        code: RapportErrorCode,
        message: str,
        status: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.code: RapportErrorCode = code
        self.message: str = message
        self.status: Optional[int] = status

    def __repr__(self) -> str:
        return f"RapportError(code={self.code!r}, message={self.message!r}, status={self.status!r})"

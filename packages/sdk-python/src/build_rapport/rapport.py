"""The Rapport SDK client.

A thin HTTP client over the Rapport API, mirroring the TypeScript
``build-rapport`` package: it handles auth headers, request serialization,
optional client-side Ed25519 signing, Mechanism 1 identity headers, and the
automatic ``intercept()`` mode that wraps ``requests`` to mint receipts in the
background.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import threading
import urllib.parse
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Literal, Mapping, Optional, TypedDict

import requests
from nacl.signing import SigningKey, VerifyKey

from .errors import RapportError, RapportErrorCode

DEFAULT_BASE_URL = "https://rapport.sh"
HEX_64 = re.compile(r"^[0-9a-fA-F]{64}$")
ID_PREFIX = re.compile(r"^(agt|rct|clm|key)_")

Outcome = Literal["success", "failure", "partial"]


class Receipt(TypedDict):
    """A signed (or partially signed) record of one interaction.

    Mirrors the ``Receipt`` interface in the TypeScript protocol package.
    """

    id: str
    party_a: str
    party_b: str
    party_a_signature: str
    party_b_signature: Optional[str]
    party_a_public_key: str
    party_b_public_key: Optional[str]
    category: str
    outcome: str
    payload_hash: str
    metadata: Dict[str, Any]
    created_at: str


class VerifyResult(TypedDict):
    valid: bool
    bilateral: bool
    receipt: Receipt


class HistoryResult(TypedDict):
    receipts: List[Receipt]
    total: int


# ---------------------------------------------------------------------------
# Crypto + canonical JSON helpers
# ---------------------------------------------------------------------------


def _canonical_json(data: Mapping[str, Any]) -> str:
    """Serialize ``data`` to RFC 8785-compatible canonical JSON.

    Sorted keys, no whitespace, UTF-8 strings preserved. For ASCII-keyed
    objects holding strings and ints (which all receipt signing payloads are),
    the output is byte-identical to the TypeScript ``canonicalize`` package's
    output — and therefore produces the same signature.
    """
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _sha256_hex(s: str) -> str:
    """Hex-encoded SHA-256 of a UTF-8 string."""
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _sign(payload: str, private_key_hex: str) -> str:
    """Sign a canonical payload, returning the signature as hex.

    Matches the TypeScript flow: UTF-8 encode → SHA-256 → Ed25519 sign.
    """
    digest = hashlib.sha256(payload.encode("utf-8")).digest()
    signing_key = SigningKey(bytes.fromhex(private_key_hex))
    return signing_key.sign(digest).signature.hex()


def _verify(payload: str, signature_hex: str, public_key_hex: str) -> bool:
    """Verify a signature over a payload. Returns ``False`` on any error."""
    try:
        digest = hashlib.sha256(payload.encode("utf-8")).digest()
        VerifyKey(bytes.fromhex(public_key_hex)).verify(digest, bytes.fromhex(signature_hex))
        return True
    except Exception:
        return False


def _public_key_from_private(private_key_hex: str) -> str:
    """Derive the Ed25519 public key (hex) for a private key (hex)."""
    return SigningKey(bytes.fromhex(private_key_hex)).verify_key.encode().hex()


def _nanoid(size: int = 16) -> str:
    """Generate a URL-safe random ID of approximately ``size`` chars."""
    # secrets.token_urlsafe encodes n random bytes into base64url, which
    # produces ~ceil(n * 4/3) chars. For size=16 we need ~12 bytes.
    raw = secrets.token_urlsafe(max(1, size * 3 // 4 + 1))
    return raw[:size]


def _infer_category(url: str) -> Optional[str]:
    """Best-effort category derived from the last meaningful URL path segment.

    Rapport-style ID segments (``agt_``/``rct_``/``clm_``/``key_``) are
    skipped, matching the TypeScript ``inferCategory`` helper.
    """
    try:
        path = urllib.parse.urlparse(url).path
        segments = [s for s in path.split("/") if s and not ID_PREFIX.match(s)]
        return segments[-1] if segments else None
    except Exception:
        return None


def _code_for_status(status: int) -> RapportErrorCode:
    """Map an HTTP status to a ``RapportErrorCode``."""
    if status in (401, 403):
        return "unauthorized"
    if status == 404:
        return "not_found"
    if 400 <= status < 500:
        return "invalid_request"
    return "network_error"


def _error_message(payload: Any) -> Optional[str]:
    """Pull the ``error`` field out of an API error body, if present."""
    if isinstance(payload, dict):
        value = payload.get("error")
        if isinstance(value, str):
            return value
    return None


# ---------------------------------------------------------------------------
# Rapport client
# ---------------------------------------------------------------------------


class Rapport:
    """The Rapport SDK client. Mirrors the TypeScript ``Rapport`` class."""

    def __init__(
        self,
        api_key: str,
        agent_id: str,
        signing_key: Optional[str] = None,
        base_url: str = DEFAULT_BASE_URL,
    ) -> None:
        if not api_key:
            raise RapportError("invalid_request", "api_key is required")
        if not agent_id:
            raise RapportError("invalid_request", "agent_id is required")
        if signing_key is not None and not HEX_64.match(signing_key):
            raise RapportError("invalid_request", "signing_key must be a 32-byte hex string")
        self.api_key = api_key
        self.agent_id = agent_id
        self.signing_key = signing_key
        self.base_url = base_url.rstrip("/")
        self._intercepted = False

    # ------------------------------------------------------------------ public

    def mint(
        self,
        counterparty: str,
        category: Optional[str] = None,
        outcome: Optional[Outcome] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Receipt:
        """Mint a receipt for an interaction with a counterparty.

        Only ``counterparty`` is required. When a ``signing_key`` was
        configured at construction time, the receipt is signed on this side
        and the signature is included in the request; otherwise the server
        signs with the agent's server-stored key.
        """
        body: Dict[str, Any] = {
            "counterparty": counterparty,
            "category": category if category is not None else "general",
            "outcome": outcome if outcome is not None else "success",
            "metadata": metadata if metadata is not None else {},
        }
        if self.signing_key:
            body["signed"] = self._sign_locally(
                counterparty=counterparty,
                category=body["category"],
                outcome=body["outcome"],
                metadata=body["metadata"],
            )
        return self._request("POST", "/api/receipts", auth=True, body=body)

    def countersign(self, receipt_id: str) -> Receipt:
        """Countersign a receipt addressed to this agent."""
        path = f"/api/receipts/{urllib.parse.quote(receipt_id, safe='')}/countersign"
        return self._request("POST", path, auth=True)

    def verify(self, receipt_id: str) -> VerifyResult:
        """Verify a receipt's signatures. Public — no API key required."""
        path = f"/api/receipts/{urllib.parse.quote(receipt_id, safe='')}/verify"
        return self._request("GET", path, auth=False)

    def history(
        self,
        counterparty: Optional[str] = None,
        limit: int = 20,
        offset: int = 0,
    ) -> HistoryResult:
        """List receipts this agent initiated."""
        params: Dict[str, str] = {}
        if counterparty is not None:
            params["counterparty"] = counterparty
        params["limit"] = str(limit)
        params["offset"] = str(offset)
        query = urllib.parse.urlencode(params)
        return self._request("GET", f"/api/receipts?{query}", auth=True)

    def fetch(self, url: str, **kwargs: Any) -> requests.Response:
        """Mechanism 1 — wrap an outbound call to another agent.

        Behaves like ``requests.request("GET", url, ...)`` (or whichever method
        you pass via the ``method`` kwarg) but injects this agent's Rapport
        identity headers so the counterparty can recognize you.
        """
        method = kwargs.pop("method", "GET")
        headers = dict(kwargs.pop("headers", None) or {})
        headers["X-Rapport-Agent"] = self.agent_id
        headers["X-Rapport-Profile"] = f"{self.base_url}/agent/{self.agent_id}"
        return requests.request(method, url, headers=headers, **kwargs)

    def intercept(self) -> None:
        """Automatic mode — monkey-patch ``requests.Session.request``.

        Every outbound call carries Rapport identity headers; whenever a
        response names a Rapport agent in its ``X-Rapport-Agent`` header, a
        receipt is auto-minted in a daemon thread (fire-and-forget). Calls to
        this client's own ``base_url`` pass through untouched to avoid
        recursion. Idempotent: a second call on the same instance is a no-op.
        """
        if self._intercepted:
            return
        self._intercepted = True

        original = requests.Session.request
        agent_id = self.agent_id
        base_url = self.base_url
        profile_url = f"{base_url}/agent/{agent_id}"
        mint = self.mint

        def wrapped(
            session_self: requests.Session,
            method: str,
            url: str,
            **kwargs: Any,
        ) -> requests.Response:
            url_str = str(url)

            # Pass requests to our own API straight through — otherwise the
            # SDK's internal mint() call would recurse, and we'd be tagging
            # Rapport API calls with our identity headers.
            if url_str.startswith(base_url):
                return original(session_self, method, url_str, **kwargs)

            headers = dict(kwargs.get("headers") or {})
            headers["X-Rapport-Agent"] = agent_id
            headers["X-Rapport-Profile"] = profile_url
            kwargs["headers"] = headers

            response = original(session_self, method, url_str, **kwargs)

            counterparty = response.headers.get("X-Rapport-Agent")
            if counterparty and counterparty != agent_id:
                outcome: Outcome = "success" if response.status_code < 400 else "failure"
                category = _infer_category(url_str)

                def _fire() -> None:
                    try:
                        mint(counterparty=counterparty, category=category, outcome=outcome)
                    except Exception:
                        # Fire-and-forget — a failed auto-mint must never surface.
                        pass

                threading.Thread(target=_fire, daemon=True).start()

            return response

        requests.Session.request = wrapped  # type: ignore[method-assign]

    # ----------------------------------------------------------------- private

    def _sign_locally(
        self,
        counterparty: str,
        category: str,
        outcome: str,
        metadata: Dict[str, Any],
    ) -> Dict[str, str]:
        """Build and sign a receipt payload client-side."""
        if not self.signing_key:
            raise RapportError("invalid_request", "signing_key is not configured")

        receipt_id = f"rct_{_nanoid(16)}"
        created_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + (
            f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"
        )
        payload_hash = _sha256_hex(_canonical_json(metadata))

        signing_fields = {
            "id": receipt_id,
            "party_a": self.agent_id,
            "party_b": counterparty,
            "category": category,
            "outcome": outcome,
            "payload_hash": payload_hash,
            "created_at": created_at,
        }
        message = _canonical_json(signing_fields)

        signature = _sign(message, self.signing_key)
        public_key = _public_key_from_private(self.signing_key)
        if not _verify(message, signature, public_key):
            raise RapportError(
                "verification_failed", "Local signature failed self-verification"
            )

        return {
            "receipt_id": receipt_id,
            "created_at": created_at,
            "payload_hash": payload_hash,
            "signature": signature,
            "public_key": public_key,
        }

    def _request(
        self,
        method: str,
        path: str,
        auth: bool,
        body: Optional[Any] = None,
    ) -> Any:
        """Issue an API request and parse the response."""
        headers: Dict[str, str] = {}
        if auth:
            headers["authorization"] = f"Bearer {self.api_key}"
        if body is not None:
            headers["content-type"] = "application/json"

        try:
            response = requests.request(
                method,
                f"{self.base_url}{path}",
                headers=headers,
                data=json.dumps(body) if body is not None else None,
                timeout=30,
            )
        except requests.RequestException as exc:
            raise RapportError(
                "network_error", f"Could not reach the Rapport API at {path}"
            ) from exc

        text = response.text
        try:
            payload: Any = json.loads(text) if text else {}
        except json.JSONDecodeError as exc:
            raise RapportError(
                "network_error",
                "The API returned a malformed response",
                response.status_code,
            ) from exc

        if not response.ok:
            raise RapportError(
                _code_for_status(response.status_code),
                _error_message(payload) or f"Request failed with status {response.status_code}",
                response.status_code,
            )

        return payload

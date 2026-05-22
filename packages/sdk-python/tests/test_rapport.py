"""Tests mirroring the TypeScript SDK test surface."""

from __future__ import annotations

import json
import time
from typing import Any, Dict

import pytest
import requests
import responses

from build_rapport import Rapport, RapportError
from build_rapport.rapport import (
    _canonical_json,
    _infer_category,
    _public_key_from_private,
    _sign,
    _verify,
)

SAMPLE_RECEIPT: Dict[str, Any] = {
    "id": "rct_sample",
    "party_a": "agt_a",
    "party_b": "agt_b",
    "party_a_signature": "a1",
    "party_b_signature": None,
    "party_a_public_key": "pk_a",
    "party_b_public_key": None,
    "category": "research",
    "outcome": "success",
    "payload_hash": "hash",
    "metadata": {},
    "created_at": "2026-01-01T00:00:00.000Z",
}


def client(signing_key: str | None = None) -> Rapport:
    return Rapport(api_key="rk_live_test", agent_id="agt_a", signing_key=signing_key)


# ---------------------------------------------------------------------------
# Constructor
# ---------------------------------------------------------------------------


class TestConstructor:
    def test_raises_when_api_key_missing(self) -> None:
        with pytest.raises(RapportError) as exc:
            Rapport(api_key="", agent_id="agt_a")
        assert exc.value.code == "invalid_request"

    def test_raises_when_agent_id_missing(self) -> None:
        with pytest.raises(RapportError) as exc:
            Rapport(api_key="rk_live_test", agent_id="")
        assert exc.value.code == "invalid_request"

    def test_raises_when_signing_key_malformed(self) -> None:
        with pytest.raises(RapportError) as exc:
            Rapport(api_key="rk_live_test", agent_id="agt_a", signing_key="not-hex")
        assert exc.value.code == "invalid_request"


# ---------------------------------------------------------------------------
# mint / countersign / verify / history
# ---------------------------------------------------------------------------


class TestMint:
    @responses.activate
    def test_posts_with_bearer_and_returns_receipt(self) -> None:
        responses.add(
            responses.POST,
            "https://rapport.sh/api/receipts",
            json=SAMPLE_RECEIPT,
            status=200,
        )
        result = client().mint(counterparty="agt_b", category="research")
        assert result == SAMPLE_RECEIPT
        call = responses.calls[0]
        assert call.request.headers["authorization"] == "Bearer rk_live_test"

    @responses.activate
    def test_sends_no_signed_block_without_signing_key(self) -> None:
        responses.add(
            responses.POST, "https://rapport.sh/api/receipts", json=SAMPLE_RECEIPT
        )
        client().mint(counterparty="agt_b", category="research")
        body = json.loads(responses.calls[0].request.body or "{}")
        assert "signed" not in body


class TestCountersign:
    @responses.activate
    def test_posts_to_countersign_endpoint(self) -> None:
        countersigned = {**SAMPLE_RECEIPT, "party_b_signature": "b1"}
        responses.add(
            responses.POST,
            "https://rapport.sh/api/receipts/rct_sample/countersign",
            json=countersigned,
        )
        result = client().countersign("rct_sample")
        assert result == countersigned


class TestVerify:
    @responses.activate
    def test_gets_without_auth_header(self) -> None:
        responses.add(
            responses.GET,
            "https://rapport.sh/api/receipts/rct_sample/verify",
            json={"valid": True, "bilateral": False, "receipt": SAMPLE_RECEIPT},
        )
        result = client().verify("rct_sample")
        assert result["valid"] is True
        assert result["bilateral"] is False
        assert "authorization" not in responses.calls[0].request.headers


class TestHistory:
    @responses.activate
    def test_includes_query_params(self) -> None:
        responses.add(
            responses.GET,
            "https://rapport.sh/api/receipts",
            json={"receipts": [SAMPLE_RECEIPT], "total": 1},
        )
        result = client().history(counterparty="agt_b", limit=5)
        assert result == {"receipts": [SAMPLE_RECEIPT], "total": 1}
        url = responses.calls[0].request.url
        assert "counterparty=agt_b" in url
        assert "limit=5" in url


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------


class TestErrorHandling:
    @responses.activate
    def test_raises_unauthorized_on_401(self) -> None:
        responses.add(
            responses.POST,
            "https://rapport.sh/api/receipts",
            json={"error": "Missing or invalid API key"},
            status=401,
        )
        with pytest.raises(RapportError) as exc:
            client().mint(counterparty="agt_b", category="x")
        assert exc.value.code == "unauthorized"
        assert exc.value.status == 401

    @responses.activate
    def test_raises_not_found_on_404(self) -> None:
        responses.add(
            responses.POST,
            "https://rapport.sh/api/receipts/rct_missing/countersign",
            json={"error": "Receipt not found"},
            status=404,
        )
        with pytest.raises(RapportError) as exc:
            client().countersign("rct_missing")
        assert exc.value.code == "not_found"

    @responses.activate
    def test_raises_network_error_on_500(self) -> None:
        responses.add(
            responses.POST,
            "https://rapport.sh/api/receipts",
            json={"error": "Could not store receipt"},
            status=500,
        )
        with pytest.raises(RapportError) as exc:
            client().mint(counterparty="agt_b", category="x")
        assert exc.value.code == "network_error"


# ---------------------------------------------------------------------------
# rapport.fetch — Mechanism 1
# ---------------------------------------------------------------------------


class TestFetch:
    @responses.activate
    def test_injects_rapport_headers(self) -> None:
        responses.add(responses.POST, "https://otheragent.com/api/task", json={"ok": True})
        client().fetch("https://otheragent.com/api/task", method="POST")
        headers = responses.calls[0].request.headers
        assert headers["X-Rapport-Agent"] == "agt_a"
        assert headers["X-Rapport-Profile"] == "https://rapport.sh/agent/agt_a"


# ---------------------------------------------------------------------------
# Client-side signing
# ---------------------------------------------------------------------------


class TestClientSideSigning:
    def _fresh_keypair_hex(self) -> tuple[str, str]:
        from nacl.signing import SigningKey

        sk = SigningKey.generate()
        return sk.encode().hex(), sk.verify_key.encode().hex()

    @responses.activate
    def test_attaches_self_verified_signature(self) -> None:
        private_hex, public_hex = self._fresh_keypair_hex()
        responses.add(
            responses.POST, "https://rapport.sh/api/receipts", json=SAMPLE_RECEIPT
        )

        client(signing_key=private_hex).mint(counterparty="agt_b", category="research")

        body = json.loads(responses.calls[0].request.body or "{}")
        signed = body.get("signed")
        assert signed is not None
        assert signed["public_key"] == public_hex
        assert signed["receipt_id"].startswith("rct_")
        # Signature is hex.
        assert all(c in "0123456789abcdef" for c in signed["signature"])


# ---------------------------------------------------------------------------
# intercept()
# ---------------------------------------------------------------------------


def _wait_for_calls(at_least: int, timeout: float = 2.0) -> None:
    """Spin until ``responses.calls`` has at least ``at_least`` entries, or
    raise — used to give the fire-and-forget mint thread time to fire."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if len(responses.calls) >= at_least:
            return
        time.sleep(0.05)
    raise AssertionError(
        f"Expected at least {at_least} calls; got {len(responses.calls)}"
    )


def _mint_call_body() -> Dict[str, Any]:
    """Find the most recent /api/receipts POST and return its parsed body."""
    for call in reversed(responses.calls):
        if "/api/receipts" in str(call.request.url) and call.request.method == "POST":
            return json.loads(call.request.body or "{}")
    raise AssertionError("No /api/receipts POST was made")


class TestIntercept:
    def test_idempotent_second_call_is_noop(self, reset_session_request: None) -> None:
        r = client()
        r.intercept()
        wrapped = requests.Session.request
        r.intercept()
        assert requests.Session.request is wrapped

    @responses.activate
    def test_injects_headers_on_outbound_calls(
        self, reset_session_request: None
    ) -> None:
        responses.add(responses.GET, "https://otheragent.com/api/task", json={"ok": True})
        client().intercept()
        requests.get("https://otheragent.com/api/task")
        headers = responses.calls[0].request.headers
        assert headers["X-Rapport-Agent"] == "agt_a"
        assert headers["X-Rapport-Profile"] == "https://rapport.sh/agent/agt_a"

    @responses.activate
    def test_auto_mints_when_response_names_rapport_counterparty(
        self, reset_session_request: None
    ) -> None:
        responses.add(
            responses.GET,
            "https://otheragent.com/api/research/summary",
            json={"ok": True},
            headers={"X-Rapport-Agent": "agt_other"},
        )
        responses.add(
            responses.POST, "https://rapport.sh/api/receipts", json=SAMPLE_RECEIPT
        )
        client().intercept()
        requests.get("https://otheragent.com/api/research/summary")
        _wait_for_calls(2)

        body = _mint_call_body()
        assert body["counterparty"] == "agt_other"
        assert body["outcome"] == "success"
        assert body["category"] == "summary"

    @responses.activate
    def test_does_not_mint_when_no_rapport_header(
        self, reset_session_request: None
    ) -> None:
        responses.add(responses.GET, "https://otheragent.com/api/task", json={"ok": True})
        client().intercept()
        requests.get("https://otheragent.com/api/task")
        # Give a fire-and-forget mint a chance to fire if it were going to.
        time.sleep(0.2)
        assert len(responses.calls) == 1

    @responses.activate
    def test_uses_failure_outcome_for_5xx(
        self, reset_session_request: None
    ) -> None:
        responses.add(
            responses.GET,
            "https://otheragent.com/api/task",
            json={"err": True},
            status=503,
            headers={"X-Rapport-Agent": "agt_other"},
        )
        responses.add(
            responses.POST, "https://rapport.sh/api/receipts", json=SAMPLE_RECEIPT
        )
        client().intercept()
        requests.get("https://otheragent.com/api/task")
        _wait_for_calls(2)

        assert _mint_call_body()["outcome"] == "failure"

    @responses.activate
    def test_ignores_self_loops(self, reset_session_request: None) -> None:
        responses.add(
            responses.GET,
            "https://otheragent.com/api/task",
            json={"ok": True},
            headers={"X-Rapport-Agent": "agt_a"},  # same as self
        )
        client().intercept()
        requests.get("https://otheragent.com/api/task")
        time.sleep(0.2)
        assert len(responses.calls) == 1

    @responses.activate
    def test_never_lets_mint_failure_surface(
        self, reset_session_request: None
    ) -> None:
        responses.add(
            responses.GET,
            "https://otheragent.com/api/task",
            json={"ok": True},
            headers={"X-Rapport-Agent": "agt_other"},
        )
        responses.add(
            responses.POST,
            "https://rapport.sh/api/receipts",
            json={"error": "boom"},
            status=500,
        )
        client().intercept()
        # Must not raise.
        res = requests.get("https://otheragent.com/api/task")
        assert res.status_code == 200


# ---------------------------------------------------------------------------
# Crypto + canonical JSON parity
# ---------------------------------------------------------------------------


class TestCryptoParity:
    def test_canonical_json_sorts_keys_no_whitespace(self) -> None:
        out = _canonical_json({"b": 2, "a": 1})
        assert out == '{"a":1,"b":2}'

    def test_canonical_json_string_values(self) -> None:
        out = _canonical_json(
            {
                "id": "rct_x",
                "party_a": "agt_a",
                "party_b": "agt_b",
                "category": "research",
                "outcome": "success",
                "payload_hash": "0" * 64,
                "created_at": "2026-01-01T00:00:00.000Z",
            }
        )
        # Keys in alphabetical order.
        assert out.startswith('{"category":"research"')

    def test_sign_round_trips(self) -> None:
        from nacl.signing import SigningKey

        sk = SigningKey.generate()
        private_hex = sk.encode().hex()
        public_hex = sk.verify_key.encode().hex()
        message = _canonical_json({"id": "rct_x", "party_a": "agt_a"})
        sig = _sign(message, private_hex)
        assert _verify(message, sig, public_hex)
        assert not _verify(message, sig, "ab" * 32)  # wrong key

    def test_public_key_derivation_matches_pynacl(self) -> None:
        from nacl.signing import SigningKey

        sk = SigningKey.generate()
        assert _public_key_from_private(sk.encode().hex()) == sk.verify_key.encode().hex()


class TestInferCategory:
    def test_last_meaningful_path_segment(self) -> None:
        assert _infer_category("https://x.com/api/task") == "task"
        assert _infer_category("https://x.com/research/query") == "query"

    def test_skips_rapport_id_segments(self) -> None:
        assert _infer_category("https://x.com/agents/agt_xyz/messages") == "messages"
        assert _infer_category("https://x.com/api/rct_xyz") == "api"

    def test_returns_none_for_bare_root(self) -> None:
        assert _infer_category("https://x.com/") is None

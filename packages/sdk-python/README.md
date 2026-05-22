# build-rapport

the [rapport](https://rapport.sh) sdk for python. social capital for ai agents.

every time two agents work together, both sides cryptographically sign a receipt. the accumulated graph of who's worked with whom becomes a reputation layer for the agent economy. social capital earned through verified interactions.

the relationships between agents will matter as much as their capabilities. let them build rapport.

the SDK is a thin client over the rapport api: it handles auth, request serialization, optional client-side signing, and identity headers. works with any agent framework, model, or runtime.

## quick start

```bash
pip install build-rapport
```

```python
import os
from build_rapport import Rapport

rapport = Rapport(
    api_key=os.environ["RAPPORT_API_KEY"],
    agent_id=os.environ["RAPPORT_AGENT_ID"],
)

rapport.intercept()
```

That's it. `intercept()` monkey-patches `requests.Session.request` so every outbound HTTP call carries your Rapport identity headers, and whenever a response comes back from another Rapport agent the receipt is minted in the background. No `mint()` calls in your business code.

## Manual alternatives

For cases where you'd rather record receipts at specific points instead of intercepting every fetch.

### Direct mint

```python
receipt = rapport.mint(
    counterparty="agt_other_agent_id",
    category="research",
    outcome="success",
)
```

### Per-call header injection

```python
res = rapport.fetch(
    "https://otheragent.com/api/task",
    method="POST",
    json={"query": "market analysis"},
)
```

`rapport.fetch` behaves identically to `requests.request` but adds two headers (`X-Rapport-Agent`, `X-Rapport-Profile`) that let the counterparty recognize you and form a connection. Use this when you want only some outbound calls to carry Rapport identity instead of all of them.

## Configuration

```python
Rapport(
    api_key=str,         # your operator API key, "rk_live_..."
    agent_id=str,        # your agent's ID, "agt_..."
    signing_key=None,    # optional hex Ed25519 private key; when set,
                         # receipts are signed on your machine
    base_url="https://rapport.sh",
)
```

## Methods

### `intercept()`

Switch the SDK into automatic mode. Replaces `requests.Session.request` with a wrapper that:

1. Injects `X-Rapport-Agent` and `X-Rapport-Profile` headers on every outbound request, so Rapport-aware counterparties can recognize you.
2. After the response returns, checks for an `X-Rapport-Agent` response header. If present, mints a receipt naming that counterparty.

Outcome is derived from the HTTP status (`< 400` → `"success"`, otherwise `"failure"`). Category is inferred from the last meaningful URL path segment, or defaults to `"general"`. The mint runs in a daemon thread — fire-and-forget; it never delays or fails the original request. Idempotent: calling `intercept()` a second time on the same instance is a no-op.

```python
rapport.intercept()

# From now on, anywhere in your code:
requests.get("https://otheragent.com/api/research/summary")
# → outbound carries your Rapport headers
# → if the response includes X-Rapport-Agent, a receipt is minted in the background
```

### `mint(counterparty, category=None, outcome=None, metadata=None)`

Record an interaction with a counterparty. Returns the receipt as a dict. Only `counterparty` is required.

```python
receipt = rapport.mint(
    counterparty="agt_other_agent_id",      # required
    category="research",                    # optional, default "general"
    outcome="success",                      # "success" | "failure" | "partial", default "success"
    metadata={"task": "summary"},           # optional
)
```

### `fetch(url, method="GET", **kwargs)`

Per-call alternative to `intercept()`. Wraps a single outbound HTTP call with your Rapport identity headers (`X-Rapport-Agent`, `X-Rapport-Profile`) so the counterparty can recognize you and connect back. Returns the standard `requests.Response`. Behaves identically to `requests.request` otherwise.

```python
# Before:
res = requests.post("https://otheragent.com/api/task")

# After:
res = rapport.fetch("https://otheragent.com/api/task", method="POST")
```

### `countersign(receipt_id)`

Confirm a receipt addressed to your agent. Once both sides have signed, the connection is verified. Returns the updated receipt.

```python
receipt = rapport.countersign("rct_...")
```

### `verify(receipt_id)`

Check a receipt's signatures. Public — works without an API key.

```python
result = rapport.verify("rct_...")
# {"valid": True, "bilateral": True, "receipt": {...}}
```

`valid` is true when every signature checks out. `bilateral` is true when both parties have signed.

### `history(counterparty=None, limit=20, offset=0)`

List the receipts your agent has initiated.

```python
result = rapport.history(
    counterparty="agt_other_agent_id",  # optional filter
    limit=20,                           # default 20
    offset=0,                           # default 0
)
```

## Errors

Every method raises `RapportError` on failure:

```python
from build_rapport import RapportError

try:
    rapport.countersign("rct_...")
except RapportError as err:
    print(err.code, err.message, err.status)
```

`code` is one of: `unauthorized`, `not_found`, `invalid_request`, `network_error`, `verification_failed`. `status` carries the HTTP status when the error came from the API.

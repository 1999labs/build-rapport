# build-rapport

the [rapport](https://rapport.sh) sdk. social capital for ai agents.

every time two agents work together, both sides cryptographically sign a receipt. the accumulated graph of who's worked with whom becomes a reputation layer for the agent economy. social capital earned through verified interactions.

the relationships between agents will matter as much as their capabilities. let them build rapport.

the SDK is a thin client over the rapport api: it handles auth, request serialization, optional client-side signing, and identity headers. works with any agent framework, model, or runtime.

## quick start

```bash
npm install build-rapport
```

```ts
import { Rapport } from 'build-rapport'

const rapport = new Rapport({
  apiKey: process.env.RAPPORT_API_KEY,
  agentId: process.env.RAPPORT_AGENT_ID
})

rapport.intercept()
```

That's it. `intercept()` wraps `globalThis.fetch` so every outbound HTTP call carries your Rapport identity headers, and whenever a response comes back from another Rapport agent the receipt is minted in the background. No `mint()` calls in your business code.

## Manual alternatives

For cases where you'd rather record receipts at specific points instead of intercepting every fetch.

### Direct mint

```ts
const receipt = await rapport.mint({
  counterparty: 'agt_other_agent_id',
  category: 'research',
  outcome: 'success'
})
```

### Per-call header injection

```ts
const res = await rapport.fetch('https://otheragent.com/api/task', {
  method: 'POST',
  body: JSON.stringify({ query: 'market analysis' })
})
```

`rapport.fetch` behaves identically to the native `fetch` but adds two headers (`X-Rapport-Agent`, `X-Rapport-Profile`) that let the counterparty recognize you and form a connection. Use this when you want only some outbound calls to carry Rapport identity instead of all of them.

## Configuration

```ts
new Rapport({
  apiKey: string,      // your operator API key, "rk_live_..."
  agentId: string,     // your agent's ID, "agt_..."
  signingKey?: string, // optional hex Ed25519 private key; when set,
                       // receipts are signed on your machine
  baseUrl?: string     // defaults to "https://rapport.sh"
})
```

## Methods

### `intercept()`

Switch the SDK into automatic mode. Replaces `globalThis.fetch` with a wrapper that:

1. Injects `X-Rapport-Agent` and `X-Rapport-Profile` headers on every outbound request, so Rapport-aware counterparties can recognize you.
2. After the response returns, checks for an `X-Rapport-Agent` response header. If present, mints a receipt naming that counterparty.

Outcome is derived from the HTTP status (`< 400` → `success`, otherwise `failure`). Category is inferred from the last meaningful URL path segment, or defaults to `'general'`. The mint is fire-and-forget — it never delays or fails the original request. Idempotent: calling `intercept()` a second time is a no-op.

```ts
rapport.intercept()

// From now on, anywhere in your code:
await fetch('https://otheragent.com/api/research/summary', { method: 'POST' })
// → outbound carries your Rapport headers
// → if the response includes X-Rapport-Agent, a receipt is minted in the background
```

### `mint(params)`

Record an interaction with a counterparty. Returns the receipt. Only `counterparty` is required.

```ts
const receipt = await rapport.mint({
  counterparty: 'agt_other_agent_id',         // required
  category: 'research',                       // optional, default 'general'
  outcome: 'success',                         // 'success' | 'failure' | 'partial', default 'success'
  metadata: { task: 'summary' }               // optional
})
```

### `fetch(url, init?)`

Per-call alternative to `intercept()`. Wraps a single outbound HTTP call with your Rapport identity headers (`X-Rapport-Agent`, `X-Rapport-Profile`) so the counterparty can recognize you and connect back. Returns the standard `Response`. Behaves identically to the native `fetch` otherwise.

```ts
// Before:
const res = await fetch('https://otheragent.com/api/task', { method: 'POST' })

// After:
const res = await rapport.fetch('https://otheragent.com/api/task', { method: 'POST' })
```

### `countersign(receiptId)`

Confirm a receipt addressed to your agent. Once both sides have signed, the connection is verified. Returns the updated receipt.

```ts
const receipt = await rapport.countersign('rct_...')
```

### `verify(receiptId)`

Check a receipt's signatures. Public — works without an API key.

```ts
const { valid, bilateral, receipt } = await rapport.verify('rct_...')
```

`valid` is true when every signature checks out. `bilateral` is true when both parties have signed.

### `history(params?)`

List the receipts your agent has initiated.

```ts
const { receipts, total } = await rapport.history({
  counterparty: 'agt_other_agent_id', // optional filter
  limit: 20,                          // default 20
  offset: 0                           // default 0
})
```

## Errors

Every method throws a `RapportError` on failure:

```ts
import { RapportError } from 'build-rapport'

try {
  await rapport.countersign('rct_...')
} catch (err) {
  if (err instanceof RapportError) {
    console.error(err.code, err.message, err.status)
  }
}
```

`code` is one of: `unauthorized`, `not_found`, `invalid_request`, `network_error`, `verification_failed`. `status` carries the HTTP status when the error came from the API.

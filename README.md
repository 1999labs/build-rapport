# build-rapport

The relationships between agents will matter as much as their capabilities. Let them build Rapport.

This repository is the open, auditable core: the receipt protocol and the client SDKs developers use to integrate. The hosted product lives at [rapport.sh](https://rapport.sh).

## What's in here

- [`packages/protocol`](./packages/protocol) — receipt schema, Ed25519 signing and verification. Zero dependencies on Rapport's backend; receipts are verifiable offline.
- [`packages/sdk`](./packages/sdk) — `build-rapport`, the TypeScript SDK.
- [`packages/sdk-python`](./packages/sdk-python) — `build-rapport`, the Python SDK.

## Install

JavaScript / TypeScript — fastest path:

```bash
npx build-rapport init
```

Prompts for your email, registers an agent, writes `.env`, installs the SDK. Your API key arrives by email.

Or install manually:

```bash
npm install build-rapport
```

Python:

```bash
pip install build-rapport
```

## Quick start

```ts
import { Rapport } from 'build-rapport'

const rapport = new Rapport({
  apiKey: process.env.RAPPORT_API_KEY,
  agentId: process.env.RAPPORT_AGENT_ID,
})

rapport.intercept()
```

`intercept()` wraps `globalThis.fetch` so every outbound HTTP call carries your Rapport identity headers, and whenever a response comes back from another Rapport agent the receipt is minted in the background.

See the [SDK README](./packages/sdk/README.md) for the full API.

## Protocol

The receipt format and signing rules live in [`packages/protocol`](./packages/protocol). A receipt is self-contained - anyone holding it can verify both signatures offline without querying Rapport. If Rapport disappeared tomorrow, every receipt minted to date would remain a valid artifact.

## Links

- Product: [rapport.sh](https://rapport.sh)
- npm: [`build-rapport`](https://www.npmjs.com/package/build-rapport)
- PyPI: [`build-rapport`](https://pypi.org/project/build-rapport/)

## License

MIT — see [LICENSE](./LICENSE).

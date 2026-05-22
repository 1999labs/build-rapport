# @rapport/protocol

The receipt format, signing rules, and verification primitives that define a Rapport receipt. Everything in this package is portable: no dependency on Rapport's backend, no network calls. A receipt produced and signed today can be verified offline forever.

## What's in here

- `src/types.ts` — the receipt schema and surrounding types.
- `src/crypto.ts` — Ed25519 sign and verify, built on [`@noble/curves`](https://github.com/paulmillr/noble-curves) and [`@noble/hashes`](https://github.com/paulmillr/noble-hashes). Canonical JSON serialization via [`canonicalize`](https://github.com/erdtman/canonicalize).
- `src/index.ts` — public exports.

## The un-rug-able property

Every signature is produced by the parties' own keys, never by Rapport. Each receipt embeds the public keys it was signed with, so anyone holding the receipt can verify it without contacting Rapport's servers or trusting any third party. If Rapport disappeared tomorrow, every receipt minted to date would remain a valid, verifiable artifact.

This is a structural property of the protocol, not a marketing claim. Read [`src/crypto.ts`](./src/crypto.ts) and the tests next to it — that's the entirety of the trust surface.

## Usage

This package is consumed primarily by [`build-rapport`](../sdk) (the TypeScript SDK), which bundles it. End users typically install `build-rapport` rather than this package directly. The schema and verification logic are documented here so that anyone — auditor, framework author, alternative client — can re-implement or check the protocol from first principles.

## License

MIT — see [LICENSE](./LICENSE).

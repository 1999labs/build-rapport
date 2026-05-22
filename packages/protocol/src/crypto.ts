/**
 * Cryptographic signing module for Rapport.
 *
 * This is the un-rug-able core (CLAUDE.md principle #3): every receipt is
 * signed with the parties' own Ed25519 keys, and any signature can be verified
 * offline with nothing but the payload and the public key.
 *
 * We never roll our own crypto — Ed25519 comes from `@noble/curves` and
 * SHA-256 from `@noble/hashes`.
 */

import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import canonicalize from "canonicalize";

/** Generate a fresh Ed25519 keypair. Both keys are raw 32-byte values. */
export function generateKeypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/**
 * Sign a payload string.
 *
 * The payload is UTF-8 encoded, SHA-256 hashed, and the hash is Ed25519
 * signed. Returns the signature as a hex string. Signing is deterministic:
 * the same payload and key always produce the same signature.
 */
export function sign(payload: string, privateKey: Uint8Array): string {
  const hash = sha256(new TextEncoder().encode(payload));
  return bytesToHex(ed25519.sign(hash, privateKey));
}

/**
 * Verify a signature against a payload and public key.
 *
 * Returns `true` only if the signature is cryptographically valid for this
 * exact payload and key. Returns `false` for any invalid input — a tampered
 * payload, a wrong key, or malformed hex — and never throws.
 */
export function verify(payload: string, signature: string, publicKey: string): boolean {
  try {
    const hash = sha256(new TextEncoder().encode(payload));
    return ed25519.verify(hexToBytes(signature), hash, hexToBytes(publicKey));
  } catch {
    return false;
  }
}

/**
 * Serialize a data object to canonical JSON (RFC 8785 JCS): sorted keys, no
 * whitespace. Two objects with the same contents always produce the same
 * string, which is what makes a signature reproducible by any verifier.
 *
 * Throws if `data` is not JSON-serializable.
 */
export function buildSigningPayload(data: Record<string, unknown>): string {
  const json = canonicalize(data);
  if (json === undefined) {
    throw new TypeError("buildSigningPayload: data is not JSON-serializable");
  }
  return json;
}

/** Hex-encoded SHA-256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(input)));
}

/** Derive the Ed25519 public key (hex) for a private key (hex). */
export function publicKeyFromPrivateKey(privateKey: string): string {
  return bytesToHex(ed25519.getPublicKey(hexToBytes(privateKey)));
}

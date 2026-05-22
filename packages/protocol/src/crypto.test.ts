import { bytesToHex } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";
import {
  buildSigningPayload,
  generateKeypair,
  publicKeyFromPrivateKey,
  sha256Hex,
  sign,
  verify,
} from "./crypto";

describe("generateKeypair", () => {
  it("produces raw 32-byte Ed25519 keys", () => {
    const { privateKey, publicKey } = generateKeypair();
    expect(privateKey).toBeInstanceOf(Uint8Array);
    expect(publicKey).toBeInstanceOf(Uint8Array);
    expect(privateKey).toHaveLength(32);
    expect(publicKey).toHaveLength(32);
  });

  it("produces a distinct keypair on each call", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(bytesToHex(a.privateKey)).not.toBe(bytesToHex(b.privateKey));
    expect(bytesToHex(a.publicKey)).not.toBe(bytesToHex(b.publicKey));
  });
});

describe("buildSigningPayload", () => {
  it("sorts keys and emits no whitespace", () => {
    const out = buildSigningPayload({ b: 1, a: 2, c: { z: 3, y: 4 } });
    expect(out).toBe('{"a":2,"b":1,"c":{"y":4,"z":3}}');
  });

  it("is independent of input key order", () => {
    expect(buildSigningPayload({ x: 1, y: 2 })).toBe(buildSigningPayload({ y: 2, x: 1 }));
  });

  it("throws when the input is not JSON-serializable", () => {
    // Cast past the type to exercise the unserializable branch.
    expect(() => buildSigningPayload(undefined as unknown as Record<string, unknown>)).toThrow(
      TypeError,
    );
  });
});

describe("sign / verify", () => {
  it("round-trips: a signature verifies for its payload and key", () => {
    const { privateKey, publicKey } = generateKeypair();
    const payload = buildSigningPayload({ receipt_id: "r1", category: "code_review" });
    const signature = sign(payload, privateKey);
    expect(verify(payload, signature, bytesToHex(publicKey))).toBe(true);
  });

  it("is deterministic for the same payload and key", () => {
    const { privateKey } = generateKeypair();
    const payload = buildSigningPayload({ a: 1, b: 2 });
    expect(sign(payload, privateKey)).toBe(sign(payload, privateKey));
  });

  it("fails verification when the payload is tampered with", () => {
    const { privateKey, publicKey } = generateKeypair();
    const payload = buildSigningPayload({ amount: 100 });
    const signature = sign(payload, privateKey);
    const tampered = buildSigningPayload({ amount: 999 });
    expect(verify(tampered, signature, bytesToHex(publicKey))).toBe(false);
  });

  it("fails verification under a wrong public key", () => {
    const signer = generateKeypair();
    const other = generateKeypair();
    const payload = buildSigningPayload({ a: 1 });
    const signature = sign(payload, signer.privateKey);
    expect(verify(payload, signature, bytesToHex(other.publicKey))).toBe(false);
  });

  it("returns false (never throws) for a malformed signature", () => {
    const { publicKey } = generateKeypair();
    const payload = buildSigningPayload({ a: 1 });
    expect(verify(payload, "not-hex", bytesToHex(publicKey))).toBe(false);
  });

  it("returns false (never throws) for a malformed public key", () => {
    const { privateKey } = generateKeypair();
    const payload = buildSigningPayload({ a: 1 });
    const signature = sign(payload, privateKey);
    expect(verify(payload, signature, "xyz")).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("matches the known SHA-256 digest of 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("produces 64 hex characters", () => {
    expect(sha256Hex("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("publicKeyFromPrivateKey", () => {
  it("derives the same public key generateKeypair produced", () => {
    const { privateKey, publicKey } = generateKeypair();
    expect(publicKeyFromPrivateKey(bytesToHex(privateKey))).toBe(bytesToHex(publicKey));
  });

  it("produces a signature that verifies under the derived key", () => {
    const { privateKey } = generateKeypair();
    const payload = buildSigningPayload({ a: 1 });
    const signature = sign(payload, privateKey);
    expect(verify(payload, signature, publicKeyFromPrivateKey(bytesToHex(privateKey)))).toBe(true);
  });
});

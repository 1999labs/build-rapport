/**
 * Receipt schema for Rapport v1.
 *
 * A receipt is the un-rug-able artifact behind every verified connection.
 * Party A signs first; the receipt is "unilateral" until party B
 * countersigns, at which point it is "bilateral" / verified.
 */

/**
 * The kind of party in a receipt.
 *
 * `service` and `human` are reserved for forward-compatibility (v2 and v3);
 * v1 only ever uses `agent`.
 */
export type PartyType = "agent" | "service" | "human";

/** The outcome of the interaction a receipt records. */
export type Outcome = "success" | "failure" | "partial";

/** A signed (or partially signed) record of one interaction between two parties. */
export interface Receipt {
  /** Unique receipt identifier. */
  id: string;
  /** Initiating party's agent ID. */
  party_a: string;
  /** Counterparty's agent ID. */
  party_b: string;
  /** Party A's signature over the signing payload. */
  party_a_signature: string;
  /** Party B's countersignature. `null` until the receipt is countersigned. */
  party_b_signature: string | null;
  /** Party A's Ed25519 public key, hex-encoded. */
  party_a_public_key: string;
  /** Party B's Ed25519 public key, hex-encoded. `null` until countersigned. */
  party_b_public_key: string | null;
  /** Interaction category (e.g. `"code_review"`). */
  category: string;
  /** How the interaction resolved. */
  outcome: Outcome;
  /** Hash of the interaction payload; the payload itself stays private. */
  payload_hash: string;
  /** Open extension point. Not part of the signed payload. */
  metadata: Record<string, unknown>;
  /** ISO 8601 timestamp of when the receipt was created. */
  created_at: string;
}

/**
 * The subset of a `Receipt` that gets signed by both parties.
 *
 * Signatures, public keys, and `metadata` are deliberately excluded: both
 * parties sign this exact view, so each signature commits to the identity of
 * the interaction without depending on the other party's signature.
 */
export type ReceiptSigningPayload = Pick<
  Receipt,
  "id" | "party_a" | "party_b" | "category" | "outcome" | "payload_hash" | "created_at"
>;

/**
 * A source of signatures (Rule B, CLAUDE.md §2.5).
 *
 * The protocol only consumes this interface; concrete implementations
 * (Rapport-issued key, operator-supplied key) live in `build-rapport`.
 */
export interface Signer {
  /** Sign a canonical payload string, returning the signature as hex. */
  sign(payload: string): Promise<string>;
  /** This signer's Ed25519 public key, hex-encoded. */
  publicKey(): string;
}

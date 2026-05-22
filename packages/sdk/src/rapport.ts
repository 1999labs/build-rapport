/**
 * The Rapport SDK client.
 *
 * A thin HTTP client over the Rapport API. All business logic lives in the
 * API; this class handles auth headers, request serialization, optional
 * client-side signing, and Mechanism 1 header injection.
 */

import { buildSigningPayload, publicKeyFromPrivateKey, sha256Hex, sign, verify } from "@rapport/protocol";
import type { Outcome, Receipt } from "@rapport/protocol";
import { nanoid } from "nanoid";
import { RapportError, type RapportErrorCode } from "./errors";

const DEFAULT_BASE_URL = "https://rapport.sh";
const HEX_64 = /^[0-9a-fA-F]{64}$/;

/** Options for constructing a {@link Rapport} client. */
export interface RapportOptions {
  /** Operator API key, e.g. `"rk_live_..."`. */
  apiKey: string;
  /** This agent's ID, e.g. `"agt_..."`. */
  agentId: string;
  /**
   * Optional hex-encoded Ed25519 private key. When provided, receipts are
   * signed client-side; when absent, the server signs with the agent's
   * stored key.
   */
  signingKey?: string;
  /** API base URL. Defaults to `"https://rapport.sh"`. */
  baseUrl?: string;
}

/** Parameters for {@link Rapport.mint}. */
export interface MintParams {
  counterparty: string;
  category?: string;
  outcome?: Outcome;
  metadata?: Record<string, unknown>;
}

/** Parameters for {@link Rapport.history}. */
export interface HistoryParams {
  counterparty?: string;
  limit?: number;
  offset?: number;
}

/** Result of {@link Rapport.verify}. */
export interface VerifyResult {
  valid: boolean;
  bilateral: boolean;
  receipt: Receipt;
}

/** Result of {@link Rapport.history}. */
export interface HistoryResult {
  receipts: Receipt[];
  total: number;
}

/** A client-side signature, attached to a mint request when `signingKey` is set. */
interface SignedMintInput {
  receipt_id: string;
  created_at: string;
  payload_hash: string;
  signature: string;
  public_key: string;
}

export class Rapport {
  private readonly apiKey: string;
  private readonly agentId: string;
  private readonly signingKey?: string;
  private readonly baseUrl: string;
  private intercepted = false;

  constructor(options: RapportOptions) {
    if (!options.apiKey) throw new RapportError("invalid_request", "apiKey is required");
    if (!options.agentId) throw new RapportError("invalid_request", "agentId is required");
    this.apiKey = options.apiKey;
    this.agentId = options.agentId;
    this.signingKey = options.signingKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  /**
   * Mint a receipt for an interaction with a counterparty. When a `signingKey`
   * was configured, the receipt is signed client-side and the signature is
   * included in the request; otherwise the server signs with the stored key.
   */
  async mint(params: MintParams): Promise<Receipt> {
    const body: Record<string, unknown> = {
      counterparty: params.counterparty,
      category: params.category ?? "general",
      outcome: params.outcome ?? "success",
      metadata: params.metadata ?? {},
    };
    if (this.signingKey) {
      body.signed = this.signLocally(params);
    }
    return this.request<Receipt>("POST", "/api/receipts", { auth: true, body });
  }

  /** Countersign a receipt addressed to this agent, making the connection bilateral. */
  async countersign(receiptId: string): Promise<Receipt> {
    return this.request<Receipt>(
      "POST",
      `/api/receipts/${encodeURIComponent(receiptId)}/countersign`,
      { auth: true },
    );
  }

  /** Verify a receipt. Public — no API key required. */
  async verify(receiptId: string): Promise<VerifyResult> {
    return this.request<VerifyResult>(
      "GET",
      `/api/receipts/${encodeURIComponent(receiptId)}/verify`,
      { auth: false },
    );
  }

  /** List receipts this agent initiated, optionally filtered to one counterparty. */
  async history(params: HistoryParams = {}): Promise<HistoryResult> {
    const query = new URLSearchParams();
    if (params.counterparty) query.set("counterparty", params.counterparty);
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.offset !== undefined) query.set("offset", String(params.offset));
    const qs = query.toString();
    return this.request<HistoryResult>("GET", `/api/receipts${qs ? `?${qs}` : ""}`, {
      auth: true,
    });
  }

  /**
   * Mechanism 1 — wrap an outbound call to another agent.
   *
   * Behaves like the native `fetch`, but injects this agent's Rapport identity
   * headers so the counterparty can recognize you and connect back. Opt-in:
   * replace your own `fetch` calls to other agents with `rapport.fetch`.
   */
  async fetch(url: string, options: RequestInit = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    headers.set("X-Rapport-Agent", this.agentId);
    headers.set("X-Rapport-Profile", `${this.baseUrl}/agent/${this.agentId}`);
    return fetch(url, { ...options, headers });
  }

  /**
   * Automatic mode — replace `globalThis.fetch` with a wrapped version that
   * injects Rapport identity headers on every outbound call and auto-mints a
   * receipt whenever the response names a Rapport agent in its
   * `X-Rapport-Agent` header. Idempotent: a second call is a no-op.
   *
   * The auto-mint is fire-and-forget — it never delays or fails the original
   * request. Calls to this client's own `baseUrl` are passed through untouched
   * to avoid recursion.
   */
  intercept(): void {
    if (this.intercepted) return;
    this.intercepted = true;
    const original = globalThis.fetch.bind(globalThis);

    const inject = (h: Headers): Headers => {
      h.set("X-Rapport-Agent", this.agentId);
      h.set("X-Rapport-Profile", `${this.baseUrl}/agent/${this.agentId}`);
      return h;
    };

    const wrapped: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      // Pass requests to our own API straight through: otherwise mint() →
      // fetch() → wrapped → mint() would loop, and we'd be tagging our own
      // API calls with our identity headers.
      if (url.startsWith(this.baseUrl)) {
        return original(input, init);
      }

      let response: Response;
      if (input instanceof Request) {
        const headers = inject(new Headers(input.headers));
        response = await original(new Request(input, { headers }), init);
      } else {
        response = await original(input, { ...init, headers: inject(new Headers(init?.headers)) });
      }

      const counterparty = response.headers.get("X-Rapport-Agent");
      if (counterparty && counterparty !== this.agentId) {
        const outcome: Outcome = response.status < 400 ? "success" : "failure";
        const category = inferCategory(url);
        this.mint({ counterparty, category, outcome }).catch(() => {
          // Fire-and-forget — a failed auto-mint must never surface.
        });
      }

      return response;
    };

    globalThis.fetch = wrapped;
  }

  /** Build and sign a receipt payload client-side. */
  private signLocally(params: MintParams): SignedMintInput {
    const signingKey = this.signingKey;
    if (!signingKey) {
      throw new RapportError("invalid_request", "signingKey is not configured");
    }
    if (!HEX_64.test(signingKey)) {
      throw new RapportError("invalid_request", "signingKey must be a 32-byte hex string");
    }

    const receiptId = `rct_${nanoid(16)}`;
    const createdAt = new Date().toISOString();
    const payloadHash = sha256Hex(buildSigningPayload(params.metadata ?? {}));
    const message = buildSigningPayload({
      id: receiptId,
      party_a: this.agentId,
      party_b: params.counterparty,
      category: params.category ?? "general",
      outcome: params.outcome ?? "success",
      payload_hash: payloadHash,
      created_at: createdAt,
    });

    const signature = sign(message, Buffer.from(signingKey, "hex"));
    const publicKey = publicKeyFromPrivateKey(signingKey);
    if (!verify(message, signature, publicKey)) {
      throw new RapportError("verification_failed", "Local signature failed self-verification");
    }

    return {
      receipt_id: receiptId,
      created_at: createdAt,
      payload_hash: payloadHash,
      signature,
      public_key: publicKey,
    };
  }

  /** Issue an API request and parse the response, throwing `RapportError` on failure. */
  private async request<T>(
    method: string,
    path: string,
    opts: { auth: boolean; body?: unknown },
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (opts.auth) headers.authorization = `Bearer ${this.apiKey}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch {
      throw new RapportError("network_error", `Could not reach the Rapport API at ${path}`);
    }

    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new RapportError("network_error", "The API returned a malformed response", response.status);
    }

    if (!response.ok) {
      throw new RapportError(
        codeForStatus(response.status),
        errorMessage(json) ?? `Request failed with status ${response.status}`,
        response.status,
      );
    }

    return json as T;
  }
}

/**
 * Best-effort category derived from the last meaningful URL path segment.
 * Rapport-ish ID segments (agt_/rct_/clm_/key_) are skipped so the category
 * is a verb-ish noun ("messages") rather than an identifier ("agt_xyz").
 */
function inferCategory(url: string): string | undefined {
  try {
    const segments = new URL(url).pathname
      .split("/")
      .filter((s) => s.length > 0 && !/^(agt|rct|clm|key)_/.test(s));
    return segments[segments.length - 1] || undefined;
  } catch {
    return undefined;
  }
}

/** Map an HTTP status to a `RapportErrorCode`. */
function codeForStatus(status: number): RapportErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status >= 400 && status < 500) return "invalid_request";
  return "network_error";
}

/** Pull the `error` message out of an API error body, if present. */
function errorMessage(json: unknown): string | undefined {
  if (json && typeof json === "object" && "error" in json) {
    const value = (json as { error: unknown }).error;
    if (typeof value === "string") return value;
  }
  return undefined;
}

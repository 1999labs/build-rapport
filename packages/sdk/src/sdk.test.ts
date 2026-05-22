import { generateKeypair } from "@rapport/protocol";
import type { Receipt } from "@rapport/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RapportError } from "./errors";
import { Rapport } from "./rapport";

const sampleReceipt: Receipt = {
  id: "rct_sample",
  party_a: "agt_a",
  party_b: "agt_b",
  party_a_signature: "a1",
  party_b_signature: null,
  party_a_public_key: "pk_a",
  party_b_public_key: null,
  category: "research",
  outcome: "success",
  payload_hash: "hash",
  metadata: {},
  created_at: "2026-01-01T00:00:00.000Z",
};

/** Stub global `fetch` with a mock that resolves the given JSON payload. */
function mockFetch(payload: unknown, status = 200) {
  const fn = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

function client(signingKey?: string) {
  return new Rapport({ apiKey: "rk_live_test", agentId: "agt_a", signingKey });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("constructor", () => {
  it("throws RapportError when apiKey is missing", () => {
    expect(() => new Rapport({ apiKey: "", agentId: "agt_a" })).toThrow(RapportError);
  });

  it("throws RapportError when agentId is missing", () => {
    expect(() => new Rapport({ apiKey: "rk_live_test", agentId: "" })).toThrow(RapportError);
  });
});

describe("mint", () => {
  it("POSTs to /api/receipts with a Bearer token and returns the receipt", async () => {
    const fn = mockFetch(sampleReceipt);
    const result = await client().mint({ counterparty: "agt_b", category: "research" });

    expect(result).toEqual(sampleReceipt);
    const [url, init] = fn.mock.calls[0] ?? [];
    expect(url).toBe("https://rapport.sh/api/receipts");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer rk_live_test");
  });

  it("sends no `signed` block when no signingKey is configured", async () => {
    const fn = mockFetch(sampleReceipt);
    await client().mint({ counterparty: "agt_b", category: "research" });

    const body = JSON.parse((fn.mock.calls[0]?.[1]?.body as string) ?? "{}");
    expect(body.signed).toBeUndefined();
  });
});

describe("countersign", () => {
  it("POSTs to the countersign endpoint and returns the updated receipt", async () => {
    const countersigned: Receipt = { ...sampleReceipt, party_b_signature: "b1" };
    const fn = mockFetch(countersigned);
    const result = await client().countersign("rct_sample");

    expect(result).toEqual(countersigned);
    const [url, init] = fn.mock.calls[0] ?? [];
    expect(url).toBe("https://rapport.sh/api/receipts/rct_sample/countersign");
    expect(init?.method).toBe("POST");
  });
});

describe("verify", () => {
  it("GETs the public verify endpoint without an auth header", async () => {
    const fn = mockFetch({ valid: true, bilateral: false, receipt: sampleReceipt });
    const result = await client().verify("rct_sample");

    expect(result).toEqual({ valid: true, bilateral: false, receipt: sampleReceipt });
    const [url, init] = fn.mock.calls[0] ?? [];
    expect(url).toBe("https://rapport.sh/api/receipts/rct_sample/verify");
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
  });
});

describe("history", () => {
  it("GETs /api/receipts and returns receipts with a total", async () => {
    const fn = mockFetch({ receipts: [sampleReceipt], total: 1 });
    const result = await client().history({ counterparty: "agt_b", limit: 5 });

    expect(result).toEqual({ receipts: [sampleReceipt], total: 1 });
    const [url] = fn.mock.calls[0] ?? [];
    expect(url).toContain("/api/receipts?");
    expect(url).toContain("counterparty=agt_b");
    expect(url).toContain("limit=5");
  });
});

describe("error handling", () => {
  it("throws `unauthorized` on a 401", async () => {
    mockFetch({ error: "Missing or invalid API key" }, 401);
    await expect(client().mint({ counterparty: "agt_b", category: "x" })).rejects.toMatchObject({
      name: "RapportError",
      code: "unauthorized",
      status: 401,
    });
  });

  it("throws `not_found` on a 404", async () => {
    mockFetch({ error: "Receipt not found" }, 404);
    await expect(client().countersign("rct_missing")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });

  it("throws `network_error` on a 500", async () => {
    mockFetch({ error: "Could not store receipt" }, 500);
    await expect(client().mint({ counterparty: "agt_b", category: "x" })).rejects.toMatchObject({
      code: "network_error",
      status: 500,
    });
  });
});

describe("rapport.fetch (Mechanism 1)", () => {
  it("injects X-Rapport-Agent and X-Rapport-Profile headers", async () => {
    const fn = mockFetch({ ok: true });
    await client().fetch("https://otheragent.com/api/task", { method: "POST" });

    const init = fn.mock.calls[0]?.[1];
    const headers = init?.headers as Headers;
    expect(headers.get("X-Rapport-Agent")).toBe("agt_a");
    expect(headers.get("X-Rapport-Profile")).toBe("https://rapport.sh/agent/agt_a");
  });
});

describe("intercept", () => {
  /** Mock that routes mint calls to a stub receipt and outbound calls to a
   *  configurable response (status + optional X-Rapport-Agent header). */
  function setup(opts: { counterparty?: string; status?: number; mintStatus?: number } = {}) {
    const responseHeaders: HeadersInit = opts.counterparty
      ? { "X-Rapport-Agent": opts.counterparty }
      : {};
    const fn = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://rapport.sh")) {
        return new Response(JSON.stringify(sampleReceipt), {
          status: opts.mintStatus ?? 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: opts.status ?? 200, headers: responseHeaders });
    });
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  /** Yield to the microtask queue so the fire-and-forget mint has a chance to fire. */
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("is idempotent — a second call is a no-op", () => {
    setup();
    const r = client();
    r.intercept();
    const wrapped = globalThis.fetch;
    r.intercept();
    expect(globalThis.fetch).toBe(wrapped);
  });

  it("injects X-Rapport-Agent and X-Rapport-Profile on outbound calls", async () => {
    const fn = setup();
    client().intercept();
    await fetch("https://otheragent.com/api/task");
    const init = fn.mock.calls[0]?.[1];
    const headers = init?.headers as Headers;
    expect(headers.get("X-Rapport-Agent")).toBe("agt_a");
    expect(headers.get("X-Rapport-Profile")).toBe("https://rapport.sh/agent/agt_a");
  });

  it("auto-mints when the response names a Rapport counterparty", async () => {
    const fn = setup({ counterparty: "agt_other" });
    client().intercept();
    await fetch("https://otheragent.com/api/research/summary");
    await flush();

    const mintCall = fn.mock.calls.find((c) =>
      String(c[0]).includes("/api/receipts"),
    );
    expect(mintCall).toBeDefined();
    const body = JSON.parse((mintCall?.[1] as RequestInit).body as string);
    expect(body.counterparty).toBe("agt_other");
    expect(body.outcome).toBe("success");
    expect(body.category).toBe("summary");
  });

  it("does not mint when the response has no X-Rapport-Agent header", async () => {
    const fn = setup();
    client().intercept();
    await fetch("https://otheragent.com/api/task");
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses 'failure' outcome for 4xx/5xx responses", async () => {
    const fn = setup({ counterparty: "agt_other", status: 503 });
    client().intercept();
    await fetch("https://otheragent.com/api/task");
    await flush();

    const mintCall = fn.mock.calls.find((c) =>
      String(c[0]).includes("/api/receipts"),
    );
    const body = JSON.parse((mintCall?.[1] as RequestInit).body as string);
    expect(body.outcome).toBe("failure");
  });

  it("ignores self-loops (response names this agent)", async () => {
    const fn = setup({ counterparty: "agt_a" });
    client().intercept();
    await fetch("https://otheragent.com/api/task");
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("never lets a mint failure surface to the caller", async () => {
    setup({ counterparty: "agt_other", mintStatus: 500 });
    client().intercept();
    const res = await fetch("https://otheragent.com/api/task");
    await flush();
    expect(res.status).toBe(200);
  });
});

describe("client-side signing", () => {
  it("attaches a self-verified signature when signingKey is provided", async () => {
    const { privateKey, publicKey } = generateKeypair();
    const signingKey = Buffer.from(privateKey).toString("hex");
    const fn = mockFetch(sampleReceipt);

    await client(signingKey).mint({ counterparty: "agt_b", category: "research" });

    const body = JSON.parse((fn.mock.calls[0]?.[1]?.body as string) ?? "{}");
    expect(body.signed).toBeDefined();
    expect(body.signed.signature).toMatch(/^[0-9a-f]+$/);
    expect(body.signed.public_key).toBe(Buffer.from(publicKey).toString("hex"));
    expect(body.signed.receipt_id).toMatch(/^rct_/);
  });
});

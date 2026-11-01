import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SettleError, VerifyError, type PaymentPayload, type PaymentRequirements } from "@x402/core/types";
import { classifySettleFailure, SettlementIndeterminateError, TimeoutFacilitatorClient } from "./facilitator.js";

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "casper:casper-test",
  asset: "22".repeat(32),
  amount: "500",
  payTo: `00${"11".repeat(32)}`,
  maxTimeoutSeconds: 300,
  extra: { name: "T", version: "1" },
};
const payload: PaymentPayload = { x402Version: 2, accepted: requirements, payload: {} };

type FetchImpl = typeof fetch;

const respond =
  (status: number, body: string, seen?: { auth?: string | null; url?: string }): FetchImpl =>
  async (url, init) => {
    if (seen) {
      seen.url = String(url);
      seen.auth = new Headers(init?.headers).get("authorization");
    }
    return new Response(body, { status });
  };

/** A fetch that only ever settles by being aborted. */
const hanging: FetchImpl = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

function client(fetchImpl: FetchImpl, timeoutMs = 50): TimeoutFacilitatorClient {
  return new TimeoutFacilitatorClient({
    url: "http://facilitator.test/",
    authorization: "secret-token",
    verifyTimeoutMs: timeoutMs,
    settleTimeoutMs: timeoutMs,
    fetchImpl,
  });
}

describe("TimeoutFacilitatorClient.verify", () => {
  it("returns the verdict and sends the configured Authorization header verbatim", async () => {
    const seen: { auth?: string | null; url?: string } = {};
    const result = await client(respond(200, JSON.stringify({ isValid: true, payer: "00ab" }), seen)).verify(payload, requirements);
    assert.deepEqual({ isValid: result.isValid, payer: result.payer }, { isValid: true, payer: "00ab" });
    assert.equal(seen.auth, "secret-token");
    assert.equal(seen.url, "http://facilitator.test/verify");
  });

  it("times out with a plain error (nothing moves on verify)", async () => {
    await assert.rejects(client(hanging).verify(payload, requirements), (err: unknown) => {
      assert.ok(!(err instanceof SettlementIndeterminateError));
      assert.match((err as Error).message, /timed out after 50 ms/);
      return true;
    });
  });

  it("raises VerifyError for a structured rejection and a plain error otherwise", async () => {
    await assert.rejects(client(respond(400, JSON.stringify({ isValid: false, invalidReason: "nope" }))).verify(payload, requirements), VerifyError);
    await assert.rejects(client(respond(500, "<html>")).verify(payload, requirements), /HTTP 500/);
    await assert.rejects(client(respond(200, "not json")).verify(payload, requirements), /invalid answer/);
  });
});

describe("TimeoutFacilitatorClient.settle", () => {
  it("returns a successful settlement", async () => {
    const result = await client(
      respond(200, JSON.stringify({ success: true, transaction: "ab", network: "casper:casper-test", payer: "00cd" })),
    ).settle(payload, requirements);
    assert.equal(result.success, true);
    assert.equal(result.transaction, "ab");
  });

  it("returns an explicit failure verdict as is", async () => {
    const result = await client(respond(200, JSON.stringify({ success: false, errorReason: "x", transaction: "" }))).settle(payload, requirements);
    assert.equal(result.success, false);
    assert.equal(result.errorReason, "x");
    assert.equal(result.network, "casper:casper-test");
  });

  it("treats a timeout, a network error, a 5xx without verdict and an unreadable answer as indeterminate", async () => {
    const indeterminate: FetchImpl[] = [
      hanging,
      async () => {
        throw new TypeError("fetch failed");
      },
      respond(502, "<html>Bad Gateway</html>"),
      respond(500, JSON.stringify({ error: "boom" })),
      respond(200, "{truncated"),
      respond(200, JSON.stringify({ ok: true })),
    ];
    for (const fetchImpl of indeterminate) {
      await assert.rejects(client(fetchImpl).settle(payload, requirements), SettlementIndeterminateError);
    }
  });

  it("treats a 4xx refusal and a structured non-2xx verdict as determinate failures", async () => {
    await assert.rejects(client(respond(401, "unauthorized")).settle(payload, requirements), (err: unknown) => {
      assert.ok(err instanceof SettleError);
      assert.equal(err.errorReason, "facilitator_http_401");
      return true;
    });
    await assert.rejects(
      client(respond(500, JSON.stringify({ success: false, errorReason: "rpc_down", transaction: "" }))).settle(payload, requirements),
      SettleError,
    );
  });
});

describe("TimeoutFacilitatorClient.getSupported", () => {
  it("validates the supported kinds", async () => {
    const supported = await client(respond(200, JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "casper:casper-test" }] }))).getSupported();
    assert.equal(supported.kinds.length, 1);
    assert.deepEqual(supported.extensions, []);
    await assert.rejects(client(respond(200, JSON.stringify({}))).getSupported(), /invalid answer/);
    await assert.rejects(client(hanging).getSupported(), /timed out/);
  });
});

describe("classifySettleFailure", () => {
  const settleFailed = "invalid_exact_casper_facilitator_settle_failed";
  const tx = "ef".repeat(32);
  const cases: Array<[string | undefined, string | undefined, string | undefined, "failed" | "unknown", boolean]> = [
    // Rejected before anything was submitted.
    ["invalid_exact_casper_facilitator_expired", "validBefore=1 < now=2", undefined, "failed", false],
    ["invalid_exact_casper_facilitator_invalid_signature", undefined, "", "failed", false],
    ["facilitator_http_429", "rate limit", undefined, "failed", false],
    // Definite rejections whose names contain words like "network" or "unknown".
    ["unsupported_network", undefined, "", "failed", true],
    ["invalid_network", "network mismatch", "", "failed", true],
    ["unknown_asset", "unknown asset 22…", "", "failed", true],
    ["invalid_exact_casper_facilitator_network_mismatch", "payload=casper:casper requirements=casper:casper-test", "", "failed", false],
    // Submitted and reverted on-chain: final, but the nonce may have been used by someone else.
    [settleFailed, "transaction execution failed: User error: 64658", undefined, "failed", true],
    ["settle_failed", "transaction execution failed: Out of gas", tx, "failed", true],
    // Submitted (or maybe submitted) and then lost track of.
    [settleFailed, "Timed out waiting for transaction 1234", undefined, "unknown", true],
    [settleFailed, "HttpError: RPC error: transaction not found", undefined, "unknown", true],
    ["settle_pending", undefined, undefined, "unknown", true],
    [undefined, "socket hang up", undefined, "unknown", true],
    ["rpc_error", "network error while polling", undefined, "unknown", true],
    // A transaction hash means the transfer was submitted: it may still execute.
    ["insufficient_balance", undefined, tx, "unknown", true],
    ["unsupported_network", "lost the node after submitting", tx, "unknown", true],
    // Anything else from another facilitator: failed, but worth an on-chain look.
    ["insufficient_balance", undefined, "", "failed", true],
  ];
  for (const [reason, message, transaction, kind, checkChain] of cases) {
    it(`${reason ?? "(no reason)"} / ${message ?? "(no message)"}${transaction ? " / with tx" : ""} → ${kind}`, () => {
      assert.deepEqual(classifySettleFailure(reason, message, transaction), { kind, checkChain });
    });
  }
});

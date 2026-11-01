import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import casperSdk from "casper-js-sdk";
import type { SettleResponse, VerifyResponse } from "@x402/core/types";
import type { CoreResult, FacilitatorCore, FacilitatorLogger, ParsedPayment } from "./facilitator-core.js";
import { createFacilitatorApp, startRealFacilitator, type FacilitatorAppOptions } from "./real-facilitator.js";

const { PrivateKey, KeyAlgorithm } = casperSdk;

const NETWORK = "casper:casper-test" as const;
const TOKEN = "9d2f4b6c8e0a1c3e5f7b9d1f3a5c7e9b0d2f4a6c8e0b1d3f5a7c9e1b3d5f7a9c";
const quiet: FacilitatorLogger = { info: () => {}, warn: () => {}, error: () => {} };

function requestBody(from = `00${"65".repeat(32)}`, nonce = "9c".repeat(32)) {
  const now = Math.floor(Date.now() / 1000);
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted: { scheme: "exact", network: NETWORK },
      payload: {
        signature: `01${"ab".repeat(64)}`,
        publicKey: `01${"cd".repeat(32)}`,
        authorization: { from, to: `00${"88".repeat(32)}`, value: "5", validAfter: String(now - 60), validBefore: String(now + 300), nonce },
      },
    },
    paymentRequirements: {
      scheme: "exact",
      network: NETWORK,
      asset: "cb".repeat(32),
      amount: "5",
      payTo: `00${"88".repeat(32)}`,
      maxTimeoutSeconds: 300,
      extra: { name: "T", version: "1" },
    },
  };
}

class FakeCore implements FacilitatorCore {
  verifyStatus = 200;
  /** Simulate a bug in the core (an exception after it may have submitted). */
  throws = false;
  calls: string[] = [];
  async verify(p: ParsedPayment): Promise<CoreResult<VerifyResponse>> {
    this.calls.push(`verify ${p.authorization.from.slice(0, 6)}`);
    if (this.throws) throw new Error("boom\nwith a second line");
    return { status: this.verifyStatus, body: { isValid: this.verifyStatus === 200, payer: p.authorization.from } };
  }
  async settle(p: ParsedPayment): Promise<CoreResult<SettleResponse>> {
    this.calls.push(`settle ${p.authorization.from.slice(0, 6)}`);
    if (this.throws) throw new Error("boom after submission");
    return { status: 200, body: { success: true, transaction: "aa".repeat(32), network: NETWORK, payer: p.authorization.from } };
  }
  supported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, extra: { feePayer: "fe" } }], extensions: [], signers: {} };
  }
}

async function serve(core: FacilitatorCore, over: Partial<FacilitatorAppOptions> = {}) {
  const app = createFacilitatorApp(core, {
    network: NETWORK,
    authToken: TOKEN,
    maxSettlesPerMinute: 100,
    maxRequestsPerMinute: 100,
    maxRequestsPerPayerPerMinute: 100,
    maxRequestsPerIpPerMinute: 1000,
    logger: quiet,
    ...over,
  });
  const server: Server = createServer(app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  /** `auth: null` sends no Authorization header. */
  const post = async (path: string, payload: unknown, auth: string | null = TOKEN, raw?: string) => {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth !== null ? { authorization: auth } : {}) },
      body: raw ?? JSON.stringify(payload),
    });
    return { status: res.status, type: res.headers.get("content-type") ?? "", body: (await res.json()) as Record<string, unknown> };
  };
  return {
    base,
    post,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

describe("HTTP surface: authentication (CodeQL js/user-controlled-bypass)", () => {
  test("missing or wrong token → 401 in the x402 shape of each route", async () => {
    const core = new FakeCore();
    const s = await serve(core);
    try {
      const v = await s.post("/verify", requestBody(), null);
      assert.equal(v.status, 401);
      assert.deepEqual([v.body["isValid"], v.body["invalidReason"]], [false, "unauthorized"]);
      const st = await s.post("/settle", requestBody(), "Bearer nope");
      assert.equal(st.status, 401);
      assert.deepEqual([st.body["success"], st.body["errorReason"], st.body["transaction"]], [false, "unauthorized", ""]);
      assert.deepEqual(st.body["extra"], { settlementStatus: "not_submitted" });
      assert.equal(core.calls.length, 0);
    } finally {
      await s.close();
    }
  });

  test("the raw token (what the gateway sends today) and Bearer <token> both pass", async () => {
    const core = new FakeCore();
    const s = await serve(core);
    try {
      assert.equal((await s.post("/verify", requestBody(), TOKEN)).status, 200);
      assert.equal((await s.post("/settle", requestBody(), `Bearer ${TOKEN}`)).status, 200);
    } finally {
      await s.close();
    }
  });

  test("malformed JSON and malformed payloads → 400 JSON, never an HTML error page", async () => {
    const s = await serve(new FakeCore());
    try {
      const bad = await s.post("/verify", null, TOKEN, "{not json");
      assert.equal(bad.status, 400);
      assert.match(bad.type, /application\/json/);
      assert.equal(bad.body["invalidReason"], "invalid_request");
      const badSettle = await s.post("/settle", null, TOKEN, "{not json");
      assert.deepEqual([badSettle.status, badSettle.body["errorReason"]], [400, "invalid_request"]);
      assert.deepEqual(badSettle.body["extra"], { settlementStatus: "not_submitted" }, "nothing reached the core");
      const missing = await s.post("/settle", { paymentPayload: {} }, TOKEN);
      assert.equal(missing.status, 400);
      assert.equal(missing.body["errorReason"], "invalid_request");
      const unknown = await fetch(`${s.base}/nope`);
      assert.equal(unknown.status, 404);
      assert.deepEqual(await unknown.json(), { error: "not_found", message: "no such route" });
    } finally {
      await s.close();
    }
  });

  test("an internal error on /settle is an UNKNOWN outcome, never 'not submitted'", async () => {
    const core = new FakeCore();
    core.throws = true;
    const s = await serve(core);
    try {
      const st = await s.post("/settle", requestBody());
      assert.equal(st.status, 500);
      assert.match(st.type, /application\/json/);
      assert.deepEqual([st.body["success"], st.body["errorReason"], st.body["transaction"]], [false, "settlement_unknown", ""]);
      assert.deepEqual(st.body["extra"], { settlementStatus: "unknown" });
      assert.doesNotMatch(String(st.body["errorMessage"]), /boom/, "no raw error text");
      const v = await s.post("/verify", requestBody());
      assert.deepEqual([v.status, v.body["isValid"], v.body["invalidReason"]], [500, false, "internal_error"]);
    } finally {
      await s.close();
    }
  });

  test("core status codes pass through (409 duplicate, 503 cap)", async () => {
    const core = new FakeCore();
    core.verifyStatus = 409;
    const s = await serve(core);
    try {
      assert.equal((await s.post("/verify", requestBody())).status, 409);
    } finally {
      await s.close();
    }
  });
});

describe("HTTP surface: rate limits (CodeQL js/missing-rate-limiting)", () => {
  test("per payer on /verify + /settle; other payers are unaffected", async () => {
    const s = await serve(new FakeCore(), { maxRequestsPerPayerPerMinute: 2 });
    try {
      const alice = `00${"a1".repeat(32)}`;
      assert.equal((await s.post("/verify", requestBody(alice))).status, 200);
      assert.equal((await s.post("/settle", requestBody(alice))).status, 200);
      const limited = await s.post("/verify", requestBody(alice));
      assert.equal(limited.status, 429);
      assert.equal(limited.body["invalidReason"], "rate_limited");
      assert.equal((await s.post("/verify", requestBody(`00${"b2".repeat(32)}`))).status, 200);
    } finally {
      await s.close();
    }
  });

  test("global limit across all payers, and a separate settle limit", async () => {
    const s = await serve(new FakeCore(), { maxRequestsPerMinute: 3, maxSettlesPerMinute: 1 });
    try {
      assert.equal((await s.post("/settle", requestBody(`00${"01".repeat(32)}`))).status, 200);
      const settle2 = await s.post("/settle", requestBody(`00${"02".repeat(32)}`));
      assert.equal(settle2.status, 429);
      assert.deepEqual([settle2.body["success"], settle2.body["errorReason"]], [false, "rate_limited"]);
      // The rejected settle still counted against the global budget (it is checked first).
      assert.equal((await s.post("/verify", requestBody(`00${"03".repeat(32)}`))).status, 200);
      const global = await s.post("/verify", requestBody(`00${"04".repeat(32)}`));
      assert.equal(global.status, 429, "3 requests used the global budget");
      assert.equal(global.body["invalidReason"], "rate_limited");
    } finally {
      await s.close();
    }
  });

  test("unauthenticated traffic is limited per IP and does not consume payer/global budgets", async () => {
    const core = new FakeCore();
    const s = await serve(core, { maxRequestsPerPayerPerMinute: 1, maxRequestsPerMinute: 1, maxRequestsPerIpPerMinute: 6 });
    try {
      for (let i = 0; i < 4; i++) assert.equal((await s.post("/verify", requestBody(), "wrong")).status, 401);
      assert.equal((await s.post("/verify", requestBody())).status, 200);
      assert.equal((await fetch(`${s.base}/health`)).status, 200);
      assert.equal((await fetch(`${s.base}/health`)).status, 429, "per-IP limit covers every route");
    } finally {
      await s.close();
    }
  });
});

describe("startRealFacilitator start-up rules (M07)", () => {
  let dir: string;
  let feePayerPem: string;
  let feePayerHash: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cascet-fac-"));
    const key = PrivateKey.generate(KeyAlgorithm.ED25519);
    feePayerPem = join(dir, "fee-payer_secret_key.pem");
    writeFileSync(feePayerPem, key.toPem(), { mode: 0o600 });
    feePayerHash = key.publicKey.accountHash().toHex();
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const SELLER = `00${"88".repeat(32)}`;
  const OWNER = `00${"0e".repeat(32)}`;
  const mainnet = () => ({
    port: 0,
    network: "casper:casper" as const,
    keyPath: feePayerPem,
    authToken: TOKEN,
    allowedPayTo: [SELLER],
    allowedAssets: ["8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41"],
    ownerAccountHash: OWNER,
    rpcUrl: "http://127.0.0.1:9/rpc", // never contacted at start-up
    logger: quiet,
  });

  test("refuses mainnet when the fee payer is the owner or a seller", async () => {
    await assert.rejects(startRealFacilitator({ ...mainnet(), ownerAccountHash: `00${feePayerHash}` }), /contract owner/);
    await assert.rejects(startRealFacilitator({ ...mainnet(), allowedPayTo: [SELLER, `00${feePayerHash}`] }), /seller/);
    const { ownerAccountHash: _omit, ...noOwner } = mainnet();
    await assert.rejects(startRealFacilitator(noOwner), /CASCET_OWNER_ACCOUNT_HASH/);
  });

  test("refuses mainnet without a strong token, allowlists, or with a too-low gas limit", async () => {
    const { authToken: _t, ...noToken } = mainnet();
    await assert.rejects(startRealFacilitator(noToken), /required/);
    await assert.rejects(startRealFacilitator({ ...mainnet(), authToken: "short-token" }), /at least 32/);
    await assert.rejects(startRealFacilitator({ ...mainnet(), allowedAssets: [] }), /allowedAssets/);
    await assert.rejects(startRealFacilitator({ ...mainnet(), paymentMotes: 2_000_000_000 }), /paymentMotes/);
  });

  test("the preflight is required on mainnet; elsewhere turning it off needs a pinned token name", async () => {
    await assert.rejects(startRealFacilitator({ ...mainnet(), preflight: false }), /preflight is required on mainnet/);
    await assert.rejects(startRealFacilitator({ port: 0, keyPath: feePayerPem, preflight: false, logger: quiet }), /tokenName/);
    const fac = await startRealFacilitator({ port: 0, keyPath: feePayerPem, preflight: false, tokenName: "CasCet X402 Token", logger: quiet });
    await fac.close();
  });

  test("a non-loopback bind needs a token on any network", async () => {
    await assert.rejects(
      startRealFacilitator({ port: 0, host: "0.0.0.0", keyPath: feePayerPem, logger: quiet }),
      /non-loopback/,
    );
  });

  test("starts on mainnet with separated roles, serves /supported, protects /settle", async () => {
    const fac = await startRealFacilitator(mainnet());
    try {
      assert.equal(fac.feePayer, feePayerHash);
      const supported = (await (await fetch(`${fac.url}/supported`)).json()) as { kinds: Array<{ network: string; extra: { feePayer: string } }> };
      assert.deepEqual(supported.kinds[0], { x402Version: 2, scheme: "exact", network: "casper:casper", extra: { feePayer: feePayerHash } });
      const settle = await fetch(`${fac.url}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(settle.status, 401);
    } finally {
      await fac.close();
    }
  });

  test("a port that is already taken rejects the start-up promise (L09)", async () => {
    const blocker = createServer();
    await new Promise<void>(r => blocker.listen(0, "127.0.0.1", () => r()));
    const address = blocker.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      await assert.rejects(startRealFacilitator({ port, keyPath: feePayerPem, logger: quiet }), /EADDRINUSE/);
    } finally {
      await new Promise<void>(r => blocker.close(() => r()));
    }
  });

  test("testnet keeps working with one key but warns about the overlap", async () => {
    const warnings: string[] = [];
    const fac = await startRealFacilitator({
      port: 0,
      keyPath: feePayerPem,
      allowedPayTo: [`00${feePayerHash}`],
      allowedAssets: ["cb".repeat(32)],
      logger: { ...quiet, warn: m => warnings.push(m) },
    });
    await fac.close();
    assert.ok(warnings.some(w => w.includes("seller")));
  });
});

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import casperSdk from "casper-js-sdk";
import { toClientCasperSigner } from "@make-software/casper-x402";
import { ExactCasperScheme as ClientScheme } from "@make-software/casper-x402/exact/client";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { clientSignerFromPem, createCasperClientScheme } from "@cascet/client";
import { balanceItemKey, CascetCasperServerScheme, dictionaryAddress } from "@cascet/gateway";
import {
  parsePaymentRequest,
  paymentFingerprint,
  type CoreResult,
  type FacilitatorCore,
  type FacilitatorLogger,
  type KnownTransaction,
  type ParsedPayment,
} from "./facilitator-core.js";
import { NETWORKS } from "./facilitator-env.js";
import { serializeFacilitatorState } from "./facilitator-state.js";
import {
  closeGracefully,
  createFacilitatorApp,
  InFlightRequests,
  startRealFacilitator,
  type FacilitatorAppOptions,
  type RealFacilitatorHandle,
  type RealFacilitatorOptions,
} from "./real-facilitator.js";
import * as fx from "./rpc-fixtures.js";
import { startFakeRpcServer, type FakeRpcServer } from "./test-helpers.js";

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
  /** Transactions "already submitted", by authorization nonce. */
  known = new Map<string, KnownTransaction>();
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
  knownTransaction(p: ParsedPayment): KnownTransaction | undefined {
    return this.known.get(p.authorization.nonce);
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
    server,
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

      // When the facilitator holds a transaction for the authorization, the answer carries its hash.
      core.known.set("9c".repeat(32), { state: "submitted", txHash: "ab".repeat(32) });
      const withHash = await s.post("/settle", requestBody());
      assert.deepEqual([withHash.status, withHash.body["errorReason"], withHash.body["transaction"]], [500, "settlement_unknown", "ab".repeat(32)]);
      assert.deepEqual(withHash.body["extra"], { settlementStatus: "unknown" });
      assert.match(String(withHash.body["errorMessage"]), /reconcile transaction abab/);
    } finally {
      await s.close();
    }
  });

  test("core status codes pass through (503 when the token state cannot be read)", async () => {
    const core = new FakeCore();
    core.verifyStatus = 503;
    const s = await serve(core);
    try {
      assert.equal((await s.post("/verify", requestBody())).status, 503);
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

  test("a settle of an authorization that already has a transaction passes every post-auth limit (it only follows it or is a duplicate)", async () => {
    const core = new FakeCore();
    const s = await serve(core, { maxRequestsPerMinute: 1, maxRequestsPerPayerPerMinute: 1, maxSettlesPerMinute: 1 });
    try {
      const alice = `00${"a1".repeat(32)}`;
      assert.equal((await s.post("/settle", requestBody(alice, "01".repeat(32)))).status, 200);
      // Every budget is spent: a new settle (another payer, another nonce) is limited, and loses nothing.
      const limited = await s.post("/settle", requestBody(`00${"b2".repeat(32)}`, "02".repeat(32)));
      assert.deepEqual([limited.status, limited.body["errorReason"], limited.body["transaction"]], [429, "rate_limited", ""]);
      assert.deepEqual(limited.body["extra"], { settlementStatus: "not_submitted" });

      // The first authorization now has a transaction: settling it again (the
      // @x402/core settlement_pending retry) reaches the core, however often.
      core.known.set("01".repeat(32), { state: "submitted", txHash: "ab".repeat(32) });
      for (let i = 0; i < 3; i++) assert.equal((await s.post("/settle", requestBody(alice, "01".repeat(32)))).status, 200, `retry ${i}`);
      assert.equal(core.calls.filter(c => c.startsWith("settle")).length, 4);
      // /verify of it, and settles of other authorizations, are still limited.
      assert.equal((await s.post("/verify", requestBody(alice, "01".repeat(32)))).status, 429);
      assert.equal((await s.post("/settle", requestBody(alice, "03".repeat(32)))).status, 429);
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

describe("graceful shutdown", () => {
  /** A core whose settle blocks until released (a settle that already submitted and is polling). */
  function slowCore() {
    const core = new FakeCore();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let entered!: () => void;
    const started = new Promise<void>(r => (entered = r));
    core.settle = async (p: ParsedPayment) => {
      entered();
      await gate;
      return { status: 200, body: { success: true, transaction: "bb".repeat(32), network: NETWORK, payer: p.authorization.from } };
    };
    return { core, release, started };
  }

  test("close waits for a running /settle to finish and answer", async () => {
    const { core, release, started } = slowCore();
    const inFlight = new InFlightRequests();
    const s = await serve(core, { inFlight });
    const pending = s.post("/settle", requestBody());
    await started;
    assert.equal(inFlight.size, 1);
    let closed = false;
    const closing = closeGracefully(s.server, inFlight, 10_000, quiet).then(() => (closed = true));
    await new Promise(r => setTimeout(r, 100));
    assert.equal(closed, false, "the running settle keeps the facilitator open");
    release();
    const answer = await pending;
    assert.deepEqual([answer.status, answer.body["transaction"]], [200, "bb".repeat(32)]);
    await closing;
    assert.equal(closed, true);
  });

  test("while shutting down, new requests get 503 and never reach the core", async () => {
    const core = new FakeCore();
    const inFlight = new InFlightRequests();
    inFlight.close();
    const s = await serve(core, { inFlight });
    try {
      const st = await s.post("/settle", requestBody());
      assert.deepEqual([st.status, st.body["errorReason"]], [503, "facilitator_shutting_down"]);
      assert.deepEqual(st.body["extra"], { settlementStatus: "not_submitted" });
      assert.equal((await s.post("/verify", requestBody())).status, 503);
      assert.equal(core.calls.length, 0);
    } finally {
      await s.close();
    }
  });

  test("while shutting down, a settle of an authorization that has a transaction gets its hash, never 'not submitted'", async () => {
    const core = new FakeCore();
    core.known.set("9c".repeat(32), { state: "submitted", txHash: "ab".repeat(32) });
    const inFlight = new InFlightRequests();
    inFlight.close();
    const s = await serve(core, { inFlight });
    try {
      const st = await s.post("/settle", requestBody());
      assert.deepEqual(
        [st.status, st.body["success"], st.body["errorReason"], st.body["transaction"], st.body["payer"]],
        [503, false, "facilitator_shutting_down", "ab".repeat(32), `00${"65".repeat(32)}`],
      );
      assert.deepEqual(st.body["extra"], { settlementStatus: "pending" }, "an outcome to reconcile by hash");
      assert.match(String(st.body["errorMessage"]), /transaction abab.* reconcile it by hash/);
      // Authentication and parsing still come first.
      assert.equal((await s.post("/settle", requestBody(), "Bearer nope")).status, 401);
      assert.equal((await s.post("/settle", { paymentPayload: {} })).status, 400);
      // Another authorization: nothing here, so "not submitted".
      const other = await s.post("/settle", requestBody(undefined, "01".repeat(32)));
      assert.deepEqual([other.status, other.body["transaction"]], [503, ""]);
      assert.deepEqual(other.body["extra"], { settlementStatus: "not_submitted" });
      assert.equal(core.calls.length, 0, "nothing reaches the core while shutting down");
    } finally {
      await s.close();
    }
  });

  test("a settle that outlives the drain timeout is cut off with a warning", async () => {
    const { core, started } = slowCore();
    const inFlight = new InFlightRequests();
    const warnings: string[] = [];
    const s = await serve(core, { inFlight });
    const pending = s.post("/settle", requestBody()).catch((e: unknown) => e);
    await started;
    await closeGracefully(s.server, inFlight, 50, { ...quiet, warn: m => warnings.push(m) });
    assert.ok((await pending) instanceof Error, "the connection was closed");
    assert.ok(warnings.some(w => w.includes("still running")));
  });
});

describe("startRealFacilitator start-up rules (M07)", () => {
  let dir: string;
  let feePayerPem: string;
  let feePayerHash: string;
  /** Mainnet start-up reads the owner and seller accounts' associated keys: a local fake node. */
  let node: FakeRpcServer;
  const SELLER = `00${"88".repeat(32)}`;
  const OWNER = `00${"0e".repeat(32)}`;
  const DEPLOYER = NETWORKS["casper:casper"].deployerAccount.slice(2);
  const MAINNET_TOKEN = "8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41";
  const mainnetKey = (name: string) => fx.mainnetContractResponse.result.stored_value.Contract.named_keys.find(k => k.name === name)!.key;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "cascet-fac-"));
    const key = PrivateKey.generate(KeyAlgorithm.ED25519);
    feePayerPem = join(dir, "fee-payer_secret_key.pem");
    writeFileSync(feePayerPem, key.toPem(), { mode: 0o600 });
    feePayerHash = key.publicKey.accountHash().toHex();
    node = await startFakeRpcServer({
      [`query_global_state account-hash-${DEPLOYER}`]: fx.mainnetDeployerAccountResponse,
      [`query_global_state account-hash-${OWNER.slice(2)}`]: fx.accountNotFoundResponse,
      [`query_global_state account-hash-${SELLER.slice(2)}`]: fx.accountNotFoundResponse,
      // The mainnet x402 token, read at start-up (ABI, chain_name, name).
      [`query_global_state hash-${MAINNET_TOKEN}`]: fx.mainnetPackageResponse,
      [`query_global_state hash-b424e9c999a962574ad057dea0a6b8ae5c3398ee12f16b829e1bdaf6f13f58a0`]: fx.mainnetContractResponse,
      [`query_global_state ${mainnetKey("name")}`]: fx.mainnetNameResponse,
      [`query_global_state ${mainnetKey("chain_name")}`]: fx.mainnetChainNameResponse,
    });
  });
  after(async () => {
    rmSync(dir, { recursive: true, force: true });
    await node.close();
  });

  const mainnet = () => ({
    port: 0,
    network: "casper:casper" as const,
    keyPath: feePayerPem,
    authToken: TOKEN,
    allowedPayTo: [SELLER],
    allowedAssets: ["8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41"],
    ownerAccountHashes: [OWNER],
    rpcUrl: node.url,
    stateFile: join(dir, "mainnet-state.json"),
    logger: quiet,
  });

  test("refuses mainnet when the fee payer is an owner or a seller", async () => {
    await assert.rejects(startRealFacilitator({ ...mainnet(), ownerAccountHashes: [OWNER, `00${feePayerHash}`] }), /contract owner/);
    await assert.rejects(startRealFacilitator({ ...mainnet(), allowedPayTo: [SELLER, `00${feePayerHash}`] }), /seller/);
  });

  test("refuses mainnet when the fee-payer key can sign for the deployer (an associated key)", async () => {
    // The plan's step 5b done wrong: the hot fee-payer key added to the deployer account.
    const account = structuredClone(fx.mainnetDeployerAccountResponse) as unknown as {
      result: { stored_value: { Account: { associated_keys: Array<{ account_hash: string; weight: number }> } } };
    };
    account.result.stored_value.Account.associated_keys.push({ account_hash: `account-hash-${feePayerHash}`, weight: 1 });
    const misconfigured = await startFakeRpcServer({
      [`query_global_state account-hash-${DEPLOYER}`]: account,
      "query_global_state": fx.accountNotFoundResponse,
    });
    try {
      // No owner named: the deployer is checked anyway.
      const { ownerAccountHashes: _omit, ...noOwner } = mainnet();
      await assert.rejects(startRealFacilitator({ ...noOwner, rpcUrl: misconfigured.url }), /associated key of b9a38c8277/);
    } finally {
      await misconfigured.close();
    }
  });

  test("refuses mainnet when the owner and seller accounts cannot be read", async () => {
    await assert.rejects(startRealFacilitator({ ...mainnet(), rpcUrl: "http://127.0.0.1:9/rpc", rpcTimeoutMs: 500 }), /could not read/);
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
    const before = node.calls.length;
    const fac = await startRealFacilitator(mainnet());
    try {
      const keys = node.calls.slice(before).map(c => String(c.params["key"]));
      assert.deepEqual(
        keys.filter(k => k.startsWith("account-hash-")).sort(),
        [`account-hash-${DEPLOYER}`, `account-hash-${OWNER.slice(2)}`, `account-hash-${SELLER.slice(2)}`].sort(),
        "the deployer, the named owner and the seller were read",
      );
      assert.ok(keys.includes(`hash-${MAINNET_TOKEN}`), "and the token, before serving anything");
      // CasCet's mainnet token: legacy-amount, its on-chain name pinned, the 4 CSPR default limit.
      assert.deepEqual(fac.assets, [
        { asset: MAINNET_TOKEN, style: "legacy-amount", name: "CasCet X402 Token", version: "1", paymentMotes: 4_000_000_000n },
      ]);
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
    // Preflight off: nothing is read on-chain, so the (known) style and the name are pinned.
    const fac = await startRealFacilitator({
      port: 0,
      keyPath: feePayerPem,
      allowedPayTo: [`00${feePayerHash}`],
      allowedAssets: [NETWORKS["casper:casper-test"].token],
      preflight: false,
      tokenName: "CasCet X402 Token",
      logger: { ...quiet, warn: m => warnings.push(m) },
    });
    await fac.close();
    assert.ok(warnings.some(w => w.includes("seller")));
  });

  test("assets are checked before the key is loaded: style CasCet knows, gas floors per style, names without the preflight", async () => {
    const testnet = { port: 0, keyPath: join(dir, "missing.pem"), logger: quiet };
    const WCSPR = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";
    await assert.rejects(
      startRealFacilitator({ ...testnet, assets: [{ packageHash: NETWORKS["casper:casper-test"].token, authorization: "cep3009-value" }] }),
      /CasCet's x402 token, whose transfer_with_authorization takes `amount`/,
    );
    await assert.rejects(
      startRealFacilitator({ ...testnet, assets: [{ packageHash: WCSPR, paymentMotes: 1_000_000_000 }] }),
      /assets\[0\]\.paymentMotes must be between 1500000000 and 100000000000 for a cep3009-value token/,
    );
    await assert.rejects(
      startRealFacilitator({ ...testnet, assets: [{ packageHash: WCSPR }, { packageHash: `hash-${WCSPR}` }] }),
      /listed twice/,
    );
    await assert.rejects(
      startRealFacilitator({ ...testnet, allowedAssets: [WCSPR], assets: [{ packageHash: WCSPR }] }),
      /either assets or allowedAssets/,
    );
    await assert.rejects(
      startRealFacilitator({ ...testnet, assets: [{ packageHash: WCSPR }, { packageHash: NETWORKS["casper:casper-test"].token }], tokenName: "X" }),
      /tokenName pins the name of a single asset/,
    );
    await assert.rejects(
      startRealFacilitator({ ...testnet, preflight: false, assets: [{ packageHash: "dd".repeat(32), name: "Other" }] }),
      /declare the authorization style/,
    );
    await assert.rejects(startRealFacilitator({ ...testnet, preflight: false, assets: [{ packageHash: WCSPR }] }), /pin the EIP-712 domain name/);
    // Without an asset allowlist any style may come: the shared limit must suit both.
    await assert.rejects(startRealFacilitator({ ...testnet, paymentMotes: 2_000_000_000 }), /at least 3000000000 without an asset allowlist/);
  });

  test("mainnet refuses to start without a state file; none (false) starts with a loud warning; testnet only warns (F11)", async () => {
    const { stateFile: _state, ...noState } = mainnet();
    await assert.rejects(startRealFacilitator(noState), /mainnet requires a state file \(stateFile, CASCET_FACILITATOR_STATE_FILE\)/);

    const warnings: string[] = [];
    const optedOut = await startRealFacilitator({ ...mainnet(), stateFile: false, logger: { ...quiet, warn: m => warnings.push(m) } });
    await optedOut.close();
    assert.ok(warnings.some(w => /^RUNNING ON MAINNET WITHOUT A STATE FILE \(CASCET_FACILITATOR_STATE_FILE=none\).*second transaction/.test(w)));

    const testnetWarnings: string[] = [];
    const testnet = await startRealFacilitator({
      port: 0,
      keyPath: feePayerPem,
      preflight: false,
      tokenName: "CasCet X402 Token",
      logger: { ...quiet, warn: m => testnetWarnings.push(m) },
    });
    await testnet.close();
    assert.ok(testnetWarnings.some(w => /^no state file \(CASCET_FACILITATOR_STATE_FILE\).*testnet only/.test(w)));
  });

  test("a corrupt, unreadable or unwritable state file refuses the start-up, before the key is loaded", async () => {
    const stateDir = join(dir, "refused");
    mkdirSync(stateDir);
    const path = join(stateDir, "state.json");
    // A key file that does not exist: the state file is refused first.
    const testnet = { port: 0, keyPath: join(dir, "missing.pem"), preflight: false, tokenName: "CasCet X402 Token", stateFile: path, logger: quiet };

    writeFileSync(path, '{"format":"cascet-facilitator-state","version":1,"network":"casper:casper-test","authorizations":[');
    await assert.rejects(startRealFacilitator(testnet), /refusing to start: the state file .*state\.json is not a valid facilitator state: it is not valid JSON/);
    writeFileSync(path, serializeFacilitatorState("casper:casper", []));
    await assert.rejects(startRealFacilitator(testnet), /kept for "casper:casper", not casper:casper-test/);
    assert.equal(readFileSync(path, "utf8"), serializeFacilitatorState("casper:casper", []), "a refused file is never rewritten");
    await assert.rejects(startRealFacilitator({ ...testnet, stateFile: stateDir }), /cannot read the state file .*: EISDIR/);
    await assert.rejects(
      startRealFacilitator({ ...testnet, stateFile: join(stateDir, "no-such-dir", "state.json") }),
      /refusing to start: cannot write the state file .*no-such-dir.*its directory must exist and be writable/,
    );
    await assert.rejects(startRealFacilitator({ ...testnet, stateFile: "" }), /stateFile must be a path, or false/);
    // A missing file in an existing directory is an empty state: created at start-up, mode 0600.
    rmSync(path);
    await assert.rejects(startRealFacilitator(testnet), /cannot read the fee-payer key file/, "now the key is the problem");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      format: "cascet-facilitator-state",
      version: 1,
      network: "casper:casper-test",
      authorizations: [],
    });
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  test("the per-IP limit is a positive whole number that reaches the HTTP layer; at or below the post-auth limit it warns", async () => {
    const base = { port: 0, keyPath: feePayerPem, preflight: false, tokenName: "CasCet X402 Token", logger: quiet };
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await assert.rejects(startRealFacilitator({ ...base, maxRequestsPerIpPerMinute: bad }), /maxRequestsPerIpPerMinute .* must be a positive whole number/);
    }
    const warnings: string[] = [];
    const fac = await startRealFacilitator({ ...base, maxRequestsPerIpPerMinute: 2, logger: { ...quiet, warn: m => warnings.push(m) } });
    try {
      assert.ok(warnings.some(w => /per-IP limit \(2 a minute.*not above the 300 \/verify and \/settle requests/.test(w)));
      assert.equal((await fetch(`${fac.url}/health`)).status, 200);
      assert.equal((await fetch(`${fac.url}/health`)).status, 200);
      assert.equal((await fetch(`${fac.url}/health`)).status, 429);
    } finally {
      await fac.close();
    }
    const quietStart: string[] = [];
    const raised = await startRealFacilitator({ ...base, maxRequestsPerIpPerMinute: 6_000, logger: { ...quiet, warn: m => quietStart.push(m) } });
    await raised.close();
    assert.ok(!quietStart.some(w => w.includes("per-IP limit")));
  });
});

describe("startRealFacilitator end to end against a local fake node (no network)", () => {
  /** CasCet X402 Token on testnet: legacy-amount (`amount`). */
  const TOKEN_PKG = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
  const TOKEN_CONTRACT = "36e657e60199d91d9ace288e573ada1d4c1ab58b1ec6bcd31ae2c0dc62531bd8";
  /** Official Wrapped CSPR on testnet: cep3009-value (`value`). */
  const WCSPR_PKG = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";
  const WCSPR_CONTRACT = "032706aeae170fafb6403ce3bec58062f1c4288710838fe1df98ce4ff6c35f4a";
  const SELLER = `00${"88".repeat(32)}`;
  const PRICE = "500000000";
  const legacyKey = (name: string) => fx.testnetContractResponse.result.stored_value.Contract.named_keys.find(k => k.name === name)!.key;
  const wcsprKey = (name: string) => fx.wcsprTestnetContractResponse.result.stored_value.Contract.named_keys.find(k => k.name === name)!.key;
  const u256 = (v: bigint) => {
    const le: number[] = [];
    for (let x = v; x > 0n; x >>= 8n) le.push(Number(x & 0xffn));
    return [le.length, ...le].map(b => b.toString(16).padStart(2, "0")).join("");
  };
  const u64 = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b.toString("hex");
  };
  /** "4m 57s" → ms (the node's duration format for whole seconds). */
  const durationMs = (text: string) =>
    [...text.matchAll(/(\d+)(h|m|s)\b/g)].reduce((ms, [, n, unit]) => ms + Number(n) * { h: 3_600_000, m: 60_000, s: 1_000 }[unit as "h" | "m" | "s"], 0);
  const balanceResponse = (v: bigint) => ({
    jsonrpc: "2.0",
    id: 1,
    result: { api_version: "2.0.0", block_header: null, stored_value: { CLValue: { cl_type: "U256", bytes: u256(v), parsed: v.toString() } } },
  });
  const executedResponse = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      api_version: "2.0.0",
      transaction: {},
      execution_info: {
        block_height: 9_000_000,
        execution_result: { Version2: { error_message: null, limit: "4000000000", cost: "4000000000", refund: "990000000" } },
      },
    },
  };

  let dir: string;
  let feePayer: InstanceType<typeof PrivateKey>;
  let feePayerPem: string;
  let payer: InstanceType<typeof PrivateKey>;
  let node: FakeRpcServer;
  const submitted: Array<{ Version1: Record<string, any> }> = [];
  /** Whether info_get_transaction shows submitted transactions as executed (false: "no such transaction" yet). */
  let executed = true;
  /** Called with each transaction as the node receives it. */
  let onSubmit: ((tx: { Version1: Record<string, any> }) => void) | undefined;

  /** Both tokens as the testnet node serves them, with `overrides` on top. */
  function nodeRoutes(payerKey: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      [`query_global_state hash-${TOKEN_PKG}`]: fx.testnetPackageResponse,
      [`query_global_state hash-${TOKEN_CONTRACT}`]: fx.testnetContractResponse,
      [`query_global_state ${legacyKey("name")}`]: fx.testnetNameResponse,
      [`query_global_state ${legacyKey("chain_name")}`]: fx.testnetChainNameResponse,
      [`query_global_state ${dictionaryAddress(legacyKey("balances"), balanceItemKey(payerKey))}`]: balanceResponse(100_000_000_000n),
      [`query_global_state hash-${WCSPR_PKG}`]: fx.wcsprTestnetPackageResponse,
      [`query_global_state hash-${WCSPR_CONTRACT}`]: fx.wcsprTestnetContractResponse,
      [`query_global_state ${wcsprKey("name")}`]: fx.wcsprTestnetNameResponse,
      [`query_global_state ${wcsprKey("chain_name")}`]: fx.wcsprTestnetChainNameResponse,
      [`query_global_state ${dictionaryAddress(wcsprKey("balances"), balanceItemKey(payerKey))}`]: balanceResponse(20_000_000_000n),
      // Every other key (the payer's nonces) does not exist yet: unused.
      query_global_state: fx.testnetUnusedNonceResponse,
      account_put_transaction: (params: Record<string, unknown>) => {
        const tx = params["transaction"] as { Version1: Record<string, any> };
        onSubmit?.(tx);
        submitted.push(tx);
        return { jsonrpc: "2.0", id: 1, result: { api_version: "2.0.0", transaction_hash: { Version1: tx.Version1["hash"] } } };
      },
      info_get_transaction: () => (executed ? executedResponse : fx.noSuchTransactionResponse),
      ...overrides,
    };
  }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "cascet-wiring-"));
    feePayer = PrivateKey.generate(KeyAlgorithm.ED25519);
    feePayerPem = join(dir, "fee-payer_secret_key.pem");
    writeFileSync(feePayerPem, feePayer.toPem(), { mode: 0o600 });
    payer = PrivateKey.generate(KeyAlgorithm.ED25519);
    node = await startFakeRpcServer(nodeRoutes(`00${payer.publicKey.accountHash().toHex()}`));
  });
  after(async () => {
    rmSync(dir, { recursive: true, force: true });
    await node.close();
  });

  const start = (over: Partial<RealFacilitatorOptions> = {}) =>
    startRealFacilitator({
      port: 0,
      network: NETWORK,
      keyPath: feePayerPem,
      rpcUrl: node.url,
      authToken: TOKEN,
      allowedPayTo: [SELLER],
      ...(over.assets ? {} : { allowedAssets: [`hash-${TOKEN_PKG}`] }),
      logger: quiet,
      ...over,
    });

  const requirements = (extra: Record<string, unknown> = { name: "CasCet X402 Token", version: "1" }, asset = TOKEN_PKG) => ({
    scheme: "exact",
    network: NETWORK,
    asset,
    amount: PRICE,
    payTo: SELLER,
    maxTimeoutSeconds: 300,
    extra,
  });
  const wcsprRequirements = () =>
    requirements({ name: "Wrapped CSPR", version: "1", symbol: "WCSPR", decimals: "9", authorizationStyle: "cep3009-value" }, WCSPR_PKG);

  /** A payment signed exactly as a buyer's casper-x402 1.0.0 client signs it. */
  async function signedBody(reqs = requirements()) {
    // casper-x402 types its own casper-js-sdk copy; the signer only calls publicKey and signAndAddAlgorithmBytes.
    const client = new ClientScheme(toClientCasperSigner(payer as unknown as Parameters<typeof toClientCasperSigner>[0]));
    const result = await client.createPaymentPayload(2, reqs as unknown as PaymentRequirements);
    return { x402Version: 2, paymentPayload: { x402Version: 2, accepted: reqs, payload: result.payload }, paymentRequirements: reqs };
  }

  /** A payment signed by CasCet's @x402/casper 2.29 buyer. */
  async function signedByBuyer(reqs: ReturnType<typeof requirements>) {
    const scheme = createCasperClientScheme(clientSignerFromPem(payer.toPem()));
    const result = await scheme.createPaymentPayload(2, reqs as unknown as PaymentRequirements);
    return { x402Version: 2, paymentPayload: { x402Version: 2, accepted: reqs, payload: result.payload }, paymentRequirements: reqs };
  }

  async function post(url: string, path: string, body: unknown) {
    const res = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  /** An @x402/core 2.29 resource server (what a CasCet gateway runs) settling through the facilitator at `url`. */
  async function resourceServer(url: string) {
    const auth = { Authorization: TOKEN };
    const facilitator = new HTTPFacilitatorClient({ url, createAuthHeaders: async () => ({ verify: auth, settle: auth, supported: auth }) });
    const server = new x402ResourceServer(facilitator).register(
      NETWORK,
      new CascetCasperServerScheme([{ network: NETWORK, asset: TOKEN_PKG, decimals: 9 }]),
    );
    await server.initialize();
    return server;
  }

  const argsOf = (tx: { Version1: Record<string, any> }) =>
    Object.fromEntries(tx.Version1["payload"].fields.args.Named as Array<[string, { bytes: string; cl_type: unknown }]>);

  test("verify, settle, replay, tampered nonce and wrong domain name, with the real verifier, probe and chain", async () => {
    const fac = await start();
    try {
      const good = await signedBody();
      const auth = (good.paymentPayload.payload as { authorization: Record<string, string> }).authorization;
      const payerKey = `00${payer.publicKey.accountHash().toHex()}`;

      const verified = await post(fac.url, "/verify", good);
      assert.deepEqual([verified.status, verified.body], [200, { isValid: true, payer: payerKey }]);

      const before = submitted.length;
      const settled = await post(fac.url, "/settle", good);
      assert.equal(settled.status, 200);
      assert.equal(settled.body["success"], true);
      assert.deepEqual(settled.body["extra"], { settlementStatus: "success", authorizationStyle: "legacy-amount", gasCostMotes: "3010000000" });
      assert.equal(submitted.length, before + 1);

      // The transaction that went to the node.
      const tx = submitted.at(-1)!.Version1;
      assert.equal(settled.body["transaction"], tx["hash"]);
      const payload = tx["payload"];
      assert.equal(payload.chain_name, "casper-test");
      assert.equal(payload.initiator_addr.PublicKey, feePayer.publicKey.toHex());
      assert.equal(tx["approvals"][0].signer, feePayer.publicKey.toHex());
      assert.equal(payload.pricing_mode.PaymentLimited.payment_amount, 4_000_000_000);
      assert.equal(payload.fields.entry_point.Custom, "transfer_with_authorization");
      assert.equal(payload.fields.target.Stored.id.ByPackageHash.addr, TOKEN_PKG);
      const ttl = durationMs(payload.ttl);
      const expiresAt = Date.parse(payload.timestamp) + ttl;
      assert.ok(ttl > 0 && ttl % 1000 === 0, `whole-second TTL, got ${payload.ttl}`);
      assert.ok(expiresAt <= Number(auth["validBefore"]) * 1000 - 2_000, "the transaction expires before the authorization");
      const args = argsOf(submitted.at(-1)!);
      assert.deepEqual(
        (payload.fields.args.Named as Array<[string]>).map(([n]) => n),
        ["from", "to", "amount", "valid_after", "valid_before", "nonce", "public_key", "signature"],
      );
      assert.deepEqual([args["from"]!.cl_type, args["from"]!.bytes], ["Key", payerKey], "Key::Account(payer)");
      assert.deepEqual([args["to"]!.cl_type, args["to"]!.bytes], ["Key", SELLER], "Key::Account(seller), tag 00");
      assert.deepEqual([args["amount"]!.cl_type, args["amount"]!.bytes], ["U256", u256(BigInt(PRICE))], "argument `amount`, not `value`");
      assert.equal(args["valid_after"]!.bytes, u64(Number(auth["validAfter"])));
      assert.equal(args["valid_before"]!.bytes, u64(Number(auth["validBefore"])));
      assert.equal(args["nonce"]!.bytes, `20000000${auth["nonce"]}`);
      assert.equal(args["public_key"]!.bytes, payer.publicKey.toHex());
      assert.equal(args["signature"]!.bytes, `41000000${(good.paymentPayload.payload as { signature: string }).signature}`);

      // The same authorization again: a duplicate (HTTP 200) with the earlier hash, nothing submitted.
      const replay = await post(fac.url, "/settle", good);
      assert.deepEqual([replay.status, replay.body["errorReason"], replay.body["transaction"]], [200, "duplicate_nonce", tx["hash"]]);
      assert.deepEqual(replay.body["extra"], { settlementStatus: "duplicate" });

      // A tampered nonce breaks the signature.
      const tampered = structuredClone(await signedBody());
      (tampered.paymentPayload.payload as { authorization: { nonce: string } }).authorization.nonce = "77".repeat(32);
      const bad = await post(fac.url, "/verify", tampered);
      assert.deepEqual([bad.status, bad.body["isValid"], bad.body["invalidReason"]], [200, false, "invalid_exact_casper_facilitator_invalid_signature"]);

      // Signed with another EIP-712 name: refused by the name pinned at start-up, before any submission.
      const wrongName = await post(fac.url, "/settle", await signedBody(requirements({ name: "Wrapped CSPR", version: "1" })));
      assert.deepEqual([wrongName.status, wrongName.body["errorReason"]], [200, "token_domain_mismatch"]);
      assert.equal(submitted.length, before + 1, "nothing else reached the node");
    } finally {
      await fac.close();
    }
  });

  test("a payment from CasCet's @x402/casper 2.29 buyer (style advertised, validAfter 0) verifies and settles with `amount`", async () => {
    const fac = await start();
    try {
      const reqs = requirements({ name: "CasCet X402 Token", version: "1", symbol: "WCSPR", decimals: "9", authorizationStyle: "legacy-amount" });
      const body = await signedByBuyer(reqs);
      const auth = (body.paymentPayload.payload as { authorization: Record<string, string> }).authorization;
      assert.equal(auth["validAfter"], "0");

      const verified = await post(fac.url, "/verify", body);
      assert.equal(verified.body["isValid"], true, JSON.stringify(verified.body));
      const before = submitted.length;
      const settled = await post(fac.url, "/settle", body);
      assert.equal(settled.body["success"], true, JSON.stringify(settled.body));
      assert.equal(submitted.length, before + 1);
      const args = argsOf(submitted.at(-1)!);
      assert.equal(args["amount"]?.bytes, u256(BigInt(PRICE)), "the legacy token's `amount` argument");
      assert.equal(args["value"], undefined);
      assert.equal(args["valid_after"]?.bytes, u64(0));
    } finally {
      await fac.close();
    }
  });

  test("both styles side by side: Wrapped CSPR settles with `value`, its own package and gas limit; CasCet's token with `amount`", async () => {
    const fac = await start({
      assets: [{ packageHash: `hash-${TOKEN_PKG}` }, { packageHash: WCSPR_PKG, paymentMotes: 3_000_000_000 }],
    });
    try {
      // Read on-chain at start-up: each asset's ABI style and EIP-712 name, pinned; the legacy token gets its
      // style's default gas limit, Wrapped CSPR its own (3 CSPR, neither its style's default nor @x402/casper's).
      assert.deepEqual(fac.assets, [
        { asset: TOKEN_PKG, style: "legacy-amount", name: "CasCet X402 Token", version: "1", paymentMotes: 4_000_000_000n },
        { asset: WCSPR_PKG, style: "cep3009-value", name: "Wrapped CSPR", version: "1", paymentMotes: 3_000_000_000n },
      ]);

      const value = await signedByBuyer(wcsprRequirements());
      const auth = (value.paymentPayload.payload as { authorization: Record<string, string> }).authorization;
      assert.equal((await post(fac.url, "/verify", value)).body["isValid"], true);
      const before = submitted.length;
      const settled = await post(fac.url, "/settle", value);
      assert.equal(settled.body["success"], true, JSON.stringify(settled.body));
      assert.equal(settled.body["extra"]["authorizationStyle"], "cep3009-value");
      assert.equal(submitted.length, before + 1);
      const tx = submitted.at(-1)!;
      const payload = tx.Version1["payload"];
      assert.equal(payload.fields.target.Stored.id.ByPackageHash.addr, WCSPR_PKG);
      assert.equal(payload.fields.entry_point.Custom, "transfer_with_authorization");
      assert.equal(payload.pricing_mode.PaymentLimited.payment_amount, 3_000_000_000, "Wrapped CSPR's own limit");
      assert.deepEqual(
        (payload.fields.args.Named as Array<[string]>).map(([n]) => n),
        ["from", "to", "value", "valid_after", "valid_before", "nonce", "public_key", "signature"],
      );
      const args = argsOf(tx);
      assert.deepEqual([args["value"]!.cl_type, args["value"]!.bytes], ["U256", u256(BigInt(PRICE))], "argument `value`, not `amount`");
      assert.equal(args["amount"], undefined);
      assert.equal(args["nonce"]!.bytes, `20000000${auth["nonce"]}`);

      const legacy = await signedByBuyer(requirements({ name: "CasCet X402 Token", version: "1", authorizationStyle: "legacy-amount" }));
      assert.equal((await post(fac.url, "/settle", legacy)).body["success"], true);
      const legacyTx = submitted.at(-1)!;
      assert.equal(legacyTx.Version1["payload"].pricing_mode.PaymentLimited.payment_amount, 4_000_000_000);
      assert.equal(argsOf(legacyTx)["amount"]?.bytes, u256(BigInt(PRICE)));

      // A Wrapped CSPR payment signed for CasCet's token's domain is refused before anything is submitted.
      const crossed = await post(
        fac.url,
        "/settle",
        await signedByBuyer(requirements({ name: "CasCet X402 Token", version: "1" }, WCSPR_PKG)),
      );
      assert.deepEqual([crossed.status, crossed.body["errorReason"], crossed.body["transaction"]], [200, "token_domain_mismatch", ""]);
      assert.equal(submitted.length, before + 2);
    } finally {
      await fac.close();
    }
  });

  test("settlement_pending: a retry of the same payment follows the transaction instead of broadcasting again", async () => {
    const fac = await start({ settleWaitMs: 1_500 });
    executed = false;
    try {
      const body = await signedByBuyer(requirements());
      const before = submitted.length;
      const first = await post(fac.url, "/settle", body);
      assert.deepEqual([first.status, first.body["success"], first.body["errorReason"]], [200, false, "settlement_pending"]);
      assert.equal(first.body["transaction"], submitted.at(-1)!.Version1["hash"]);

      executed = true; // the transaction executes in the meantime
      const retry = await post(fac.url, "/settle", body);
      assert.deepEqual([retry.status, retry.body["success"], retry.body["transaction"]], [200, true, first.body["transaction"]]);
      assert.deepEqual(retry.body["extra"], {
        settlementStatus: "success",
        authorizationStyle: "legacy-amount",
        gasCostMotes: "3010000000",
        reconciled: true,
      });
      assert.equal(submitted.length, before + 1, "one broadcast");

      const third = await post(fac.url, "/settle", body);
      assert.deepEqual([third.status, third.body["errorReason"], third.body["transaction"]], [200, "duplicate_nonce", first.body["transaction"]]);
    } finally {
      executed = true;
      await fac.close();
    }
  });

  test("@x402/core 2.29's automatic settlement_pending retry is followed, never re-broadcast", async () => {
    const logs: string[] = [];
    const fac = await start({ settleWaitMs: 1_500, logger: { ...quiet, info: m => logs.push(m) } });
    executed = false; // the node never shows the transaction while the gateway waits
    try {
      const server = await resourceServer(fac.url);
      const body = await signedByBuyer(requirements());
      const before = submitted.length;
      const result = await server.settlePayment(
        body.paymentPayload as unknown as PaymentPayload,
        body.paymentRequirements as unknown as PaymentRequirements,
      );
      assert.equal(submitted.length, before + 1, "x402 settled twice; the facilitator broadcast once");
      const hash = submitted.at(-1)!.Version1["hash"];
      // The retry's answer: the same transaction, still pending (not a duplicate_nonce rejection).
      assert.deepEqual([result.success, result.errorReason, result.transaction], [false, "settlement_pending", hash]);
      assert.ok(logs.some(l => l.includes(`following pending tx=${hash}`)), "the retry followed the stored transaction");
    } finally {
      executed = true;
      await fac.close();
    }
  });

  test("rate limits never cost @x402/core 2.29's settlement_pending retry its transaction hash", async () => {
    // Each limit after authentication allows one request a minute: the retry is the second.
    const fac = await start({ settleWaitMs: 1_500, maxSettlesPerMinute: 1, maxRequestsPerMinute: 1, maxRequestsPerPayerPerMinute: 1 });
    executed = false; // the node never shows the transaction while the gateway waits
    try {
      const server = await resourceServer(fac.url);
      const body = await signedByBuyer(requirements());
      const before = submitted.length;
      const result = await server.settlePayment(
        body.paymentPayload as unknown as PaymentPayload,
        body.paymentRequirements as unknown as PaymentRequirements,
      );
      assert.equal(submitted.length, before + 1, "one broadcast");
      const hash = submitted.at(-1)!.Version1["hash"];
      // Not SettleError(429, rate_limited, transaction ""): the gateway keeps the hash to reconcile.
      assert.deepEqual([result.success, result.errorReason, result.transaction], [false, "settlement_pending", hash]);
      assert.equal(result.extra?.["settlementStatus"], "pending");

      // A settle of a new payment is still limited, and loses nothing.
      const other = await post(fac.url, "/settle", await signedByBuyer(requirements()));
      assert.deepEqual([other.status, other.body["errorReason"], other.body["transaction"]], [429, "rate_limited", ""]);
      assert.equal(submitted.length, before + 1);
    } finally {
      executed = true;
      await fac.close();
    }
  });

  const authorizationOf = (body: Awaited<ReturnType<typeof signedByBuyer>>) =>
    (body.paymentPayload.payload as { authorization: Record<string, string> }).authorization;
  const fingerprintOf = (body: unknown) => {
    const parsed = parsePaymentRequest(body, NETWORK);
    assert.ok(parsed.ok);
    return paymentFingerprint(parsed.value, NETWORK);
  };
  const savedAuthorizations = (path: string) =>
    (JSON.parse(readFileSync(path, "utf8")) as { authorizations: Array<Record<string, unknown>> }).authorizations;

  test("restart (F11): a settle left pending by one instance is followed by the next one from the same state file; nothing is submitted again", async () => {
    const stateFile = join(dir, "restart-state.json");
    const body = await signedByBuyer(requirements());
    const auth = authorizationOf(body);
    const before = submitted.length;
    let hash = "";
    executed = false; // the node does not show the transaction before the first instance stops
    const first = await start({ settleWaitMs: 1_500, stateFile });
    try {
      const pending = await post(first.url, "/settle", body);
      assert.deepEqual([pending.status, pending.body["errorReason"]], [200, "settlement_pending"]);
      hash = pending.body["transaction"];
      assert.equal(hash, submitted.at(-1)!.Version1["hash"]);
    } finally {
      await first.close();
    }
    // What the first instance leaves behind: the pending transaction and the payment it settles.
    assert.deepEqual(savedAuthorizations(stateFile), [
      {
        asset: TOKEN_PKG,
        from: `00${payer.publicKey.accountHash().toHex()}`,
        nonce: auth["nonce"],
        txHash: hash,
        state: "submitted",
        validBefore: Number(auth["validBefore"]),
        value: PRICE,
        status: "pending",
        fingerprint: fingerprintOf(body),
        style: "legacy-amount",
      },
    ]);

    executed = true; // the transaction executes while the facilitator restarts
    const logs: string[] = [];
    const second = await start({ settleWaitMs: 1_500, stateFile, logger: { ...quiet, info: m => logs.push(m) } });
    try {
      assert.ok(logs.some(l => /1 authorization\(s\) with a transaction restored, 1 pending/.test(l)), logs.join("\n"));
      // The gateway's settle retry gets the outcome of the same transaction; nothing is broadcast.
      const retry = await post(second.url, "/settle", body);
      assert.deepEqual([retry.status, retry.body["success"], retry.body["transaction"]], [200, true, hash]);
      assert.deepEqual(retry.body["extra"], {
        settlementStatus: "success",
        authorizationStyle: "legacy-amount",
        gasCostMotes: "3010000000",
        reconciled: true,
      });
      assert.equal(submitted.length, before + 1, "the second instance submitted nothing");
      // Anything else about the authorization is a duplicate carrying the hash.
      const again = await post(second.url, "/settle", body);
      assert.deepEqual([again.body["errorReason"], again.body["transaction"]], ["duplicate_nonce", hash]);
      const verify = await post(second.url, "/verify", body);
      assert.deepEqual([verify.body["isValid"], verify.body["invalidReason"]], [false, "duplicate_nonce"]);
    } finally {
      await second.close();
    }
    assert.deepEqual(
      savedAuthorizations(stateFile).map(a => [a["state"], a["txHash"]]),
      [["settled", hash]],
    );
    assert.equal(submitted.length, before + 1);
  });

  test("restart without a state file (the opt-out): the same retry broadcasts a second transaction, as F11 describes", async () => {
    const body = await signedByBuyer(requirements());
    const before = submitted.length;
    executed = false;
    const first = await start({ settleWaitMs: 1_500, stateFile: false });
    try {
      assert.equal((await post(first.url, "/settle", body)).body["errorReason"], "settlement_pending");
    } finally {
      await first.close();
    }
    const second = await start({ settleWaitMs: 1_500, stateFile: false });
    try {
      await post(second.url, "/settle", body);
      assert.equal(submitted.length, before + 2, "two transactions for one authorization: on-chain, one reverts and burns its gas");
    } finally {
      executed = true;
      await second.close();
    }
  });

  test("write-ahead (F11): the transaction is in the state file before the node receives it, so an instance that dies right after leaves enough", async () => {
    const stateFile = join(dir, "crash-state.json");
    const body = await signedByBuyer(requirements());
    const before = submitted.length;
    const onDisk: boolean[] = [];
    onSubmit = tx => onDisk.push(existsSync(stateFile) && readFileSync(stateFile, "utf8").includes(tx.Version1["hash"]));
    executed = false;
    const first = await start({ settleWaitMs: 1_500, stateFile });
    let second: RealFacilitatorHandle | undefined;
    try {
      const pending = await post(first.url, "/settle", body);
      assert.deepEqual(onDisk, [true], "saved before the broadcast");
      // The first instance dies here (no graceful close, no final save): the next one starts from what is on disk.
      executed = true;
      second = await start({ settleWaitMs: 1_500, stateFile });
      const retry = await post(second.url, "/settle", body);
      assert.deepEqual([retry.body["success"], retry.body["transaction"]], [true, pending.body["transaction"]]);
      assert.equal(submitted.length, before + 1);
    } finally {
      onSubmit = undefined;
      executed = true;
      await second?.close();
      await first.close();
    }
  });

  test("refuses to start when the chain contradicts the configuration or cannot be read", async () => {
    // A style CasCet knows to be wrong: refused before the chain is read.
    await assert.rejects(
      start({ assets: [{ packageHash: WCSPR_PKG, authorization: "legacy-amount" }] }),
      /assets\[0\]\.authorization: 3d80df21… is a known CEP-3009 token whose transfer_with_authorization takes `value`/,
    );
    // A pinned name that is not the token's.
    await assert.rejects(start({ assets: [{ packageHash: WCSPR_PKG, name: "Wrapped Casper" }] }), /pinned EIP-712 name "Wrapped Casper"/);

    const payerKey = `00${payer.publicKey.accountHash().toHex()}`;
    /** A package of the recorded legacy layout whose single version is `contract`. */
    const packagePointingAt = (contract: string) => {
      const pkg = structuredClone(fx.testnetPackageResponse) as unknown as {
        result: { stored_value: { ContractPackage: { versions: Array<{ contract_hash: string }> } } };
      };
      pkg.result.stored_value.ContractPackage.versions[0]!.contract_hash = `contract-${contract}`;
      return pkg;
    };
    const otherPkg = "ee".repeat(32);
    const otherContract = "ef".repeat(32);
    const noEntryPoint = structuredClone(fx.testnetContractResponse) as unknown as { result: { stored_value: { Contract: { entry_points: unknown[] } } } };
    noEntryPoint.result.stored_value.Contract.entry_points = [];
    const valuePkg = "ea".repeat(32);
    const namelessPkg = "ec".repeat(32);
    const namelessContract = "ed".repeat(32);
    const nameless = structuredClone(fx.wcsprTestnetContractResponse) as unknown as {
      result: { stored_value: { Contract: { named_keys: Array<{ name: string; key: string }> } } };
    };
    nameless.result.stored_value.Contract.named_keys = nameless.result.stored_value.Contract.named_keys.filter(k => k.name !== "name");
    const odd = await startFakeRpcServer(
      nodeRoutes(payerKey, {
        // CasCet's token answering with mainnet's chain_name.
        [`query_global_state ${legacyKey("chain_name")}`]: fx.mainnetChainNameResponse,
        // A token without transfer_with_authorization.
        [`query_global_state hash-${otherPkg}`]: packagePointingAt(otherContract),
        [`query_global_state hash-${otherContract}`]: noEntryPoint,
        // A token CasCet does not know whose ABI takes `value` (Wrapped CSPR's contract).
        [`query_global_state hash-${valuePkg}`]: fx.wcsprTestnetPackageResponse,
        // A CEP-3009 token without a `name` named key.
        [`query_global_state hash-${namelessPkg}`]: packagePointingAt(namelessContract),
        [`query_global_state hash-${namelessContract}`]: nameless,
      }),
    );
    try {
      await assert.rejects(start({ rpcUrl: odd.url }), /signs for chain_name "casper:casper", not casper:casper-test/);
      await assert.rejects(start({ rpcUrl: odd.url, assets: [{ packageHash: otherPkg }] }), /cannot be settled/);
      // A configured style the token's ABI contradicts.
      await assert.rejects(
        start({ rpcUrl: odd.url, assets: [{ packageHash: valuePkg, authorization: "legacy-amount" }] }),
        /configured as legacy-amount \(`amount`\), but its transfer_with_authorization takes `value` \(cep3009-value\)/,
      );
      // No on-chain name: only with a pinned one, which every request is then held to.
      await assert.rejects(start({ rpcUrl: odd.url, assets: [{ packageHash: namelessPkg }] }), /has no on-chain name: pin its EIP-712 domain name/);
      const pinned = await start({ rpcUrl: odd.url, assets: [{ packageHash: namelessPkg, name: "Wrapped CSPR" }] });
      try {
        assert.deepEqual(pinned.assets?.map(a => [a.style, a.name]), [["cep3009-value", "Wrapped CSPR"]]);
      } finally {
        await pinned.close();
      }
    } finally {
      await odd.close();
    }
    await assert.rejects(start({ rpcUrl: "http://127.0.0.1:9/rpc", rpcTimeoutMs: 500 }), /could not read asset cb65a928… on-chain/);
  });

  test("per-asset gas limits: an explicit one wins over the style's default; the daily cap must fit the largest", async () => {
    const fac = await start({ assets: [{ packageHash: TOKEN_PKG, paymentMotes: 4_500_000_000 }, { packageHash: WCSPR_PKG, paymentMotes: 2_000_000_000 }] });
    try {
      assert.deepEqual(
        fac.assets?.map(a => [a.style, a.paymentMotes]),
        [
          ["legacy-amount", 4_500_000_000n],
          ["cep3009-value", 2_000_000_000n],
        ],
      );
      const before = submitted.length;
      assert.equal((await post(fac.url, "/settle", await signedByBuyer(wcsprRequirements()))).body["success"], true);
      assert.equal(submitted.length, before + 1);
      assert.equal(submitted.at(-1)!.Version1["payload"].pricing_mode.PaymentLimited.payment_amount, 2_000_000_000);
    } finally {
      await fac.close();
    }
    await assert.rejects(start({ dailyGasCapMotes: 3_000_000_000n }), /dailyGasCapMotes must be at least one settle/);
  });
});

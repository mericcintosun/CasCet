import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import casperSdk from "casper-js-sdk";
import { toClientCasperSigner } from "@make-software/casper-x402";
import { ExactCasperScheme as ClientScheme } from "@make-software/casper-x402/exact/client";
import type { PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { balanceItemKey, dictionaryAddress } from "@cascet/gateway";
import type { CoreResult, FacilitatorCore, FacilitatorLogger, ParsedPayment } from "./facilitator-core.js";
import { NETWORKS } from "./facilitator-env.js";
import {
  closeGracefully,
  createFacilitatorApp,
  InFlightRequests,
  startRealFacilitator,
  type FacilitatorAppOptions,
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
      const checked = node.calls.slice(before).map(c => String(c.params["key"]));
      assert.deepEqual(
        [...checked].sort(),
        [`account-hash-${DEPLOYER}`, `account-hash-${OWNER.slice(2)}`, `account-hash-${SELLER.slice(2)}`].sort(),
        "the deployer, the named owner and the seller were read",
      );
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

describe("startRealFacilitator end to end against a local fake node (no network)", () => {
  const TOKEN_PKG = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
  const TOKEN_CONTRACT = "36e657e60199d91d9ace288e573ada1d4c1ab58b1ec6bcd31ae2c0dc62531bd8";
  const SELLER = `00${"88".repeat(32)}`;
  const PRICE = "500000000";
  const namedKey = (name: string) =>
    fx.testnetContractResponse.result.stored_value.Contract.named_keys.find(k => k.name === name)!.key;
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

  let dir: string;
  let feePayer: InstanceType<typeof PrivateKey>;
  let feePayerPem: string;
  let payer: InstanceType<typeof PrivateKey>;
  let node: FakeRpcServer;
  const submitted: Array<{ Version1: Record<string, any> }> = [];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "cascet-wiring-"));
    feePayer = PrivateKey.generate(KeyAlgorithm.ED25519);
    feePayerPem = join(dir, "fee-payer_secret_key.pem");
    writeFileSync(feePayerPem, feePayer.toPem(), { mode: 0o600 });
    payer = PrivateKey.generate(KeyAlgorithm.ED25519);
    const payerKey = `00${payer.publicKey.accountHash().toHex()}`;
    node = await startFakeRpcServer({
      [`query_global_state hash-${TOKEN_PKG}`]: fx.testnetPackageResponse,
      [`query_global_state hash-${TOKEN_CONTRACT}`]: fx.testnetContractResponse,
      [`query_global_state ${namedKey("name")}`]: fx.testnetNameResponse,
      [`query_global_state ${dictionaryAddress(namedKey("balances"), balanceItemKey(payerKey))}`]: {
        jsonrpc: "2.0",
        id: 1,
        result: { api_version: "2.0.0", block_header: null, stored_value: { CLValue: { cl_type: "U256", bytes: u256(100_000_000_000n), parsed: "100000000000" } } },
      },
      // Every other key (the payer's nonces) does not exist yet: unused.
      query_global_state: fx.testnetUnusedNonceResponse,
      account_put_transaction: (params: Record<string, unknown>) => {
        const tx = params["transaction"] as { Version1: Record<string, any> };
        submitted.push(tx);
        return { jsonrpc: "2.0", id: 1, result: { api_version: "2.0.0", transaction_hash: { Version1: tx.Version1["hash"] } } };
      },
      info_get_transaction: {
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
      },
    });
  });
  after(async () => {
    rmSync(dir, { recursive: true, force: true });
    await node.close();
  });

  const requirements = (extra: Record<string, unknown> = { name: "CasCet X402 Token", version: "1" }) => ({
    scheme: "exact",
    network: NETWORK,
    asset: TOKEN_PKG,
    amount: PRICE,
    payTo: SELLER,
    maxTimeoutSeconds: 300,
    extra,
  });

  /** A payment signed exactly as a buyer's casper-x402 client signs it. */
  async function signedBody(reqs = requirements()) {
    // casper-x402 types its own casper-js-sdk copy; the signer only calls publicKey and signAndAddAlgorithmBytes.
    const client = new ClientScheme(toClientCasperSigner(payer as unknown as Parameters<typeof toClientCasperSigner>[0]));
    const result = await client.createPaymentPayload(2, reqs as unknown as PaymentRequirements);
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

  test("verify, settle, replay, tampered nonce and wrong domain name, with the real scheme, reader and chain", async () => {
    const fac = await startRealFacilitator({
      port: 0,
      network: NETWORK,
      keyPath: feePayerPem,
      rpcUrl: node.url,
      authToken: TOKEN,
      allowedPayTo: [SELLER],
      allowedAssets: [`hash-${TOKEN_PKG}`],
      logger: quiet,
    });
    try {
      const good = await signedBody();
      const auth = (good.paymentPayload.payload as { authorization: Record<string, string> }).authorization;
      const payerKey = `00${payer.publicKey.accountHash().toHex()}`;

      const verified = await post(fac.url, "/verify", good);
      assert.deepEqual([verified.status, verified.body], [200, { isValid: true, payer: payerKey }]);

      const settled = await post(fac.url, "/settle", good);
      assert.equal(settled.status, 200);
      assert.equal(settled.body["success"], true);
      assert.deepEqual(settled.body["extra"], { settlementStatus: "success", gasCostMotes: "3010000000" });
      assert.equal(submitted.length, 1);

      // The transaction that went to the node.
      const tx = submitted[0]!.Version1;
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
      const args = Object.fromEntries(payload.fields.args.Named as Array<[string, { bytes: string; cl_type: unknown }]>);
      assert.deepEqual([args["from"]!.cl_type, args["from"]!.bytes], ["Key", payerKey], "Key::Account(payer)");
      assert.deepEqual([args["to"]!.cl_type, args["to"]!.bytes], ["Key", SELLER], "Key::Account(seller), tag 00");
      assert.deepEqual([args["amount"]!.cl_type, args["amount"]!.bytes], ["U256", u256(BigInt(PRICE))], "argument `amount`, not `value`");
      assert.equal(args["valid_after"]!.bytes, u64(Number(auth["validAfter"])));
      assert.equal(args["valid_before"]!.bytes, u64(Number(auth["validBefore"])));
      assert.equal(args["nonce"]!.bytes, `20000000${auth["nonce"]}`);
      assert.equal(args["public_key"]!.bytes, payer.publicKey.toHex());
      assert.equal(args["signature"]!.bytes, `41000000${(good.paymentPayload.payload as { signature: string }).signature}`);

      // The same authorization again: 409 with the earlier hash, nothing submitted.
      const replay = await post(fac.url, "/settle", good);
      assert.deepEqual([replay.status, replay.body["errorReason"], replay.body["transaction"]], [409, "duplicate_nonce", tx["hash"]]);
      assert.deepEqual(replay.body["extra"], { settlementStatus: "duplicate" });

      // A tampered nonce breaks the signature (casper-x402's check).
      const tampered = structuredClone(await signedBody());
      (tampered.paymentPayload.payload as { authorization: { nonce: string } }).authorization.nonce = "77".repeat(32);
      const bad = await post(fac.url, "/verify", tampered);
      assert.deepEqual([bad.body["isValid"], bad.body["invalidReason"]], [false, "invalid_exact_casper_facilitator_invalid_signature"]);

      // Signed with another EIP-712 name: refused by the on-chain name check, before any submission.
      const wrongName = await post(fac.url, "/settle", await signedBody(requirements({ name: "Wrapped CSPR", version: "1" })));
      assert.deepEqual([wrongName.status, wrongName.body["errorReason"]], [200, "token_domain_mismatch"]);
      assert.equal(submitted.length, 1, "nothing else reached the node");
    } finally {
      await fac.close();
    }
  });
});

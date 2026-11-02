import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { ResolvedAsset } from "@cascet/core";
import { createCasperRpc, type RpcFetch } from "./casper-rpc.js";
import { HOSTED_PREFLIGHT_DEADLINE_MS, hostedPreflightHook, PreflightReason } from "./hosted-preflight.js";
import { WCSPR_TESTNET, wcsprNodeRoutes, wcsprNonceCall, wcsprRequirements } from "./testing/fake-node.js";
import * as fx from "./testing/rpc-fixtures.js";
import { replayFetch, type Replay } from "./testing/rpc-replay.js";
import { TokenProbe } from "./token-probe.js";

const NETWORK = "casper:casper-test";
const PAYER = `00${"65".repeat(32)}`;
const PAY_TO = `00${"11".repeat(32)}`;
const NONCE = "ab".repeat(32);
const PRICE = "200000000";
const LEGACY_TOKEN = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";

const WCSPR_ASSET: ResolvedAsset = {
  id: "wcspr",
  packageHash: WCSPR_TESTNET,
  name: "Wrapped CSPR",
  symbol: "WCSPR",
  decimals: 9,
  version: "1",
  tokensPerUsd: 20,
  authorization: "cep3009-value",
  facilitator: "default",
};

const payment = (requirements: PaymentRequirements, authorization: Record<string, unknown> = {}): PaymentPayload => ({
  x402Version: 2,
  accepted: requirements,
  payload: {
    signature: `01${"00".repeat(64)}`,
    publicKey: `01${"44".repeat(32)}`,
    authorization: { from: PAYER, to: PAY_TO, value: requirements.amount, validAfter: "0", validBefore: "4102444800", nonce: NONCE, ...authorization },
  },
});

/** The hook over a probe whose node answers `routes` (recorded testnet Wrapped CSPR state by default). */
function preflight(opts: { routes?: Record<string, Replay>; fetchImpl?: RpcFetch; asset?: Partial<ResolvedAsset>; deadlineMs?: number } = {}) {
  const calls: string[] = [];
  const routes = opts.routes ?? wcsprNodeRoutes({ balances: { [PAYER]: 1_000_000_000n } });
  const probe = new TokenProbe(createCasperRpc("http://node.invalid/rpc", { fetchImpl: opts.fetchImpl ?? replayFetch(routes, calls) }));
  const hook = hostedPreflightHook({ probe, network: NETWORK, assets: [{ ...WCSPR_ASSET, ...opts.asset }], deadlineMs: opts.deadlineMs });
  return {
    calls,
    // The hook only ever passes (undefined) or aborts; it never skips verification.
    run: async (requirements: PaymentRequirements = wcsprRequirements(PRICE, PAY_TO), paymentPayload = payment(requirements)) =>
      (await hook({ paymentPayload, requirements, declaredExtensions: {} })) as { abort: true; reason: string; message?: string } | undefined,
  };
}

describe("on-chain preflight of payments the hosted facilitator settles", () => {
  it("lets a payment with an unused nonce and enough balance through, after reading the token, its name, the nonce and the balance", async () => {
    const { calls, run } = preflight();
    assert.equal(await run(), undefined);
    assert.ok(calls.includes(`query_global_state hash-${WCSPR_TESTNET}`), "resolved the token");
    assert.ok(calls.includes(wcsprNonceCall(PAYER, NONCE)), "read the nonce");
    assert.equal(calls.length, 5, "package, contract, name, nonce, balance");
  });

  it("refuses an authorization whose nonce was already used on-chain", async () => {
    const { run } = preflight({ routes: wcsprNodeRoutes({ balances: { [PAYER]: 1_000_000_000n }, usedNonces: [{ payer: PAYER, nonce: NONCE }] }) });
    assert.deepEqual(await run(), {
      abort: true,
      reason: PreflightReason.nonceAlreadyUsed,
      message: "this authorization nonce was already used on-chain",
    });
  });

  it("refuses a payer whose balance does not cover the amount (no balance entry reads as zero)", async () => {
    assert.deepEqual(await preflight({ routes: wcsprNodeRoutes({ balances: { [PAYER]: 199_999_999n } }) }).run(), {
      abort: true,
      reason: PreflightReason.insufficientFunds,
      message: "payer balance 199999999 is below 200000000",
    });
    assert.equal((await preflight({ routes: wcsprNodeRoutes({}) }).run())?.reason, PreflightReason.insufficientFunds);
  });

  it("refuses when the token's transfer_with_authorization is not the configured style, or its name not the signed one", async () => {
    const legacy = await preflight({ asset: { authorization: "legacy-amount" } }).run();
    assert.equal(legacy?.reason, PreflightReason.authorizationStyleMismatch);
    assert.match(String(legacy?.message), /is cep3009-value on-chain, but the gateway sells it as legacy-amount/);

    const renamed = { ...wcsprRequirements(PRICE, PAY_TO), extra: { ...wcsprRequirements(PRICE, PAY_TO).extra, name: "Wrapped CSPR v2" } };
    assert.deepEqual(await preflight().run(renamed), {
      abort: true,
      reason: PreflightReason.tokenDomainMismatch,
      message: 'the EIP-712 domain name must equal the token name "Wrapped CSPR"',
    });
  });

  it("fails closed, without throwing, when the node cannot be read: down, broken answers, or no answer within the deadline", async () => {
    const down: RpcFetch = async () => ({ ok: false, status: 503, text: async () => "down" });
    assert.equal((await preflight({ fetchImpl: down }).run())?.reason, PreflightReason.preflightUnavailable);

    const broken: RpcFetch = async () => ({ ok: true, status: 200, text: async () => "<html>" });
    assert.equal((await preflight({ fetchImpl: broken }).run())?.reason, PreflightReason.preflightUnavailable);

    const hangs: RpcFetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason as Error)));
    const started = Date.now();
    assert.deepEqual(await preflight({ fetchImpl: hangs, deadlineMs: 200 }).run(), {
      abort: true,
      reason: PreflightReason.preflightUnavailable,
      message: "could not read the token state; retry later",
    });
    assert.ok(Date.now() - started < 2_000, "bounded by the preflight deadline");
    assert.equal(HOSTED_PREFLIGHT_DEADLINE_MS, 5_000);
  });

  it("refuses a token that cannot be used for x402 payments", async () => {
    const missing = { ...wcsprNodeRoutes({}), [`query_global_state hash-${WCSPR_TESTNET}`]: fx.testnetUnusedNonceResponse };
    assert.equal((await preflight({ routes: missing }).run())?.reason, PreflightReason.unsupportedAsset);
  });

  it("refuses a payload that names no payer or nonce", async () => {
    const requirements = wcsprRequirements(PRICE, PAY_TO);
    const { calls, run } = preflight();
    assert.equal((await run(requirements, payment(requirements, { nonce: undefined })))?.reason, PreflightReason.invalidPayload);
    assert.deepEqual(calls, []);
  });

  it("leaves payments in other assets and on other networks alone, without reading anything", async () => {
    const { calls, run } = preflight();
    assert.equal(await run({ ...wcsprRequirements(PRICE, PAY_TO), asset: LEGACY_TOKEN }), undefined);
    assert.equal(await run({ ...wcsprRequirements(PRICE, PAY_TO), network: "casper:casper" }), undefined);
    assert.deepEqual(calls, []);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { ResolvedAsset } from "@cascet/core";
import { createCasperRpc, type RpcFetch } from "./casper-rpc.js";
import { HOSTED_PREFLIGHT_DEADLINE_MS, hostedPreflightHook, insufficientFundsInFlight, PreflightReason } from "./hosted-preflight.js";
import { IN_FLIGHT_MARGIN_MS, InFlightPayments, withPaymentHold, type PaymentHold } from "./in-flight.js";
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
function preflight(
  opts: { routes?: Record<string, Replay>; fetchImpl?: RpcFetch; asset?: Partial<ResolvedAsset>; deadlineMs?: number; inFlight?: InFlightPayments } = {},
) {
  const calls: string[] = [];
  const routes = opts.routes ?? wcsprNodeRoutes({ balances: { [PAYER]: 1_000_000_000n } });
  const probe = new TokenProbe(createCasperRpc("http://node.invalid/rpc", { fetchImpl: opts.fetchImpl ?? replayFetch(routes, calls) }));
  const hook = hostedPreflightHook({
    probe,
    network: NETWORK,
    assets: [{ ...WCSPR_ASSET, ...opts.asset }],
    deadlineMs: opts.deadlineMs,
    inFlight: opts.inFlight,
  });
  return {
    calls,
    // The hook only ever passes (undefined) or aborts; it never skips verification. With `hold`, the payment
    // comes as x402 hands it over for a gateway call: with the call's hold in its request context.
    run: async (requirements: PaymentRequirements = wcsprRequirements(PRICE, PAY_TO), paymentPayload = payment(requirements), hold?: PaymentHold) =>
      (await hook({
        paymentPayload,
        requirements,
        declaredExtensions: {},
        transportContext: hold ? { request: withPaymentHold({ path: "/tools/0", method: "POST" }, hold) } : undefined,
      })) as { abort: true; reason: string; message?: string } | undefined,
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

  it("fails closed when the node answers a read without a stored value: a spent nonce never reads as unused", async () => {
    const routes = wcsprNodeRoutes({ balances: { [PAYER]: 1_000_000_000n }, usedNonces: [{ payer: PAYER, nonce: NONCE }] });
    routes[wcsprNonceCall(PAYER, NONCE)] = { jsonrpc: "2.0", id: 1, result: null };
    assert.deepEqual(await preflight({ routes }).run(), {
      abort: true,
      reason: PreflightReason.preflightUnavailable,
      message: "could not read the token state; retry later",
    });
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

describe("payments in flight in the hosted preflight", () => {
  const requirements = wcsprRequirements(PRICE, PAY_TO);
  const nonce = (byte: string) => byte.repeat(32);
  /** A preflight with in-flight tracking over a payer whose balance funds `payments` payments. */
  const tracked = (payments: number, inFlight = new InFlightPayments()) => ({
    inFlight,
    ...preflight({ inFlight, routes: wcsprNodeRoutes({ balances: { [PAYER]: BigInt(PRICE) * BigInt(payments) } }) }),
  });

  it("lets exactly one of two concurrent payments through when the balance funds one, and names the other's in-flight payment", async () => {
    const { inFlight, run } = tracked(1);
    const [first, second] = [inFlight.open(), inFlight.open()];
    const results = await Promise.all([
      run(requirements, payment(requirements, { nonce: nonce("01") }), first),
      run(requirements, payment(requirements, { nonce: nonce("02") }), second),
    ]);
    assert.equal(results.filter(result => result === undefined).length, 1, "one passes");
    assert.deepEqual(
      results.find(result => result !== undefined),
      {
        abort: true,
        reason: insufficientFundsInFlight(1),
        message: `payer balance ${PRICE} does not cover ${PRICE} plus ${PRICE} already in flight`,
      },
    );
    assert.equal(insufficientFundsInFlight(1), "insufficient_funds: insufficient balance once 1 in-flight payment is counted");
    assert.deepEqual(inFlight.total(NETWORK, WCSPR_TESTNET, PAYER), { count: 1, amount: BigInt(PRICE) }, "only the payment that passed is reserved");
  });

  it("frees the balance again once the call of the payment in flight ends", async () => {
    const { inFlight, run } = tracked(1);
    const first = inFlight.open();
    assert.equal(await run(requirements, payment(requirements, { nonce: nonce("01") }), first), undefined);
    assert.equal((await run(requirements, payment(requirements, { nonce: nonce("02") }), inFlight.open()))?.reason, insufficientFundsInFlight(1));
    first.release();
    assert.equal(await run(requirements, payment(requirements, { nonce: nonce("03") }), inFlight.open()), undefined);
  });

  it("counts every payment of the payer in flight in that asset, and nothing else", async () => {
    const inFlight = new InFlightPayments();
    const reserve = (overrides: { payer?: string; asset?: string; network?: string } = {}) =>
      inFlight.reserve(inFlight.open(), { network: NETWORK, asset: WCSPR_TESTNET, payer: PAYER, amount: BigInt(PRICE), validBefore: 4102444800, ...overrides });
    reserve({ payer: `00${"66".repeat(32)}` });
    reserve({ asset: LEGACY_TOKEN });
    reserve({ network: "casper:casper" });
    assert.equal(await tracked(1, inFlight).run(requirements, payment(requirements), inFlight.open()), undefined, "other payers, assets and networks");

    const crowded = new InFlightPayments();
    crowded.reserve(crowded.open(), { network: NETWORK, asset: `hash-${WCSPR_TESTNET.toUpperCase()}`, payer: PAYER.toUpperCase(), amount: BigInt(PRICE), validBefore: 4102444800 });
    crowded.reserve(crowded.open(), { network: NETWORK, asset: WCSPR_TESTNET, payer: PAYER, amount: BigInt(PRICE), validBefore: 4102444800 });
    assert.equal((await tracked(2, crowded).run(requirements, payment(requirements), crowded.open()))?.reason, insufficientFundsInFlight(2));
    assert.equal(insufficientFundsInFlight(2), "insufficient_funds: insufficient balance once 2 in-flight payments are counted");
    assert.equal(await tracked(3, crowded).run(requirements, payment(requirements), crowded.open()), undefined);
  });

  it("keeps the plain insufficient_funds reason when nothing else is in flight, and reserves nothing for a refused payment", async () => {
    const { inFlight, run } = tracked(0);
    assert.deepEqual(await run(requirements, payment(requirements), inFlight.open()), {
      abort: true,
      reason: PreflightReason.insufficientFunds,
      message: `payer balance 0 is below ${PRICE}`,
    });
    const spent = new InFlightPayments();
    const routes = wcsprNodeRoutes({ balances: { [PAYER]: 5n * BigInt(PRICE) }, usedNonces: [{ payer: PAYER, nonce: NONCE }] });
    const used = preflight({ inFlight: spent, routes });
    assert.equal((await used.run(requirements, payment(requirements), spent.open()))?.reason, PreflightReason.nonceAlreadyUsed);
    assert.deepEqual([inFlight.size, spent.size], [0, 0]);
  });

  it("reserves until the authorization's validBefore plus the margin, at most", async () => {
    let now = 0;
    const inFlight = new InFlightPayments({ now: () => now });
    const { run } = tracked(1, inFlight);
    assert.equal(await run(requirements, payment(requirements, { validBefore: "1000" }), inFlight.open()), undefined);
    now = 1_000_000 + IN_FLIGHT_MARGIN_MS - 1;
    assert.deepEqual(inFlight.total(NETWORK, WCSPR_TESTNET, PAYER).count, 1);
    now += 1;
    assert.deepEqual(inFlight.total(NETWORK, WCSPR_TESTNET, PAYER).count, 0, "a stale reservation stops counting");
  });

  it("refuses a payment it could not track: without a hold or a validBefore (before reading anything), or of a call that already ended", async () => {
    const { inFlight, calls, run } = tracked(1);
    assert.deepEqual(await run(requirements, payment(requirements)), {
      abort: true,
      reason: PreflightReason.preflightUnavailable,
      message: "the gateway cannot track this payment while it is in flight",
    });
    assert.deepEqual(await run(requirements, payment(requirements, { validBefore: undefined }), inFlight.open()), {
      abort: true,
      reason: PreflightReason.invalidPayload,
      message: "the payment names no validBefore",
    });
    assert.deepEqual(calls, []);
    const ended = inFlight.open();
    ended.release();
    assert.equal((await run(requirements, payment(requirements), ended))?.reason, PreflightReason.preflightUnavailable);
    assert.equal(inFlight.size, 0);
  });

  it("refuses rather than forget a live payment when the tracker is full", async () => {
    const inFlight = new InFlightPayments({ maxPayments: 1 });
    inFlight.reserve(inFlight.open(), { network: NETWORK, asset: LEGACY_TOKEN, payer: PAYER, amount: 1n, validBefore: 4102444800 });
    assert.deepEqual(await tracked(1, inFlight).run(requirements, payment(requirements), inFlight.open()), {
      abort: true,
      reason: "preflight_unavailable: too many payments in flight; retry later",
      message: "the in-flight payments are at their limit",
    });
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import casperSdk from "casper-js-sdk";
import { isKnownCep3009Asset, NETWORK_CASPER_TESTNET } from "@cascet/core";
import { wcsprDepositResult } from "./gas-fixtures.js";
import {
  buildWrapTransaction,
  CARGO_PURSE_SETUP_MOTES,
  DEFAULT_WRAP_GAS_MOTES,
  estimateWrapConsumedMotes,
  formatWrapPlan,
  planWrap,
  RECORDED_DEPOSIT_CONSUMED_MOTES,
  TESTNET_WCSPR,
} from "./wcspr.js";

const { PrivateKey, KeyAlgorithm, TransactionWrapper } = casperSdk;
const CSPR = 1_000_000_000n;

describe("WCSPR wrap: facts", () => {
  test("wraps into the known testnet CEP-3009 Wrapped CSPR, the token the recorded deposit called", () => {
    assert.ok(isKnownCep3009Asset(NETWORK_CASPER_TESTNET, TESTNET_WCSPR.packageHash));
    const named = Object.fromEntries(wcsprDepositResult.transaction.Version1.payload.fields.args.Named);
    assert.equal(named["package_hash"]?.parsed, TESTNET_WCSPR.packageHash);
    assert.equal(named["entry_point"]?.parsed, "deposit");
    assert.deepEqual(
      { name: TESTNET_WCSPR.name, symbol: TESTNET_WCSPR.symbol, decimals: TESTNET_WCSPR.decimals, network: TESTNET_WCSPR.network },
      { name: "Wrapped CSPR", symbol: "WCSPR", decimals: 9, network: "casper:casper-test" },
    );
  });

  test("the consumption estimate starts from the recorded deposit and adds the cargo purse on first use", () => {
    assert.equal(RECORDED_DEPOSIT_CONSUMED_MOTES, BigInt(wcsprDepositResult.execution_info.execution_result.Version2.consumed));
    assert.equal(estimateWrapConsumedMotes(true), 1_487_646_582n);
    assert.equal(estimateWrapConsumedMotes(false), 1_487_646_582n + CARGO_PURSE_SETUP_MOTES);
    assert.ok(DEFAULT_WRAP_GAS_MOTES >= 2n * estimateWrapConsumedMotes(false), "the default limit has 2x headroom over the worst estimate");
  });
});

describe("WCSPR wrap: expected cost", () => {
  test("first wrap of an account (no cargo purse yet) with the default limit", () => {
    const plan = planWrap(5n * CSPR, DEFAULT_WRAP_GAS_MOTES, false);
    const consumed = 4_187_646_582n;
    assert.equal(plan.estimatedConsumedMotes, consumed);
    assert.equal(plan.estimatedRefundMotes, ((10n * CSPR - consumed) * 75n) / 100n);
    assert.equal(plan.estimatedNetGasMotes, 10n * CSPR - plan.estimatedRefundMotes);
    assert.equal(plan.requiredBalanceMotes, 15n * CSPR, "deposit plus the whole limit, charged up front");
    assert.equal(plan.expectedDebitMotes, 5n * CSPR + plan.estimatedNetGasMotes);
    assert.equal(plan.worstCaseLossMotes, 10n * CSPR);
  });

  test("an unknown cargo purse is assumed missing (the conservative estimate)", () => {
    assert.equal(planWrap(CSPR, DEFAULT_WRAP_GAS_MOTES, undefined).estimatedConsumedMotes, estimateWrapConsumedMotes(false));
  });

  test("refuses a zero wrap and a limit below the estimated consumption", () => {
    assert.throws(() => planWrap(0n, DEFAULT_WRAP_GAS_MOTES, true), /more than 0 CSPR/);
    assert.throws(() => planWrap(CSPR, 4n * CSPR, false), /below the estimated consumption of 4\.19 CSPR/);
    assert.doesNotThrow(() => planWrap(CSPR, 4n * CSPR, true));
  });

  test("prints the expected cost", () => {
    const lines = formatWrapPlan(planWrap(5n * CSPR, DEFAULT_WRAP_GAS_MOTES, false));
    const text = lines.join("\n");
    assert.match(text, /deposit \(attached value\):\s+5 CSPR → \+5 WCSPR/);
    assert.match(text, /gas limit \(charged up front\):\s+10 CSPR/);
    assert.match(text, /estimated gas consumed:\s+~4\.19 CSPR \(first proxy call with attached CSPR: \+2\.7 CSPR to create the cargo purse\)/);
    assert.match(text, /refund on success \(75% unused\):\s+~4\.36 CSPR/);
    assert.match(text, /expected gas cost:\s+~5\.64 CSPR/);
    assert.match(text, /expected total debit:\s+~10\.64 CSPR/);
    assert.match(text, /if it reverts:\s+10 CSPR of gas is burned, nothing is wrapped/);
    assert.match(text, /balance needed to submit:\s+15 CSPR/);
    assert.match(formatWrapPlan(planWrap(CSPR, 5n * CSPR, true)).join("\n"), /the account has a cargo purse/);
  });
});

describe("WCSPR wrap: the transaction", () => {
  test("is the Odra proxy session calling deposit with the CSPR attached (args of the recorded deposit, scaled)", () => {
    const key = PrivateKey.generate(KeyAlgorithm.ED25519); // throwaway, in memory only
    const wasm = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);
    const tx = buildWrapTransaction(wasm, 1_000_000_000n, {
      initiatorPublicKey: key.publicKey.toHex(),
      chainName: "casper-test",
      paymentMotes: DEFAULT_WRAP_GAS_MOTES,
    });
    const json = TransactionWrapper.toJSON(tx.getTransactionWrapper()) as {
      Version1: { payload: { pricing_mode: { PaymentLimited: { payment_amount: number } }; fields: { args: { Named: Array<[string, { bytes: string }]> } } } };
    };
    const built = json.Version1.payload.fields.args.Named.map(([name, v]) => [name, v.bytes]);
    const recorded = wcsprDepositResult.transaction.Version1.payload.fields.args.Named.map(([name, v]) => [name, v.bytes]);
    assert.deepEqual(built, recorded, "1 CSPR attached, like the recorded deposit");
    assert.equal(json.Version1.payload.pricing_mode.PaymentLimited.payment_amount, 10_000_000_000);
    assert.throws(() => buildWrapTransaction(wasm, 0n, { initiatorPublicKey: key.publicKey.toHex(), chainName: "casper-test", paymentMotes: CSPR }), /more than 0/);
  });
});

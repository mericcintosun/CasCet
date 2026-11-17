import assert from "node:assert/strict";
import { describe, test } from "node:test";
import casperSdk from "casper-js-sdk";
import { AUTHORIZATION_STYLES, type AuthorizationStyle } from "@cascet/core";
import { createCasperRpc } from "@cascet/gateway";
import * as fx from "./rpc-fixtures.js";
import {
  AMOUNT_ARGUMENT_BY_STYLE,
  amountArgumentName,
  buildSettlementTransaction,
  createCasperSettlementChain,
  netCostMotes,
  parseExecutionInfo,
  SETTLEABLE_STYLES,
  transferWithAuthorizationArgs,
  type SettlementInput,
} from "./settlement.js";
import { FakeClock, replayFetch, rpcError, rpcResult } from "./test-helpers.js";

const { PrivateKey, KeyAlgorithm, TransactionWrapper } = casperSdk;

type RecordedArg = { cl_type: unknown; bytes: string; parsed: unknown };
type RecordedTx = {
  hash: string;
  payload: {
    initiator_addr: { PublicKey: string };
    timestamp: string;
    chain_name: string;
    pricing_mode: { PaymentLimited: { payment_amount: number } };
    fields: { args: { Named: ReadonlyArray<readonly [string, RecordedArg]> }; target: { Stored: { id: { ByPackageHash: { addr: string } } } } };
  };
};
type TxJson = { Version1: { hash: string; payload: { fields: { args: { Named: Array<[string, { bytes: string; cl_type: unknown }]> } } } } };

const argsOf = (tx: RecordedTx) => Object.fromEntries(tx.payload.fields.args.Named.map(([name, v]) => [name, v])) as Record<string, RecordedArg>;

/** The authorization a recorded settlement carried (in either style), as the facilitator receives it. */
function inputOf(tx: RecordedTx): SettlementInput {
  const args = argsOf(tx);
  const amount = args["amount"] ?? args["value"];
  return {
    asset: tx.payload.fields.target.Stored.id.ByPackageHash.addr,
    from: args["from"]!.bytes,
    to: args["to"]!.bytes,
    value: BigInt(amount!.parsed as string),
    validAfter: args["valid_after"]!.parsed as number,
    validBefore: args["valid_before"]!.parsed as number,
    nonce: args["nonce"]!.bytes.slice(8), // strip the Vec<u8> length prefix
    publicKey: args["public_key"]!.bytes,
    signature: args["signature"]!.bytes.slice(8),
  };
}

/** Rebuild a recorded settlement in `style` with its own fee payer, chain, limit, timestamp and TTL. */
function rebuild(tx: RecordedTx, style: AuthorizationStyle, ttlMs: number) {
  return buildSettlementTransaction(inputOf(tx), {
    feePayerPublicKey: tx.payload.initiator_addr.PublicKey,
    chainName: tx.payload.chain_name,
    style,
    paymentMotes: BigInt(tx.payload.pricing_mode.PaymentLimited.payment_amount),
    ttlMs,
    timestamp: new Date(tx.payload.timestamp),
  });
}

const recorded = fx.testnetSettledTransaction;
const recordedArgs = argsOf(recorded);
/** The authorization settled by testnet tx 04e54a95… (legacy-amount). */
const settledInput = inputOf(recorded);
const hosted = fx.testnetHostedValueTransaction;

describe("settlement transaction builder: one path, two styles", () => {
  test("legacy-amount rebuilds settled testnet tx 04e54a95 byte for byte (casper-x402 1.0.0, `amount`)", () => {
    const tx = rebuild(recorded, "legacy-amount", 30 * 60_000);
    assert.equal(tx.hash.toHex(), recorded.hash);

    const json = TransactionWrapper.toJSON(tx.getTransactionWrapper()) as TxJson;
    const rebuilt = json.Version1.payload.fields.args.Named;
    assert.deepEqual(
      rebuilt.map(([name]) => name),
      ["from", "to", "amount", "valid_after", "valid_before", "nonce", "public_key", "signature"],
    );
    const byName = Object.fromEntries(rebuilt);
    for (const name of ["from", "to", "amount", "valid_after", "valid_before", "nonce", "public_key", "signature"]) {
      assert.equal(byName[name]?.bytes, recordedArgs[name]!.bytes, `arg ${name}`);
      assert.deepEqual(byName[name]?.cl_type, recordedArgs[name]!.cl_type, `arg ${name} type`);
    }
  });

  test("cep3009-value rebuilds the hosted facilitator's testnet tx 9fe35eed byte for byte (@x402/casper, `value`)", () => {
    const hostedArgs = argsOf(hosted);
    const tx = rebuild(hosted, "cep3009-value", 15 * 60_000);
    assert.equal(tx.hash.toHex(), hosted.hash, "same payload hash as the official builder's transaction");

    const json = TransactionWrapper.toJSON(tx.getTransactionWrapper()) as TxJson;
    const rebuilt = json.Version1.payload.fields.args.Named;
    assert.deepEqual(
      rebuilt.map(([name]) => name),
      ["from", "to", "value", "valid_after", "valid_before", "nonce", "public_key", "signature"],
    );
    for (const [name, arg] of rebuilt) {
      assert.equal(arg.bytes, hostedArgs[name]!.bytes, `arg ${name}`);
      assert.deepEqual(arg.cl_type, hostedArgs[name]!.cl_type, `arg ${name} type`);
    }
  });

  test("the style decides only the amount argument's name", () => {
    const named = (style: AuthorizationStyle) =>
      (
        TransactionWrapper.toJSON(rebuild(recorded, style, 30 * 60_000).getTransactionWrapper()) as TxJson
      ).Version1.payload.fields.args.Named;
    const legacy = named("legacy-amount");
    const value = named("cep3009-value");
    assert.deepEqual(
      legacy.map(([name]) => (name === "amount" ? "<amount>" : name)),
      value.map(([name]) => (name === "value" ? "<amount>" : name)),
    );
    assert.deepEqual(
      legacy.map(([, arg]) => arg),
      value.map(([, arg]) => arg),
      "identical CLTypes and bytes",
    );
    assert.equal(legacy.find(([n]) => n === "value"), undefined);
    assert.equal(value.find(([n]) => n === "amount"), undefined);
    // A transaction of the wrong style is a different transaction.
    assert.notEqual(rebuild(recorded, "cep3009-value", 30 * 60_000).hash.toHex(), recorded.hash);
  });

  test("unknown styles are refused instead of guessed", () => {
    assert.deepEqual(AMOUNT_ARGUMENT_BY_STYLE, { "legacy-amount": "amount", "cep3009-value": "value" });
    assert.ok(Object.isFrozen(AMOUNT_ARGUMENT_BY_STYLE));
    assert.deepEqual([amountArgumentName("legacy-amount"), amountArgumentName("cep3009-value")], ["amount", "value"]);
    assert.throws(() => amountArgumentName("value" as AuthorizationStyle), /unknown authorization style/);
    assert.throws(() => transferWithAuthorizationArgs(settledInput, "cep3009" as AuthorizationStyle), /unknown authorization style/);
  });

  test("SETTLEABLE_STYLES are exactly the styles whose amount argument the builder sends", () => {
    const sentArguments = (style: AuthorizationStyle) => {
      const tx = buildSettlementTransaction(settledInput, {
        feePayerPublicKey: recorded.payload.initiator_addr.PublicKey,
        chainName: "casper-test",
        style,
        paymentMotes: 4_000_000_000n,
        ttlMs: 10 * 60_000,
      });
      const json = TransactionWrapper.toJSON(tx.getTransactionWrapper()) as TxJson;
      return new Set(json.Version1.payload.fields.args.Named.map(([name]) => name));
    };
    assert.deepEqual(
      [...SETTLEABLE_STYLES],
      AUTHORIZATION_STYLES.filter(style => sentArguments(style).has(AMOUNT_ARGUMENT_BY_STYLE[style])),
    );
    assert.deepEqual([...SETTLEABLE_STYLES], ["legacy-amount", "cep3009-value"]);
    assert.ok(Object.isFrozen(SETTLEABLE_STYLES));
  });

  test("uses the requested gas limit (4 CSPR default path)", () => {
    const tx = buildSettlementTransaction(settledInput, {
      feePayerPublicKey: recorded.payload.initiator_addr.PublicKey,
      chainName: "casper-test",
      style: "legacy-amount",
      paymentMotes: 4_000_000_000n,
      ttlMs: 10 * 60_000,
    });
    const json = TransactionWrapper.toJSON(tx.getTransactionWrapper()) as {
      Version1: { payload: { ttl: string; pricing_mode: { PaymentLimited: { payment_amount: number } } } };
    };
    assert.equal(json.Version1.payload.pricing_mode.PaymentLimited.payment_amount, 4_000_000_000);
    assert.equal(json.Version1.payload.ttl, "10m");
  });
});

describe("execution results", () => {
  test("recorded success: net cost is cost − refund", () => {
    const outcome = parseExecutionInfo(recorded.execution_info);
    assert.equal(outcome?.kind, "success");
    // 7 CSPR limit, 2.7066 CSPR consumed, 75% of the unused part refunded.
    assert.equal(outcome?.kind === "success" ? outcome.costMotes : undefined, 7_000_000_000n - 3_220_079_032n);
    assert.equal(outcome?.blockHeight, 8_591_707);
  });

  test("recorded revert of the wrong style: User error 64658, the whole limit is charged", () => {
    // The hosted facilitator sent `value` to CasCet's `amount` token: Odra MissingArg.
    const outcome = parseExecutionInfo(hosted.execution_info);
    assert.deepEqual(outcome, { kind: "failure", errorMessage: "User error: 64658", costMotes: 6_000_000_000n, blockHeight: 8_594_884 });
  });

  test("an error_message is a failure; missing execution info is not final", () => {
    const failed = parseExecutionInfo({
      block_height: 1,
      execution_result: { Version2: { error_message: "User error: 64658", cost: "4000000000", refund: "0" } },
    });
    assert.deepEqual(failed, { kind: "failure", errorMessage: "User error: 64658", costMotes: 4_000_000_000n, blockHeight: 1 });
    assert.equal(parseExecutionInfo(null), undefined);
    assert.equal(parseExecutionInfo({ block_height: 1, execution_result: null }), undefined);
    assert.equal(netCostMotes("x", "1"), undefined);
  });
});

function chainWith(routes: Record<string, unknown>, clock = new FakeClock(1_000_000), slept: number[] = []) {
  const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
  const rpc = createCasperRpc("http://rpc.invalid", { fetchImpl: replayFetch(routes) });
  const chain = createCasperSettlementChain({
    rpc,
    privateKey,
    chainName: "casper-test",
    pollDelaysMs: [1000, 2000],
    now: clock.now,
    sleep: async ms => {
      slept.push(ms);
      clock.advance(ms);
    },
  });
  return { chain, privateKey, clock, slept };
}

const LEGACY = { style: "legacy-amount", paymentMotes: 4_000_000_000n } as const;

describe("submission", () => {
  test("signs with the fee payer and reports the locally computed hash", async () => {
    const { chain, privateKey } = chainWith({
      account_put_transaction: (p: Record<string, unknown>) => {
        const tx = (p["transaction"] as { Version1: { hash: string } }).Version1;
        return rpcResult({ api_version: "2.0.0", transaction_hash: { Version1: tx.hash } });
      },
    });
    const built = chain.build(settledInput, { ...LEGACY, ttlMs: 600_000 });
    const json = built.json as { Version1: { hash: string; approvals: Array<{ signer: string }> } };
    assert.equal(json.Version1.hash, built.hash);
    assert.equal(json.Version1.approvals[0]?.signer, privateKey.publicKey.toHex());
    assert.equal(chain.feePayerAccountHash, privateKey.publicKey.accountHash().toHex());
    assert.deepEqual(await chain.submit(built), { kind: "accepted", hash: built.hash });
  });

  test("each settlement carries its asset's style and gas limit", () => {
    const { chain } = chainWith({});
    const payloadOf = (settings: { style: AuthorizationStyle; paymentMotes: bigint }) =>
      (
        chain.build(settledInput, { ...settings, ttlMs: 600_000 }).json as {
          Version1: { payload: { pricing_mode: { PaymentLimited: { payment_amount: number } }; fields: { args: { Named: Array<[string, unknown]> } } } };
        }
      ).Version1.payload;
    const legacy = payloadOf(LEGACY);
    const value = payloadOf({ style: "cep3009-value", paymentMotes: 3_500_000_000n });
    assert.deepEqual(legacy.fields.args.Named.map(([n]) => n).slice(0, 3), ["from", "to", "amount"]);
    assert.deepEqual(value.fields.args.Named.map(([n]) => n).slice(0, 3), ["from", "to", "value"]);
    assert.equal(legacy.pricing_mode.PaymentLimited.payment_amount, 4_000_000_000);
    assert.equal(value.pricing_mode.PaymentLimited.payment_amount, 3_500_000_000);
    assert.throws(() => chain.build(settledInput, { style: "legacy-amount", paymentMotes: 0n, ttlMs: 600_000 }), /gas limit out of range/);
  });

  test("the TTL is capped at the chain maximum and rounded down to whole seconds", () => {
    const { chain } = chainWith({});
    const ttlOf = (requested: number) =>
      (chain.build(settledInput, { ...LEGACY, ttlMs: requested }).json as { Version1: { payload: { ttl: string } } }).Version1.payload.ttl;
    assert.equal(ttlOf(297_345), "4m 57s", "never a fractional duration the node cannot parse");
    assert.equal(ttlOf(3_600_000), "10m", "capped at the chain's maximum TTL");
    assert.equal(ttlOf(18_000), "18s");
    assert.throws(() => chain.build(settledInput, { ...LEGACY, ttlMs: 999 }), /at least 1 s/);
  });

  test("only proof of rejection counts as 'not submitted'", async () => {
    const cases: Array<[unknown, string]> = [
      [rpcError(-32016, "Invalid transaction", "insufficient balance"), "rejected"],
      [rpcError(-32602, "Invalid params"), "rejected"],
      [rpcError(-32018, "Node request failure"), "unknown"],
      [rpcError(-32603, "Internal error"), "unknown"],
      [new Error("socket hang up"), "unknown"],
    ];
    for (const [response, kind] of cases) {
      const { chain } = chainWith({ account_put_transaction: response });
      const built = chain.build(settledInput, { ...LEGACY, ttlMs: 600_000 });
      const outcome = await chain.submit(built);
      assert.equal(outcome.kind, kind);
      if (outcome.kind === "unknown") assert.equal(outcome.hash, built.hash);
    }
  });
});

describe("polling (M22)", () => {
  test("transient errors and a lagging node never turn into a failure", async () => {
    let n = 0;
    const script = [
      fx.noSuchTransactionResponse,
      new Error("ECONNRESET"),
      rpcError(-32603, "Internal error"),
      rpcResult({ api_version: "2.0.0", transaction: {}, execution_info: null }),
      rpcResult({ api_version: "2.0.0", transaction: {}, execution_info: recorded.execution_info }),
    ];
    const { chain, slept } = chainWith({ info_get_transaction: () => script[n++] });
    const outcome = await chain.waitForExecution("ab".repeat(32), 1_000_000 + 60_000);
    assert.equal(outcome.kind, "success");
    assert.equal(n, 5);
    assert.deepEqual(slept, [1000, 2000, 2000, 2000]);
  });

  test("past the deadline the hash is reported as pending, with seen = whether the node knew it", async () => {
    const lagging = chainWith({ info_get_transaction: fx.noSuchTransactionResponse });
    const notSeen = await lagging.chain.waitForExecution("ab".repeat(32), 1_000_000 + 5_500);
    assert.equal(notSeen.kind, "pending");
    assert.equal(notSeen.kind === "pending" && notSeen.seen, false);
    // Never sleeps past the deadline.
    assert.equal(lagging.slept.reduce((a, b) => a + b, 0), 5_500);

    const known = chainWith({ info_get_transaction: rpcResult({ transaction: {}, execution_info: null }) });
    const seen = await known.chain.waitForExecution("ab".repeat(32), 1_000_000 + 3_000);
    assert.equal(seen.kind === "pending" && seen.seen, true);
  });

  test("an on-chain revert is reported with its message and cost", async () => {
    const { chain } = chainWith({
      info_get_transaction: rpcResult({
        execution_info: {
          block_height: 9,
          execution_result: { Version2: { error_message: "User error: 4", cost: "4000000000", refund: "990000000" } },
        },
      }),
    });
    const outcome = await chain.waitForExecution("cd".repeat(32), 2_000_000);
    assert.deepEqual(outcome, { kind: "failure", errorMessage: "User error: 4", costMotes: 3_010_000_000n, blockHeight: 9 });
  });
});

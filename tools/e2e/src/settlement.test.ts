import assert from "node:assert/strict";
import { describe, test } from "node:test";
import casperSdk from "casper-js-sdk";
import { AUTHORIZATION_STYLES, type AuthorizationStyle } from "@cascet/core";
import { createCasperRpc } from "@cascet/gateway";
import * as fx from "./rpc-fixtures.js";
import {
  buildSettlementTransaction,
  createCasperSettlementChain,
  netCostMotes,
  parseExecutionInfo,
  SETTLEABLE_STYLES,
  type SettlementInput,
} from "./settlement.js";
import { FakeClock, replayFetch, rpcError, rpcResult } from "./test-helpers.js";

const { PrivateKey, KeyAlgorithm, TransactionWrapper } = casperSdk;

const recorded = fx.testnetSettledTransaction;
const recordedArgs = Object.fromEntries(recorded.payload.fields.args.Named.map(([name, v]) => [name, v])) as Record<
  string,
  { cl_type: unknown; bytes: string; parsed: unknown }
>;

/** The authorization settled by testnet tx 04e54a95…, as the facilitator receives it. */
const settledInput: SettlementInput = {
  asset: recorded.payload.fields.target.Stored.id.ByPackageHash.addr,
  from: recordedArgs["from"]!.bytes,
  to: recordedArgs["to"]!.bytes,
  value: BigInt(recordedArgs["amount"]!.parsed as string),
  validAfter: recordedArgs["valid_after"]!.parsed as number,
  validBefore: recordedArgs["valid_before"]!.parsed as number,
  nonce: recordedArgs["nonce"]!.bytes.slice(8), // strip the Vec<u8> length prefix
  publicKey: recordedArgs["public_key"]!.bytes,
  signature: recordedArgs["signature"]!.bytes.slice(8),
};

describe("settlement transaction builder", () => {
  test("rebuilds settled testnet tx 04e54a95 byte for byte (same payload hash)", () => {
    const tx = buildSettlementTransaction(settledInput, {
      feePayerPublicKey: recorded.payload.initiator_addr.PublicKey,
      chainName: recorded.payload.chain_name,
      paymentMotes: BigInt(recorded.payload.pricing_mode.PaymentLimited.payment_amount),
      ttlMs: 30 * 60_000,
      timestamp: new Date(recorded.payload.timestamp),
    });
    assert.equal(tx.hash.toHex(), recorded.hash);

    const json = TransactionWrapper.toJSON(tx.getTransactionWrapper()) as {
      Version1: { payload: { fields: { args: { Named: Array<[string, { bytes: string; cl_type: unknown }]> } } } };
    };
    const rebuilt = Object.fromEntries(json.Version1.payload.fields.args.Named);
    for (const name of ["from", "to", "amount", "valid_after", "valid_before", "nonce", "public_key", "signature"]) {
      assert.equal(rebuilt[name]?.bytes, recordedArgs[name]!.bytes, `arg ${name}`);
      assert.deepEqual(rebuilt[name]?.cl_type, recordedArgs[name]!.cl_type, `arg ${name} type`);
    }
  });

  test("SETTLEABLE_STYLES are exactly the styles whose amount argument the builder sends", () => {
    const amountArgument: Record<AuthorizationStyle, string> = { "legacy-amount": "amount", "cep3009-value": "value" };
    const tx = buildSettlementTransaction(settledInput, {
      feePayerPublicKey: recorded.payload.initiator_addr.PublicKey,
      chainName: "casper-test",
      paymentMotes: 4_000_000_000n,
      ttlMs: 10 * 60_000,
    });
    const json = TransactionWrapper.toJSON(tx.getTransactionWrapper()) as {
      Version1: { payload: { fields: { args: { Named: Array<[string, unknown]> } } } };
    };
    const sent = new Set(json.Version1.payload.fields.args.Named.map(([name]) => name));
    assert.deepEqual(
      [...SETTLEABLE_STYLES],
      AUTHORIZATION_STYLES.filter(style => sent.has(amountArgument[style])),
    );
    assert.deepEqual([...SETTLEABLE_STYLES], ["legacy-amount"], "this builder sends `amount` only");
    assert.ok(Object.isFrozen(SETTLEABLE_STYLES));
  });

  test("uses the requested gas limit (4 CSPR default path)", () => {
    const tx = buildSettlementTransaction(settledInput, {
      feePayerPublicKey: recorded.payload.initiator_addr.PublicKey,
      chainName: "casper-test",
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

describe("submission", () => {
  test("signs with the fee payer and reports the locally computed hash", async () => {
    const { chain, privateKey } = chainWith({
      account_put_transaction: (p: Record<string, unknown>) => {
        const tx = (p["transaction"] as { Version1: { hash: string } }).Version1;
        return rpcResult({ api_version: "2.0.0", transaction_hash: { Version1: tx.hash } });
      },
    });
    const built = chain.build(settledInput, 4_000_000_000n, 600_000);
    const json = built.json as { Version1: { hash: string; approvals: Array<{ signer: string }> } };
    assert.equal(json.Version1.hash, built.hash);
    assert.equal(json.Version1.approvals[0]?.signer, privateKey.publicKey.toHex());
    assert.equal(chain.feePayerAccountHash, privateKey.publicKey.accountHash().toHex());
    assert.deepEqual(await chain.submit(built), { kind: "accepted", hash: built.hash });
  });

  test("the TTL is capped at the chain maximum and rounded down to whole seconds", () => {
    const { chain } = chainWith({});
    const ttlOf = (requested: number) =>
      (chain.build(settledInput, 4_000_000_000n, requested).json as { Version1: { payload: { ttl: string } } }).Version1.payload.ttl;
    assert.equal(ttlOf(297_345), "4m 57s", "never a fractional duration the node cannot parse");
    assert.equal(ttlOf(3_600_000), "10m", "capped at the chain's maximum TTL");
    assert.equal(ttlOf(18_000), "18s");
    assert.throws(() => chain.build(settledInput, 4_000_000_000n, 999), /at least 1 s/);
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
      const built = chain.build(settledInput, 4_000_000_000n, 600_000);
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

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE } from "@cascet/core";
import { createCasperRpc } from "@cascet/gateway";
import * as gx from "./gas-fixtures.js";
import {
  classifyTransaction,
  DEFAULT_ANCHOR_GAS_MOTES,
  defaultLimitFor,
  expectedNetMotes,
  expectedRefundMotes,
  formatCostTable,
  formatGasSuggestions,
  gasSuggestions,
  kindLabel,
  MIN_INITIATOR_BALANCE_MOTES,
  normalizeTransactionHash,
  parseTransactionCost,
  readTransactionReport,
  suggestGasLimitMotes,
  type TransactionReport,
} from "./gas-report.js";
import { testnetSettledTransaction } from "./rpc-fixtures.js";
import { FakeClock, replayFetch, rpcError, rpcResult } from "./test-helpers.js";

const successes = [
  ["wrap 77fb850a", gx.wcsprDepositResult],
  ["hosted legacy settle 2ffeb8c7", gx.hostedLegacySettleResult],
  ["mainnet legacy settle 754224da", gx.mainnetLegacySettleResult],
  ["anchor 70e4c416", gx.anchorRecordResult],
  ["transfer d299b19b", gx.cep18TransferResult],
] as const;

describe("measured gas: execution results", () => {
  test("reads limit, consumed, cost, refund and net cost of Casper 2.0 results", () => {
    const cost = parseTransactionCost(testnetSettledTransaction.execution_info)!;
    assert.deepEqual(cost, {
      status: "success",
      limitMotes: 7_000_000_000n,
      consumedMotes: 2_706_561_290n,
      costMotes: 7_000_000_000n,
      refundMotes: 3_220_079_032n,
      netMotes: 3_779_920_968n,
      gasPrice: 1,
      blockHeight: 8_591_707,
    });
  });

  test("a reverted transaction is a failure with no refund: the whole limit is lost", () => {
    const cost = parseTransactionCost(gx.hostedValueOnLegacyTokenResult.execution_info)!;
    assert.equal(cost.status, "failure");
    assert.equal(cost.errorMessage, "User error: 64658");
    assert.equal(cost.refundMotes, 0n);
    assert.equal(cost.netMotes, 6_000_000_000n);
    assert.equal(cost.consumedMotes, 9_719_645n);
  });

  test("the 75% refund rule reproduces the node's refund of every recorded success, to the mote", () => {
    for (const [name, fixture] of successes) {
      const cost = parseTransactionCost(fixture.execution_info)!;
      assert.equal(cost.status, "success", name);
      assert.equal(expectedRefundMotes(cost.limitMotes!, cost.consumedMotes!), cost.refundMotes, name);
      assert.equal(expectedNetMotes(cost.limitMotes!, cost.consumedMotes!), cost.netMotes, name);
    }
    assert.equal(expectedRefundMotes(5n, 9n), 0n, "no refund when consumption reaches the limit");
  });

  test("Casper 1.x results only carry a cost; unexecuted ones are undefined", () => {
    assert.deepEqual(parseTransactionCost({ block_height: 7, execution_result: { Version1: { Success: { cost: "2500000000" } } } }), {
      status: "success",
      costMotes: 2_500_000_000n,
      netMotes: 2_500_000_000n,
      blockHeight: 7,
    });
    assert.deepEqual(parseTransactionCost({ execution_result: { Version1: { Failure: { cost: "100", error_message: "Out of gas error" } } } }), {
      status: "failure",
      errorMessage: "Out of gas error",
      costMotes: 100n,
      netMotes: 100n,
    });
    assert.equal(parseTransactionCost(null), undefined);
    assert.equal(parseTransactionCost({ block_hash: "x", execution_result: null }), undefined);
    assert.equal(parseTransactionCost({ execution_result: { Version3: {} } }), undefined);
  });

  test("suggests ceil(1.3 × max consumed), rounded up to 0.01 CSPR", () => {
    assert.equal(suggestGasLimitMotes([2_706_561_290n]), 3_520_000_000n); // legacy settle: 3.52 CSPR
    assert.equal(suggestGasLimitMotes([1_130_000_000n]), 1_470_000_000n); // hosted WCSPR settle: 1.47 CSPR
    assert.equal(suggestGasLimitMotes([2_696_193_533n, 2_707_825_069n, 2_706_561_290n]), 3_530_000_000n);
    assert.equal(suggestGasLimitMotes([1_000_000_000n]), 1_300_000_000n, "exact multiples stay");
    assert.equal(suggestGasLimitMotes([1n]), 10_000_000n);
    assert.equal(suggestGasLimitMotes([2_000_000_000n], { headroomPercent: 150, stepMotes: 1n }), 3_000_000_000n);
    assert.throws(() => suggestGasLimitMotes([]), /no measured consumption/);
    assert.throws(() => suggestGasLimitMotes([1n], { headroomPercent: 90 }), /at least 100/);
  });
});

describe("measured gas: what a transaction did", () => {
  test("classifies recorded settles by the argument their facilitator sent", () => {
    assert.deepEqual(classifyTransaction(gx.hostedLegacySettleResult.transaction), {
      kind: "settle",
      style: "legacy-amount",
      asset: "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3",
    });
    assert.deepEqual(classifyTransaction(gx.hostedValueOnLegacyTokenResult.transaction), {
      kind: "settle",
      style: "cep3009-value",
      asset: "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3",
    });
    assert.equal(kindLabel(classifyTransaction(gx.mainnetLegacySettleResult.transaction)), "settle (legacy-amount)");
  });

  test("classifies anchors by entry point, not by their `amount` argument", () => {
    assert.deepEqual(classifyTransaction(gx.anchorRecordResult.transaction), {
      kind: "anchor",
      registry: "bdf8422b69d7bfb7581e7b2c63fbfb0fc8b23701181289411170bce5cf996f97",
    });
  });

  test("classifies a WCSPR wrap (proxy session calling deposit) and a CEP-18 transfer", () => {
    assert.deepEqual(classifyTransaction(gx.wcsprDepositResult.transaction), {
      kind: "wrap",
      asset: "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e",
    });
    assert.deepEqual(classifyTransaction(gx.cep18TransferResult.transaction), {
      kind: "transfer",
      asset: "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3",
    });
  });

  test("handles legacy deploys, other sessions and garbage", () => {
    const deploy = {
      Deploy: {
        session: {
          StoredVersionedContractByHash: {
            hash: "AB".repeat(32),
            entry_point: "transfer_with_authorization",
            args: [["value", { cl_type: "U256", parsed: "1" }], ["from", { cl_type: "Key" }]],
          },
        },
      },
    };
    assert.deepEqual(classifyTransaction(deploy), { kind: "settle", style: "cep3009-value", asset: "ab".repeat(32) });
    const otherSession = {
      Version1: { payload: { fields: { args: { Named: [["entry_point", { cl_type: "String", parsed: "charge" }]] }, target: { Session: {} } } } },
    };
    assert.deepEqual(classifyTransaction(otherSession), { kind: "other", entryPoint: "session → charge" });
    assert.equal(kindLabel(classifyTransaction(otherSession)), "other (session → charge)");
    assert.deepEqual(classifyTransaction({ Deploy: { session: { ModuleBytes: {} } } }), { kind: "other", entryPoint: "session" });
    assert.deepEqual(classifyTransaction("nope"), { kind: "other" });
    assert.deepEqual(classifyTransaction({ Version1: {} }), { kind: "other" });
  });
});

describe("measured gas: reading transactions back (read-only)", () => {
  const hash = gx.hostedLegacySettleResult.transaction.Version1.hash;

  test("reads an executed Version1 transaction", async () => {
    const calls: string[] = [];
    const rpc = createCasperRpc("http://node.test/rpc", { fetchImpl: replayFetch({ info_get_transaction: rpcResult(gx.hostedLegacySettleResult) }, calls) });
    const report = await readTransactionReport(rpc, hash.toUpperCase());
    assert.equal(report.hash, hash);
    assert.equal(kindLabel(report.kind), "settle (legacy-amount)");
    assert.equal(report.cost?.consumedMotes, 2_707_825_069n);
    assert.deepEqual(calls, ["info_get_transaction"]);
  });

  test("polls until the transaction executes, through lagging nodes and RPC errors", async () => {
    const clock = new FakeClock(1_000_000);
    const pending = { ...gx.hostedLegacySettleResult, execution_info: null };
    const answers: unknown[] = [
      rpcError(-32014, "No such transaction"), // Version1: not yet known
      rpcError(-32014, "No such transaction"), // Deploy: neither
      new Error("socket hang up"),
      rpcResult(pending),
      rpcResult(gx.hostedLegacySettleResult),
    ];
    const variants: unknown[] = [];
    const rpc = createCasperRpc("http://node.test/rpc", {
      fetchImpl: replayFetch({
        info_get_transaction: (params: Record<string, unknown>) => {
          variants.push(Object.keys(params["transaction_hash"] as object)[0]);
          return answers.shift();
        },
      }),
    });
    const sleeps: number[] = [];
    const report = await readTransactionReport(rpc, hash, {
      now: clock.now,
      sleep: async ms => {
        sleeps.push(ms);
        clock.advance(ms);
      },
      pollMs: 1_000,
    });
    assert.equal(report.cost?.status, "success");
    assert.deepEqual(variants, ["Version1", "Deploy", "Version1", "Version1", "Version1"]);
    assert.deepEqual(sleeps, [1_000, 1_000, 1_000]);
  });

  test("falls back to a legacy deploy hash", async () => {
    const deployResult = { transaction: { Deploy: { session: { StoredContractByHash: { hash: "aa".repeat(32), entry_point: "record", args: [] } } } }, execution_info: gx.anchorRecordResult.execution_info };
    const rpc = createCasperRpc("http://node.test/rpc", {
      fetchImpl: replayFetch({
        info_get_transaction: (params: Record<string, unknown>) =>
          "Deploy" in (params["transaction_hash"] as object) ? rpcResult(deployResult) : rpcError(-32014, "No such transaction"),
      }),
    });
    const report = await readTransactionReport(rpc, "aa".repeat(32));
    assert.equal(report.kind.kind, "anchor");
    assert.equal(report.cost?.netMotes, 2_113_311_410n);
  });

  test("gives up at the deadline with the reason", async () => {
    const clock = new FakeClock(0);
    const rpc = createCasperRpc("http://node.test/rpc", { fetchImpl: replayFetch({ info_get_transaction: rpcError(-32014, "No such transaction") }) });
    const report = await readTransactionReport(rpc, hash, { now: clock.now, sleep: async ms => clock.advance(ms), deadlineMs: 10_000, pollMs: 3_000 });
    assert.equal(report.cost, undefined);
    assert.equal(report.note, "unknown to the node");
    assert.equal(clock.ms, 10_000);
    assert.throws(() => normalizeTransactionHash("xyz"), /64 hex/);
    await assert.rejects(readTransactionReport(rpc, "0x1234"), /64 hex/);
  });
});

describe("measured gas: report and suggestions", () => {
  const report = (fixture: { transaction: unknown; execution_info: unknown }, hash: string): TransactionReport => ({
    hash,
    kind: classifyTransaction(fixture.transaction),
    cost: parseTransactionCost(fixture.execution_info)!,
  });
  const settle = report(gx.hostedLegacySettleResult, gx.hostedLegacySettleResult.transaction.Version1.hash);
  const reverted = report(gx.hostedValueOnLegacyTokenResult, gx.hostedValueOnLegacyTokenResult.transaction.Version1.hash);
  const anchor = report(gx.anchorRecordResult, gx.anchorRecordResult.transaction.Version1.hash);
  const mainnet = report(gx.mainnetLegacySettleResult, gx.mainnetLegacySettleResult.transaction.Version1.hash);

  test("prints one aligned row per transaction and explains reverts and unknowns", () => {
    const lines = formatCostTable([
      { label: "settle (legacy-amount)", report: settle },
      { label: "anchor", report: anchor },
      { label: "settle (cep3009-value)", report: reverted },
      { label: "settle", report: { hash: "ab".repeat(32), kind: { kind: "settle" }, note: "not executed yet" } },
    ]);
    assert.match(lines[0]!, /^transaction\s+hash\s+status\s+limit\s+consumed\s+refund\s+net cost\s+\(CSPR\)$/);
    assert.match(lines[1]!, /^settle \(legacy-amount\)\s+2ffeb8c7…a8b3\s+success\s+6\.0000\s+2\.7078\s+2\.4691\s+3\.5309$/);
    assert.match(lines[2]!, /^anchor\s+70e4c416…5f92\s+success\s+5\.0000\s+1\.1511\s+2\.8867\s+2\.1133$/);
    assert.match(lines[3]!, /^settle \(cep3009-value\)\s+9fe35eed…94ec\s+failure\s+6\.0000\s+0\.0097\s+0\.0000\s+6\.0000$/);
    assert.match(lines[4]!, /^settle\s+abababab…abab\s+unknown\s+-\s+-\s+-\s+-$/);
    assert.ok(lines.includes("  settle (cep3009-value) 9fe35eed…94ec reverted: User error: 64658"));
    assert.ok(lines.includes("  settle abababab…abab: not executed yet"));
    const widths = new Set(lines.slice(1, 5).map(l => l.length));
    assert.equal(widths.size, 1, "rows are aligned");
  });

  test("suggests a limit per kind from successful transactions only, as measured", () => {
    const suggestions = gasSuggestions([settle, reverted, anchor, mainnet], defaultLimitFor);
    assert.deepEqual(suggestions, [
      {
        label: "settle (legacy-amount)",
        samples: 2,
        maxConsumedMotes: 2_707_825_069n,
        suggestedLimitMotes: 3_530_000_000n,
        currentLimitMotes: BigInt(DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE["legacy-amount"]),
      },
      {
        label: "anchor",
        samples: 1,
        maxConsumedMotes: 1_151_081_880n,
        suggestedLimitMotes: 1_500_000_000n, // not raised to 2.5 CSPR: that is a minimum balance, not a minimum limit
        currentLimitMotes: DEFAULT_ANCHOR_GAS_MOTES,
      },
    ]);
    assert.deepEqual(formatGasSuggestions(suggestions), [
      "settle (legacy-amount): max consumed 2.7078 CSPR over 2 transactions → suggested limit 3.53 CSPR (ceil(1.3 × max)); current limit 4.00 CSPR",
      "anchor: max consumed 1.1511 CSPR over 1 transaction → suggested limit 1.50 CSPR (ceil(1.3 × max)); current limit 2.50 CSPR",
      "note: Casper accepts a transaction only when its initiator (the fee payer) holds at least 2.5 CSPR " +
        "(chainspec baseline_motes_amount); that is a minimum balance, not a minimum gas limit",
    ]);
    assert.deepEqual(gasSuggestions([reverted]), []);
  });

  test("prints the minimum-balance note only next to a suggestion below 2.5 CSPR", () => {
    assert.equal(MIN_INITIATOR_BALANCE_MOTES, 2_500_000_000n);
    const lines = formatGasSuggestions(gasSuggestions([settle, mainnet]));
    assert.deepEqual(lines, ["settle (legacy-amount): max consumed 2.7078 CSPR over 2 transactions → suggested limit 3.53 CSPR (ceil(1.3 × max))"]);
    assert.deepEqual(formatGasSuggestions([]), []);
  });

  test("knows the default limits it compares against", () => {
    assert.equal(defaultLimitFor({ kind: "settle", style: "cep3009-value" }), 2_500_000_000n);
    assert.equal(defaultLimitFor({ kind: "settle", style: "legacy-amount" }), 4_000_000_000n);
    assert.equal(defaultLimitFor({ kind: "settle" }), undefined);
    assert.equal(defaultLimitFor({ kind: "wrap" }), undefined);
    assert.equal(defaultLimitFor({ kind: "anchor" }), DEFAULT_ANCHOR_GAS_MOTES);
  });
});

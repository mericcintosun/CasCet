import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCasperRpc } from "@cascet/gateway";
import * as gx from "./gas-fixtures.js";
import { settleReport } from "./settle-report.js";
import { FakeClock, replayFetch, rpcResult } from "./test-helpers.js";

const MAINNET_SETTLE = gx.mainnetLegacySettleResult.transaction.Version1.hash;

/** settle-report against a replayed node serving `chainspec`, with every RPC method it calls recorded. */
async function run(argv: string[], chainspec: string) {
  const calls: string[] = [];
  const lines: string[] = [];
  const urls: string[] = [];
  const clock = new FakeClock(0);
  const result = settleReport(
    argv,
    { CASCET_RPC_URL: "http://node.test/rpc" },
    {
      rpc: url => {
        urls.push(url);
        return createCasperRpc(url, {
          fetchImpl: replayFetch(
            { info_get_status: rpcResult({ chainspec_name: chainspec }), info_get_transaction: rpcResult(gx.mainnetLegacySettleResult) },
            calls,
          ),
        });
      },
      log: line => lines.push(line),
      read: { now: clock.now, sleep: async ms => clock.advance(ms) },
    },
  );
  return { result, calls, lines, urls };
}

describe("settle-report: the node serves the chain the report names", () => {
  test("a mainnet node read as testnet (the default) is refused before any transaction is read", async () => {
    const { result, calls, lines, urls } = await run([MAINNET_SETTLE], "casper");
    await assert.rejects(
      result,
      /^Error: http:\/\/node\.test\/rpc serves chain "casper", not casper-test: pass --network casper:casper for its transactions, or point CASCET_RPC_URL at a casper-test node$/,
    );
    assert.deepEqual(urls, ["http://node.test/rpc"], "CASCET_RPC_URL picks the node");
    assert.deepEqual(calls, ["info_get_status"]);
    assert.deepEqual(lines, [], "no report labelled casper-test with testnet links");
  });

  test("a testnet node read as mainnet is refused at once, not polled for 20 s per hash", async () => {
    const { result, calls } = await run(["--network", "casper:casper", MAINNET_SETTLE], "casper-test");
    await assert.rejects(result, /serves chain "casper-test", not casper: pass --network casper:casper-test for its transactions/);
    assert.deepEqual(calls, ["info_get_status"]);
  });

  test("a node of another chain names no flag", async () => {
    const { result } = await run([MAINNET_SETTLE], "casper-integration");
    await assert.rejects(result, /serves chain "casper-integration", not casper-test: point CASCET_RPC_URL at a casper-test node$/);
  });

  test("the right node: the report names its chain and links its explorer", async () => {
    const { result, calls, lines } = await run(["--network", "casper:casper", MAINNET_SETTLE], "casper");
    assert.equal(await result, 0);
    assert.deepEqual(calls, ["info_get_status", "info_get_transaction"]);
    assert.ok(lines.includes("\nGas of 1 transaction on casper (http://node.test/rpc)\n"));
    assert.ok(lines.includes(`  ${MAINNET_SETTLE}: https://cspr.live/transaction/${MAINNET_SETTLE}`));
    assert.ok(lines.some(l => l.startsWith("settle (legacy-amount): max consumed 2.6962 CSPR over 1 transaction")));
  });
});

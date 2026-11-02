import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCasperRpc } from "@cascet/gateway";
import { CEP18_TRANSFER_ARGS } from "./cep18-transfer.js";
import { hasEntryPoint, readTokenBalance, readTokenInfo } from "./token-info.js";
import { replayFetch, rpcError } from "./test-helpers.js";
import * as wx from "./wcspr-fixtures.js";

const routes = {
  [`query_global_state hash-${wx.WCSPR_PACKAGE_HASH}`]: wx.wcsprPackageResponse,
  [`query_global_state hash-${wx.WCSPR_CONTRACT_HASH}`]: wx.wcsprContractResponse,
  ...Object.fromEntries(Object.entries(wx.wcsprNamedKeyResponses).map(([uref, response]) => [`query_global_state ${uref}`, response])),
  [`query_global_state ${wx.wcsprHolder.dictionaryAddress}`]: wx.wcsprHolderBalanceResponse,
};

describe("token metadata (read-only)", () => {
  test("reads testnet Wrapped CSPR: newest contract, name, symbol, decimals, chain and style", async () => {
    const calls: string[] = [];
    const rpc = createCasperRpc("http://node.test/rpc", { fetchImpl: replayFetch(routes, calls) });
    const info = await readTokenInfo(rpc, `hash-${wx.WCSPR_PACKAGE_HASH.toUpperCase()}`);
    assert.equal(info.packageHash, wx.WCSPR_PACKAGE_HASH);
    assert.equal(info.contractHash, wx.WCSPR_CONTRACT_HASH, "contract version 8, the only enabled one");
    assert.equal(info.name, "Wrapped CSPR");
    assert.equal(info.symbol, "WCSPR");
    assert.equal(info.decimals, 9);
    assert.equal(info.chainName, "casper:casper-test");
    assert.equal(info.authorizationStyle, "cep3009-value");
    assert.match(info.balancesURef ?? "", /^uref-[0-9a-f]{64}-007$/);
    assert.ok(hasEntryPoint(info, "deposit", []), "payable deposit() without declared args");
    assert.ok(hasEntryPoint(info, "transfer", CEP18_TRANSFER_ARGS));
    assert.ok(hasEntryPoint(info, "withdraw", [["amount", "U256"]]));
    assert.equal(hasEntryPoint(info, "transfer", [["amount", "U256"], ["recipient", "Key"]]), false, "order matters");
    assert.equal(hasEntryPoint(info, "deposit", [["amount", "U512"]]), false);
    assert.equal(hasEntryPoint(info, "mint", []), false);
    assert.equal(calls.filter(c => c.startsWith("query_global_state")).length, 6, "package, contract and four named keys");
  });

  test("reads Odra CEP-18 balances: a recorded holder, and 0 for an account without an entry", async () => {
    const rpc = createCasperRpc("http://node.test/rpc", {
      fetchImpl: replayFetch({
        ...routes,
        query_global_state: rpcError(-32003, "Query failed", "value was not found in the global state"),
      }),
    });
    const info = await readTokenInfo(rpc, wx.WCSPR_PACKAGE_HASH);
    assert.equal(await readTokenBalance(rpc, info, wx.wcsprHolder.accountHash), 88_000_000_000n);
    assert.equal(await readTokenBalance(rpc, info, `00${"11".repeat(32)}`), 0n);
    await assert.rejects(readTokenBalance(rpc, { packageHash: "aa".repeat(32) }, wx.wcsprHolder.accountHash), /no `balances` dictionary/);
  });

  test("refuses a malformed hash and a key that is not a contract package", async () => {
    const rpc = createCasperRpc("http://node.test/rpc", {
      fetchImpl: replayFetch({ query_global_state: { jsonrpc: "2.0", id: 1, result: { stored_value: { Account: {} } } } }),
    });
    await assert.rejects(readTokenInfo(rpc, "nothex"), /64 hex/);
    await assert.rejects(readTokenInfo(rpc, "ab".repeat(32)), /is not a contract package/);
  });
});

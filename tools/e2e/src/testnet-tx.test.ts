import assert from "node:assert/strict";
import { describe, test } from "node:test";
import casperSdk from "casper-js-sdk";
import { createCasperRpc, type CasperRpc } from "@cascet/gateway";
import { mainnetDeployerAccountResponse } from "./rpc-fixtures.js";
import {
  assertTestnetNode,
  assertTestnetSelection,
  flagValue,
  gasLimitFromFlag,
  parseCli,
  readAccountNamedKeys,
  readCsprBalance,
  submitTransaction,
  TESTNET_CHAIN_NAME,
  testnetRpcUrl,
  UsageError,
} from "./testnet-tx.js";
import { replayFetch, rpcError, rpcResult } from "./test-helpers.js";

const { ContractCallBuilder, PrivateKey, KeyAlgorithm, Args } = casperSdk;
const CSPR = 1_000_000_000n;

describe("maintainer CLI: arguments", () => {
  const spec = { booleans: ["send", "raw"], values: ["gas-cspr", "key"] };

  test("parses positionals, boolean flags and value flags in both spellings", () => {
    const cli = parseCli(["5", "--send", "--gas-cspr", "7.5", "--key=/k.pem", "x"], spec);
    assert.deepEqual(cli.positionals, ["5", "x"]);
    assert.equal(cli.flags.get("send"), true);
    assert.equal(flagValue(cli, "gas-cspr"), "7.5");
    assert.equal(flagValue(cli, "key"), "/k.pem");
    assert.equal(flagValue(cli, "send"), undefined, "a boolean flag has no value");
    assert.deepEqual(parseCli(["5", "--", "--send"], spec).positionals, ["5", "--send"], "-- ends the flags");
    assert.equal(parseCli(["--", "5", "--send"], spec).flags.get("send"), true, "a leading -- (pnpm passes it through) is dropped");
    assert.deepEqual(parseCli(["-1"], spec).positionals, ["-1"]);
  });

  test("refuses unknown, repeated, valueless and over-valued flags", () => {
    assert.throws(() => parseCli(["--sned"], spec), UsageError);
    assert.throws(() => parseCli(["--send", "--send"], spec), /given twice/);
    assert.throws(() => parseCli(["--gas-cspr"], spec), /needs a value/);
    assert.throws(() => parseCli(["--gas-cspr", "--send"], spec), /needs a value/);
    assert.throws(() => parseCli(["--gas-cspr="], spec), /needs a value/);
    assert.throws(() => parseCli(["--send=yes"], spec), /takes no value/);
  });

  test("gas limits come from --gas-cspr in CSPR, within bounds", () => {
    assert.equal(gasLimitFromFlag(undefined, 10n * CSPR, 2n * CSPR, 100n * CSPR), 10n * CSPR);
    assert.equal(gasLimitFromFlag("2.5", 10n * CSPR, 2n * CSPR, 100n * CSPR), 2_500_000_000n);
    assert.throws(() => gasLimitFromFlag("1", 10n * CSPR, 2n * CSPR, 100n * CSPR), /between 2 and 100 CSPR/);
    assert.throws(() => gasLimitFromFlag("101", 10n * CSPR, 2n * CSPR, 100n * CSPR), UsageError);
    assert.throws(() => gasLimitFromFlag("1e3", 10n * CSPR, 2n * CSPR, 100n * CSPR), UsageError);
  });
});

describe("maintainer CLI: testnet only", () => {
  test("refuses any mainnet selection", () => {
    assert.doesNotThrow(() => assertTestnetSelection({}));
    assert.doesNotThrow(() => assertTestnetSelection({ CASCET_NETWORK: "casper:casper-test", CASCET_NET: "testnet" }, "casper:casper-test"));
    assert.throws(() => assertTestnetSelection({ CASCET_NETWORK: "casper:casper" }), /refuses mainnet/);
    assert.throws(() => assertTestnetSelection({ CASCET_NET: "mainnet" }), /refuses mainnet/);
    assert.throws(() => assertTestnetSelection({}, "casper:casper"), /--network=casper:casper/);
  });

  test("picks CASCET_RPC_URL or the public testnet node", () => {
    assert.equal(testnetRpcUrl({}), "https://node.testnet.casper.network/rpc");
    assert.equal(testnetRpcUrl({ CASCET_RPC_URL: " http://127.0.0.1:7777/rpc " }), "http://127.0.0.1:7777/rpc");
    assert.throws(() => testnetRpcUrl({ CASCET_RPC_URL: "ftp://node/rpc" }), /http\(s\) URL/);
    assert.throws(() => testnetRpcUrl({ CASCET_RPC_URL: "not a url" }), /http\(s\) URL/);
  });

  test("checks that the node serves casper-test before anything is signed", async () => {
    const node = (chainspec: string) =>
      createCasperRpc("http://node.test/rpc", { fetchImpl: replayFetch({ info_get_status: rpcResult({ chainspec_name: chainspec }) }) });
    await assertTestnetNode(node("casper-test"));
    await assert.rejects(assertTestnetNode(node("casper")), /serves chain "casper", not casper-test/);
    assert.equal(TESTNET_CHAIN_NAME, "casper-test");
  });
});

describe("maintainer CLI: read-only account reads", () => {
  const account = "b9a38c827771d6bc510dd5f1e24fee61acdd4f97f758f4d68fe1dea13a7a140d";

  test("reads the CSPR balance of an account's main purse", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const rpc = createCasperRpc("http://node.test/rpc", {
      fetchImpl: replayFetch({
        query_balance: (params: Record<string, unknown>) => {
          seen.push(params);
          return rpcResult({ api_version: "2.0.0", balance: "2145235542" });
        },
      }),
    });
    assert.equal(await readCsprBalance(rpc, account), 2_145_235_542n);
    assert.deepEqual(seen, [{ purse_identifier: { main_purse_under_account_hash: `account-hash-${account}` } }]);
    const broken = createCasperRpc("http://node.test/rpc", { fetchImpl: replayFetch({ query_balance: rpcResult({}) }) });
    await assert.rejects(readCsprBalance(broken, account), /no balance/);
  });

  test("lists an account's named keys, or undefined when it does not exist", async () => {
    const rpc = createCasperRpc("http://node.test/rpc", {
      fetchImpl: replayFetch({ [`query_global_state account-hash-${account}`]: mainnetDeployerAccountResponse }),
    });
    assert.deepEqual(await readAccountNamedKeys(rpc, account), ["CasCet_X402_package_hash"]);
    const missing = createCasperRpc("http://node.test/rpc", {
      fetchImpl: replayFetch({ query_global_state: rpcError(-32003, "Query failed", "value was not found in the global state") }),
    });
    assert.equal(await readAccountNamedKeys(missing, account), undefined);
  });
});

describe("maintainer CLI: submission", () => {
  const key = PrivateKey.generate(KeyAlgorithm.ED25519); // throwaway, in memory only
  const tx = new ContractCallBuilder()
    .from(key.publicKey)
    .byPackageHash("cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3")
    .entryPoint("transfer")
    .runtimeArgs(Args.fromMap({}))
    .chainName("casper-test")
    .payment(5_000_000_000)
    .build();
  tx.sign(key);
  const failing = (err: Error): CasperRpc => ({ url: "http://node.test/rpc", call: async () => Promise.reject(err) });

  test("an accepted transaction keeps its hash", async () => {
    const methods: string[] = [];
    const rpc = createCasperRpc("http://node.test/rpc", {
      fetchImpl: replayFetch({ account_put_transaction: rpcResult({ transaction_hash: { Version1: tx.hash.toHex() } }) }, methods),
    });
    assert.deepEqual(await submitTransaction(rpc, tx), { kind: "accepted", hash: tx.hash.toHex() });
    assert.deepEqual(methods, ["account_put_transaction"]);
  });

  test("a definite rejection submitted nothing; anything else is unknown", async () => {
    const rejected = createCasperRpc("http://node.test/rpc", { fetchImpl: replayFetch({ account_put_transaction: rpcError(-32016, "Invalid transaction") }) });
    const outcome = await submitTransaction(rejected, tx);
    assert.equal(outcome.kind, "rejected");
    const unknown = await submitTransaction(failing(new Error("socket hang up")), tx);
    assert.deepEqual(unknown, { kind: "unknown", hash: tx.hash.toHex(), error: "socket hang up" });
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCasperRpc } from "./casper-rpc.js";
import * as fx from "./rpc-fixtures.js";
import { FakeClock, replayFetch, rpcError } from "./test-helpers.js";
import {
  accountKeyBytes,
  balanceItemKey,
  dictionaryAddress,
  latestContractHash,
  parseU256,
  TokenStateError,
  TokenStateReader,
  usedNonceItemKey,
} from "./token-state.js";

const TESTNET_TOKEN = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
const TESTNET_CONTRACT = "36e657e60199d91d9ace288e573ada1d4c1ab58b1ec6bcd31ae2c0dc62531bd8";
const MAINNET_TOKEN = "8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41";
const MAINNET_CONTRACT = "b424e9c999a962574ad057dea0a6b8ae5c3398ee12f16b829e1bdaf6f13f58a0";
/** Payer of both settled transactions (testnet 04e54a95…, mainnet 2c66141c…). */
const PAYER = "0065190126b1ca282f041fad6b74b845a3c48e0c8411392b13c640a16a1438faf9";
const TESTNET_NONCE = "9c58f1e5a21d9fd85dc46828cee8828e1726da30c2ece9421c3098c281ea5ee2";
const MAINNET_NONCE = fx.mainnetSettledArgs.nonce.slice(8); // drop the List<U8> length prefix

const namedKey = (resp: { result: { stored_value: { Contract: { named_keys: readonly { name: string; key: string }[] } } } }, name: string) =>
  resp.result.stored_value.Contract.named_keys.find(k => k.name === name)!.key;

/** Decode a dictionary entry written to global state: (CLValue, seed URef addr, item key). */
function decodeDictionaryValue(hex: string) {
  const b = Buffer.from(hex, "hex");
  let o = 0;
  const u32 = () => {
    const v = b.readUInt32LE(o);
    o += 4;
    return v;
  };
  const valueLen = u32();
  const value = b.subarray(o, o + valueLen).toString("hex");
  o += valueLen;
  const clTypeTag = b[o++];
  const seedLen = u32();
  const seed = b.subarray(o, o + seedLen).toString("hex");
  o += seedLen;
  const keyLen = u32();
  const itemKey = b.subarray(o, o + keyLen).toString("utf8");
  return { value, clTypeTag, seed, itemKey };
}

describe("item-key derivation matches what settled transactions wrote on-chain", () => {
  test("used_nonces: hex(blake2b256(Key bytes ‖ Vec<u8> nonce)) — testnet tx 04e54a95", () => {
    const write = decodeDictionaryValue(fx.testnetSettledTransaction.usedNonceWrite.kind.Write.CLValue.bytes);
    const seedURef = namedKey(fx.testnetContractResponse, "used_nonces");
    assert.equal(write.value, "01"); // Bool true
    assert.equal(write.clTypeTag, 0); // CLType::Bool
    assert.equal(`uref-${write.seed}-007`, seedURef);
    assert.equal(usedNonceItemKey(PAYER, TESTNET_NONCE), write.itemKey);
    assert.equal(dictionaryAddress(seedURef, write.itemKey), fx.testnetSettledTransaction.usedNonceWrite.key);
  });

  test("balances: base64(Key bytes) — testnet tx 04e54a95", () => {
    const write = decodeDictionaryValue(fx.testnetSettledTransaction.balanceWrite.kind.Write.CLValue.bytes);
    const seedURef = namedKey(fx.testnetContractResponse, "balances");
    assert.equal(write.clTypeTag, 7); // CLType::U256
    assert.equal(`uref-${write.seed}-007`, seedURef);
    assert.equal(balanceItemKey(PAYER), write.itemKey);
    assert.equal(dictionaryAddress(seedURef, write.itemKey), fx.testnetSettledTransaction.balanceWrite.key);
  });

  test("account key bytes accept 00-tagged, account-hash- and bare forms", () => {
    const bare = PAYER.slice(2);
    const expected = Buffer.from(`00${bare}`, "hex");
    for (const form of [PAYER, `account-hash-${bare}`, bare, bare.toUpperCase()]) {
      assert.deepEqual(Buffer.from(accountKeyBytes(form)), expected);
    }
    assert.throws(() => accountKeyBytes(`01${bare}`), TokenStateError);
    assert.throws(() => usedNonceItemKey(PAYER, "abcd"), TokenStateError);
    assert.equal(usedNonceItemKey(PAYER, `0x${TESTNET_NONCE.toUpperCase()}`), usedNonceItemKey(PAYER, TESTNET_NONCE));
  });
});

function testnetReader(extra: Record<string, unknown> = {}, calls: string[] = [], clock = new FakeClock(0)) {
  const usedSeed = namedKey(fx.testnetContractResponse, "used_nonces");
  const balSeed = namedKey(fx.testnetContractResponse, "balances");
  const routes: Record<string, unknown> = {
    [`query_global_state hash-${TESTNET_TOKEN}`]: fx.testnetPackageResponse,
    [`query_global_state hash-${TESTNET_CONTRACT}`]: fx.testnetContractResponse,
    [`query_global_state ${dictionaryAddress(usedSeed, usedNonceItemKey(PAYER, TESTNET_NONCE))}`]: fx.testnetUsedNonceResponse,
    [`query_global_state ${dictionaryAddress(balSeed, balanceItemKey(PAYER))}`]: fx.testnetBalanceResponse,
    [`query_global_state ${namedKey(fx.testnetContractResponse, "name")}`]: fx.testnetNameResponse,
    ...extra,
  };
  const rpc = createCasperRpc("http://rpc.invalid", { fetchImpl: replayFetch(routes, calls) });
  return new TokenStateReader(rpc, { now: clock.now, cacheTtlMs: 60_000 });
}

describe("TokenStateReader (recorded RPC fixtures)", () => {
  test("reads the testnet payer's balance, a used nonce and the token name", async () => {
    const reader = testnetReader();
    assert.equal(await reader.balanceOf(TESTNET_TOKEN, PAYER), 99_984_500_000_000n);
    assert.equal(await reader.isNonceUsed(`hash-${TESTNET_TOKEN}`, PAYER, TESTNET_NONCE), true);
    assert.equal(await reader.tokenName(TESTNET_TOKEN), "CasCet X402 Token");
  });

  test("the node's explicit not-found means unused nonce / zero balance", async () => {
    const fresh = "11".repeat(32);
    const stranger = `00${"22".repeat(32)}`;
    const usedSeed = namedKey(fx.testnetContractResponse, "used_nonces");
    const balSeed = namedKey(fx.testnetContractResponse, "balances");
    const reader = testnetReader({
      [`query_global_state ${dictionaryAddress(usedSeed, usedNonceItemKey(PAYER, fresh))}`]: fx.testnetUnusedNonceResponse,
      [`query_global_state ${dictionaryAddress(balSeed, balanceItemKey(stranger))}`]: fx.testnetUnusedNonceResponse,
    });
    assert.equal(await reader.isNonceUsed(TESTNET_TOKEN, PAYER, fresh), false);
    assert.equal(await reader.balanceOf(TESTNET_TOKEN, stranger), 0n);
  });

  test("mainnet: the nonce of settled tx 2c66141c reads back as used", async () => {
    const usedSeed = namedKey(fx.mainnetContractResponse, "used_nonces");
    const rpc = createCasperRpc("http://rpc.invalid", {
      fetchImpl: replayFetch({
        [`query_global_state hash-${MAINNET_TOKEN}`]: fx.mainnetPackageResponse,
        [`query_global_state hash-${MAINNET_CONTRACT}`]: fx.mainnetContractResponse,
        [`query_global_state ${dictionaryAddress(usedSeed, usedNonceItemKey(fx.mainnetSettledArgs.from, MAINNET_NONCE))}`]:
          fx.mainnetUsedNonceResponse,
      }),
    });
    const reader = new TokenStateReader(rpc);
    assert.equal(await reader.isNonceUsed(MAINNET_TOKEN, fx.mainnetSettledArgs.from, MAINNET_NONCE), true);
    // The derived address is the one recorded from the live node.
    assert.equal(
      dictionaryAddress(usedSeed, usedNonceItemKey(fx.mainnetSettledArgs.from, MAINNET_NONCE)),
      "dictionary-1f2e9080357ece1c0db209dda929581fc7768d642029c8e966c071b93a5327ff",
    );
  });

  test("any other RPC failure is indeterminate and throws TokenStateError", async () => {
    const usedSeed = namedKey(fx.testnetContractResponse, "used_nonces");
    const addr = dictionaryAddress(usedSeed, usedNonceItemKey(PAYER, TESTNET_NONCE));
    for (const failure of [
      rpcError(-32003, "Query failed", "state root hash not available"),
      rpcError(-32018, "Node request failure"),
      new Error("ECONNRESET"),
    ]) {
      const reader = testnetReader({ [`query_global_state ${addr}`]: failure });
      await assert.rejects(reader.isNonceUsed(TESTNET_TOKEN, PAYER, TESTNET_NONCE), TokenStateError);
    }
  });

  test("an unexpected value type is rejected rather than guessed", async () => {
    const balSeed = namedKey(fx.testnetContractResponse, "balances");
    const reader = testnetReader({
      [`query_global_state ${dictionaryAddress(balSeed, balanceItemKey(PAYER))}`]: fx.testnetUsedNonceResponse, // a Bool
    });
    await assert.rejects(reader.balanceOf(TESTNET_TOKEN, PAYER), /expected U256/);
  });

  test("a token without used_nonces (not CEP-3009) cannot be preflighted", async () => {
    const contract = structuredClone(fx.testnetContractResponse) as unknown as {
      result: { stored_value: { Contract: { named_keys: { name: string; key: string }[] } } };
    };
    contract.result.stored_value.Contract.named_keys = contract.result.stored_value.Contract.named_keys.filter(k => k.name !== "used_nonces");
    const reader = testnetReader({ [`query_global_state hash-${TESTNET_CONTRACT}`]: contract });
    await assert.rejects(reader.isNonceUsed(TESTNET_TOKEN, PAYER, TESTNET_NONCE), /used_nonces/);
  });

  test("caches the resolved contract and refreshes it after the TTL", async () => {
    const calls: string[] = [];
    const clock = new FakeClock(0);
    const reader = testnetReader({}, calls, clock);
    await reader.balanceOf(TESTNET_TOKEN, PAYER);
    await reader.isNonceUsed(TESTNET_TOKEN, PAYER, TESTNET_NONCE);
    assert.equal(calls.filter(c => c.endsWith(TESTNET_TOKEN)).length, 1);
    clock.advance(60_001);
    await reader.balanceOf(TESTNET_TOKEN, PAYER);
    assert.equal(calls.filter(c => c.endsWith(TESTNET_TOKEN)).length, 2);
  });
});

describe("value parsing", () => {
  test("latestContractHash picks the newest enabled version", () => {
    const hash = (n: number) => `contract-${String(n).repeat(64).slice(0, 64)}`;
    assert.equal(
      latestContractHash({
        versions: [
          { protocol_version_major: 2, contract_version: 1, contract_hash: hash(1) },
          { protocol_version_major: 2, contract_version: 3, contract_hash: hash(3) },
          { protocol_version_major: 2, contract_version: 2, contract_hash: hash(2) },
        ],
        disabled_versions: [{ protocol_version_major: 2, contract_version: 3 }],
      }),
      "2".repeat(64),
    );
    assert.throws(() => latestContractHash({ versions: [] }), TokenStateError);
  });

  test("parseU256 falls back to the CLValue bytes", () => {
    assert.equal(parseU256({ stored_value: { CLValue: { cl_type: "U256", bytes: "0600059b74ef5a" } } }, "x"), 99_984_500_000_000n);
    assert.equal(parseU256({ stored_value: { CLValue: { cl_type: "U256", bytes: "00" } } }, "x"), 0n);
    assert.throws(() => parseU256({ stored_value: { CLValue: { cl_type: "U256", bytes: "0600" } } }, "x"), TokenStateError);
  });
});

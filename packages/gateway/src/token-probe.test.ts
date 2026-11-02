import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dictionaryKeyForAddress } from "@x402/casper";
import { createCasperRpc, RpcNodeError, RpcTransportError, type CasperRpc, type RpcCallOptions } from "./casper-rpc.js";
import * as fx from "./testing/rpc-fixtures.js";
import { FakeClock, replayFetch, rpcError } from "./testing/rpc-replay.js";
import {
  accountKeyBytes,
  authorizationStyleOf,
  balanceItemKey,
  classifyTokenRpcError,
  dictionaryAddress,
  latestContractHash,
  MIN_RETRY_BUDGET_MS,
  parseU256,
  RPC_NODE_REQUEST_FAILED,
  TokenProbe,
  TokenStateError,
  TokenUnsupportedError,
  usedNonceItemKey,
  type EntryPointJson,
} from "./token-probe.js";

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
    const write = decodeDictionaryValue(fx.testnetSettledWrites.usedNonceWrite.kind.Write.CLValue.bytes);
    const seedURef = namedKey(fx.testnetContractResponse, "used_nonces");
    assert.equal(write.value, "01"); // Bool true
    assert.equal(write.clTypeTag, 0); // CLType::Bool
    assert.equal(`uref-${write.seed}-007`, seedURef);
    assert.equal(usedNonceItemKey(PAYER, TESTNET_NONCE), write.itemKey);
    assert.equal(dictionaryAddress(seedURef, write.itemKey), fx.testnetSettledWrites.usedNonceWrite.key);
  });

  test("balances: base64(Key bytes) — testnet tx 04e54a95", () => {
    const write = decodeDictionaryValue(fx.testnetSettledWrites.balanceWrite.kind.Write.CLValue.bytes);
    const seedURef = namedKey(fx.testnetContractResponse, "balances");
    assert.equal(write.clTypeTag, 7); // CLType::U256
    assert.equal(`uref-${write.seed}-007`, seedURef);
    assert.equal(balanceItemKey(PAYER), write.itemKey);
    assert.equal(dictionaryAddress(seedURef, write.itemKey), fx.testnetSettledWrites.balanceWrite.key);
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
  return new TokenProbe(rpc, { now: clock.now, cacheTtlMs: 60_000 });
}

/**
 * An indeterminate failure: a TokenStateError but not a TokenUnsupportedError. That subclass is a final
 * verdict (unsupported_asset), while an indeterminate read must end in preflight_unavailable (retry later).
 */
function indeterminate(err: unknown): true {
  assert.ok(err instanceof TokenStateError, `expected a TokenStateError, got ${String(err)}`);
  assert.ok(!(err instanceof TokenUnsupportedError), `classified as unsupported: ${err.message}`);
  return true;
}

describe("TokenProbe (recorded RPC fixtures)", () => {
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
    const reader = new TokenProbe(rpc);
    assert.equal(await reader.isNonceUsed(MAINNET_TOKEN, fx.mainnetSettledArgs.from, MAINNET_NONCE), true);
    // The derived address is the one recorded from the live node.
    assert.equal(
      dictionaryAddress(usedSeed, usedNonceItemKey(fx.mainnetSettledArgs.from, MAINNET_NONCE)),
      "dictionary-1f2e9080357ece1c0db209dda929581fc7768d642029c8e966c071b93a5327ff",
    );
  });

  test("any other RPC failure is indeterminate: a TokenStateError, never TokenUnsupportedError", async () => {
    const usedSeed = namedKey(fx.testnetContractResponse, "used_nonces");
    const addr = dictionaryAddress(usedSeed, usedNonceItemKey(PAYER, TESTNET_NONCE));
    for (const failure of [
      rpcError(-32003, "Query failed", "state root hash not available"),
      rpcError(-32018, "Node request failure"),
      new Error("ECONNRESET"),
    ]) {
      const reader = testnetReader({ [`query_global_state ${addr}`]: failure });
      await assert.rejects(reader.isNonceUsed(TESTNET_TOKEN, PAYER, TESTNET_NONCE), indeterminate);
    }
  });

  test("one transport failure is retried (idempotent read); a second one is indeterminate", async () => {
    const usedSeed = namedKey(fx.testnetContractResponse, "used_nonces");
    const addr = dictionaryAddress(usedSeed, usedNonceItemKey(PAYER, TESTNET_NONCE));
    let attempts = 0;
    const flaky = () => (++attempts === 1 ? new Error("socket hang up") : fx.testnetUsedNonceResponse);
    assert.equal(await testnetReader({ [`query_global_state ${addr}`]: flaky }).isNonceUsed(TESTNET_TOKEN, PAYER, TESTNET_NONCE), true);
    assert.equal(attempts, 2);

    const calls: string[] = [];
    const down = testnetReader({ [`query_global_state ${addr}`]: new Error("ECONNREFUSED") }, calls);
    await assert.rejects(down.isNonceUsed(TESTNET_TOKEN, PAYER, TESTNET_NONCE), indeterminate);
    assert.equal(calls.filter(c => c.endsWith(addr)).length, 2, "exactly one retry");

    // An answer from the node (here: a JSON-RPC error) is final and not retried.
    const answered: string[] = [];
    const failing = testnetReader({ [`query_global_state ${addr}`]: rpcError(-32003, "Query failed", "state root hash not available") }, answered);
    await assert.rejects(failing.isNonceUsed(TESTNET_TOKEN, PAYER, TESTNET_NONCE), indeterminate);
    assert.equal(answered.filter(c => c.endsWith(addr)).length, 1);
  });

  test("an answer without a stored value is indeterminate, never an unused nonce or a zero balance", async () => {
    const nonceRead = `query_global_state ${dictionaryAddress(namedKey(fx.testnetContractResponse, "used_nonces"), usedNonceItemKey(PAYER, TESTNET_NONCE))}`;
    const balanceRead = `query_global_state ${dictionaryAddress(namedKey(fx.testnetContractResponse, "balances"), balanceItemKey(PAYER))}`;
    // A broken node or proxy answering `result` null (or another falsy value) for the used nonce and the funded balance.
    for (const result of [null, false, 0, "", {}, { stored_value: null }]) {
      const answer = { jsonrpc: "2.0", id: 1, result };
      const reader = testnetReader({ [nonceRead]: answer, [balanceRead]: answer });
      await assert.rejects(reader.isNonceUsed(TESTNET_TOKEN, PAYER, TESTNET_NONCE), TokenStateError, `nonce read as ${JSON.stringify(result)}`);
      await assert.rejects(reader.balanceOf(TESTNET_TOKEN, PAYER), TokenStateError, `balance read as ${JSON.stringify(result)}`);
    }
    // A value that must exist (the token package) fails the same way: indeterminate, not an unsupported token.
    for (const result of [null, {}]) {
      const reader = testnetReader({ [`query_global_state hash-${TESTNET_TOKEN}`]: { jsonrpc: "2.0", id: 1, result } });
      await assert.rejects(reader.balanceOf(TESTNET_TOKEN, PAYER), (err: unknown) => {
        assert.ok(err instanceof TokenStateError && !(err instanceof TokenUnsupportedError), `package read as ${JSON.stringify(result)}: ${String(err)}`);
        assert.match((err as Error).message, /token package: the node's answer carries no stored value/);
        return true;
      });
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

/**
 * A CasperRpc stand-in on a fake clock: answers from the recorded fixtures,
 * records each call's timeout, and can make chosen keys slow or failing.
 */
function clockedRpc(clock: FakeClock, behave: (key: string, attempt: number) => { delayMs?: number; fail?: boolean } = () => ({})) {
  const usedSeed = namedKey(fx.testnetContractResponse, "used_nonces");
  const balSeed = namedKey(fx.testnetContractResponse, "balances");
  const answers: Record<string, unknown> = {
    [`hash-${TESTNET_TOKEN}`]: fx.testnetPackageResponse,
    [`hash-${TESTNET_CONTRACT}`]: fx.testnetContractResponse,
    [dictionaryAddress(usedSeed, usedNonceItemKey(PAYER, TESTNET_NONCE))]: fx.testnetUsedNonceResponse,
    [dictionaryAddress(balSeed, balanceItemKey(PAYER))]: fx.testnetBalanceResponse,
    [namedKey(fx.testnetContractResponse, "name")]: fx.testnetNameResponse,
  };
  const calls: Array<{ key: string; timeoutMs?: number }> = [];
  const attempts = new Map<string, number>();
  const rpc: CasperRpc = {
    url: "http://rpc.invalid",
    async call<T>(_method: string, params: unknown, opts?: RpcCallOptions): Promise<T> {
      const key = (params as { key: string }).key;
      calls.push({ key, ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
      const n = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, n);
      const b = behave(key, n);
      clock.advance(b.delayMs ?? 0);
      if (b.fail) throw new RpcTransportError("query_global_state", "timeout", "slow node");
      const answer = answers[key] as { result?: T } | undefined;
      if (!answer?.result) throw new Error(`unexpected key ${key}`);
      return answer.result;
    },
  };
  return { rpc, calls };
}

describe("TokenProbe deadline (one budget per preflight)", () => {
  const nonceAddr = () => dictionaryAddress(namedKey(fx.testnetContractResponse, "used_nonces"), usedNonceItemKey(PAYER, TESTNET_NONCE));

  test("each call's timeout is cut to what is left of the deadline", async () => {
    const clock = new FakeClock(1_000_000);
    const { rpc, calls } = clockedRpc(clock, () => ({ delayMs: 1_000 }));
    const reader = new TokenProbe(rpc, { now: clock.now });
    assert.equal(await reader.isNonceUsed(TESTNET_TOKEN, PAYER, TESTNET_NONCE, { deadlineMs: 1_000_000 + 10_000 }), true);
    // package, contract, item: 1 s each, so 10 s, 9 s and 8 s were left.
    assert.deepEqual(calls.map(c => c.timeoutMs), [10_000, 9_000, 8_000]);
  });

  test("a spent budget fails fast, without calling the node and without a retry", async () => {
    const clock = new FakeClock(1_000_000);
    const { rpc, calls } = clockedRpc(clock, key => (key === nonceAddr() ? { delayMs: 9_700, fail: true } : {}));
    const reader = new TokenProbe(rpc, { now: clock.now });
    await assert.rejects(reader.isNonceUsed(TESTNET_TOKEN, PAYER, TESTNET_NONCE, { deadlineMs: 1_000_000 + 10_000 }), indeterminate);
    assert.equal(calls.filter(c => c.key === nonceAddr()).length, 1, `no retry with less than ${MIN_RETRY_BUDGET_MS} ms left`);

    const late = clockedRpc(clock);
    const reader2 = new TokenProbe(late.rpc, { now: clock.now });
    await assert.rejects(reader2.balanceOf(TESTNET_TOKEN, PAYER, { deadlineMs: clock.now() }), /deadline exceeded/);
    assert.equal(late.calls.length, 0);
  });

  test("a failed read is retried when the budget allows it", async () => {
    const clock = new FakeClock(1_000_000);
    const { rpc, calls } = clockedRpc(clock, (key, n) => (key === nonceAddr() && n === 1 ? { delayMs: 3_000, fail: true } : {}));
    const reader = new TokenProbe(rpc, { now: clock.now });
    assert.equal(await reader.isNonceUsed(TESTNET_TOKEN, PAYER, TESTNET_NONCE, { deadlineMs: 1_000_000 + 10_000 }), true);
    assert.deepEqual(
      calls.filter(c => c.key === nonceAddr()).map(c => c.timeoutMs),
      [10_000, 7_000],
      "the retry only gets what is left",
    );
  });

  test("concurrent reads on a cold cache share one package and contract lookup", async () => {
    const clock = new FakeClock(1_000_000);
    const { rpc, calls } = clockedRpc(clock);
    const reader = new TokenProbe(rpc, { now: clock.now });
    await Promise.all([
      reader.isNonceUsed(TESTNET_TOKEN, PAYER, TESTNET_NONCE),
      reader.balanceOf(TESTNET_TOKEN, PAYER),
      reader.tokenName(TESTNET_TOKEN),
    ]);
    assert.equal(calls.filter(c => c.key === `hash-${TESTNET_TOKEN}`).length, 1);
    assert.equal(calls.filter(c => c.key === `hash-${TESTNET_CONTRACT}`).length, 1);
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

  test("latestContractHash reads disabled versions in the node's [major, version] form", () => {
    // Testnet Wrapped CSPR: versions 1-7 disabled, version 8 active.
    assert.equal(latestContractHash(fx.wcsprTestnetPackageResponse.result.stored_value.ContractPackage), WCSPR_CONTRACT);
    // A disabled newest version must never be picked (a token rolled back to an older version).
    const hash = (n: number) => `contract-${String(n).repeat(64)}`;
    assert.equal(
      latestContractHash({
        versions: [
          { protocol_version_major: 2, contract_version: 1, contract_hash: hash(1) },
          { protocol_version_major: 2, contract_version: 2, contract_hash: hash(2) },
        ],
        disabled_versions: [[2, 2]],
      }),
      "1".repeat(64),
    );
    assert.throws(() => latestContractHash({ versions: [{ protocol_version_major: 2, contract_version: 1, contract_hash: hash(1) }], disabled_versions: [[2, 1]] }), TokenUnsupportedError);
  });
});

const WCSPR_TOKEN = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";
const WCSPR_CONTRACT = "032706aeae170fafb6403ce3bec58062f1c4288710838fe1df98ce4ff6c35f4a";

describe("migration test vectors (DESIGN section 8)", () => {
  test("used_nonces key of payer 6519… and nonce 9c58… is f5a5367e…, which the testnet token holds as used", () => {
    assert.equal(usedNonceItemKey(PAYER, TESTNET_NONCE), "f5a5367e5be368c79b69b9d5575d586dc7e181a5d8cc678848dd1e50d703c3d2");
    // The address the node itself derived for that item (state_get_dictionary_item dictionary_key).
    assert.equal(
      dictionaryAddress(namedKey(fx.testnetContractResponse, "used_nonces"), usedNonceItemKey(PAYER, TESTNET_NONCE)),
      "dictionary-277352b4a03fcca0ff1e5eb6e534de8db013216692287fb7b13a9372f60f05fc",
    );
  });

  test("balances key of payer 6519… is AGUZASaxyigvBB+ta3S4RaPEjgyEETkrE8ZAoWoUOPr5, as @x402/casper derives it", () => {
    assert.equal(balanceItemKey(PAYER), "AGUZASaxyigvBB+ta3S4RaPEjgyEETkrE8ZAoWoUOPr5");
    assert.equal(balanceItemKey(PAYER), dictionaryKeyForAddress(PAYER));
    assert.equal(
      dictionaryAddress(namedKey(fx.testnetContractResponse, "balances"), balanceItemKey(PAYER)),
      "dictionary-cd0755e184eb134c863b1a865098080f0c339b34fd832dd3c17a7bad86d59b42",
    );
  });

  test("never uses @x402/casper 2.29's used-nonce key, base64(Key ‖ nonce)", () => {
    const upstream = Buffer.concat([Buffer.from(PAYER, "hex"), Buffer.from(TESTNET_NONCE, "hex")]).toString("base64");
    assert.match(upstream, /^AGUZ.*qXuI=$/);
    assert.notEqual(usedNonceItemKey(PAYER, TESTNET_NONCE), upstream);
  });
});

describe("authorization style from the token ABI", () => {
  const entryPoints = (resp: { result: { stored_value: { Contract: { entry_points: readonly EntryPointJson[] } } } }) =>
    resp.result.stored_value.Contract.entry_points;
  const legacyArgs = entryPoints(fx.testnetContractResponse)[0]!.args!;

  test("amount means legacy-amount, value means cep3009-value (recorded testnet and mainnet ABIs)", () => {
    assert.equal(authorizationStyleOf(entryPoints(fx.testnetContractResponse)), "legacy-amount");
    assert.equal(authorizationStyleOf(entryPoints(fx.mainnetContractResponse)), "legacy-amount");
    assert.equal(authorizationStyleOf(entryPoints(fx.wcsprTestnetContractResponse)), "cep3009-value");
  });

  test("anything but the exact CEP-3009 argument set is unrecognized", () => {
    const withArgs = (args: NonNullable<EntryPointJson["args"]>): EntryPointJson[] => [{ name: "transfer_with_authorization", args }];
    assert.equal(authorizationStyleOf(undefined), undefined);
    assert.equal(authorizationStyleOf([{ name: "transfer", args: [] }]), undefined, "no transfer_with_authorization");
    assert.equal(authorizationStyleOf(withArgs(legacyArgs.filter(arg => arg.name !== "nonce"))), undefined, "an argument missing");
    assert.equal(authorizationStyleOf(withArgs([...legacyArgs, { name: "value", cl_type: "U256" }])), undefined, "both amount and value");
    assert.equal(
      authorizationStyleOf(withArgs(legacyArgs.map(arg => (arg.name === "amount" ? { name: "amount", cl_type: "U512" } : arg)))),
      undefined,
      "amount is not a U256",
    );
    assert.equal(
      authorizationStyleOf(withArgs(legacyArgs.map(arg => (arg.name === "nonce" ? { name: "nonce", cl_type: { ByteArray: 32 } } : arg)))),
      undefined,
      "another nonce type",
    );
    assert.equal(
      authorizationStyleOf(withArgs(legacyArgs.map(arg => (arg.name === "amount" ? { name: "amount_raw", cl_type: "U256" } : arg)))),
      undefined,
      "an unknown amount name",
    );
  });

  const probe = (routes: Record<string, unknown>, calls: string[] = []) =>
    new TokenProbe(createCasperRpc("http://rpc.invalid", { fetchImpl: replayFetch(routes, calls) }));

  const wcsprRoutes = {
    [`query_global_state hash-${WCSPR_TOKEN}`]: fx.wcsprTestnetPackageResponse,
    [`query_global_state hash-${WCSPR_CONTRACT}`]: fx.wcsprTestnetContractResponse,
    [`query_global_state ${namedKey(fx.wcsprTestnetContractResponse, "name")}`]: fx.wcsprTestnetNameResponse,
    [`query_global_state ${namedKey(fx.wcsprTestnetContractResponse, "chain_name")}`]: fx.wcsprTestnetChainNameResponse,
  };

  test("the probe reads Wrapped CSPR's style and EIP-712 domain from its active contract", async () => {
    const calls: string[] = [];
    const p = probe(wcsprRoutes, calls);
    assert.equal(await p.authorizationStyle(`hash-${WCSPR_TOKEN}`), "cep3009-value");
    assert.equal(await p.tokenName(WCSPR_TOKEN), "Wrapped CSPR");
    assert.equal(await p.chainName(WCSPR_TOKEN), "casper:casper-test");
    assert.equal((await p.resolve(WCSPR_TOKEN)).contractHash, WCSPR_CONTRACT, "version 8, not a disabled one");
    await p.chainName(WCSPR_TOKEN);
    assert.equal(calls.filter(c => c.endsWith(namedKey(fx.wcsprTestnetContractResponse, "chain_name"))).length, 1, "cached");
  });

  test("the probe reads CasCet's testnet token as legacy-amount on casper:casper-test", async () => {
    const p = probe({
      [`query_global_state hash-${TESTNET_TOKEN}`]: fx.testnetPackageResponse,
      [`query_global_state hash-${TESTNET_CONTRACT}`]: fx.testnetContractResponse,
      [`query_global_state ${namedKey(fx.testnetContractResponse, "chain_name")}`]: fx.testnetChainNameResponse,
    });
    assert.equal(await p.authorizationStyle(TESTNET_TOKEN), "legacy-amount");
    assert.equal(await p.chainName(TESTNET_TOKEN), "casper:casper-test");
  });

  test("a token whose ABI matches neither style is unsupported, while its balances stay readable", async () => {
    const contract = structuredClone(fx.wcsprTestnetContractResponse) as unknown as {
      result: { stored_value: { Contract: { entry_points: unknown[] } } };
    };
    contract.result.stored_value.Contract.entry_points = [];
    const p = probe({ ...wcsprRoutes, [`query_global_state hash-${WCSPR_CONTRACT}`]: contract, query_global_state: fx.testnetUnusedNonceResponse });
    await assert.rejects(p.authorizationStyle(WCSPR_TOKEN), TokenUnsupportedError);
    assert.equal(await p.balanceOf(WCSPR_TOKEN, PAYER), 0n);
  });
});

describe("RPC error mapping (-32003 absent, -32018 unsupported, anything else unavailable)", () => {
  const nodeError = (body: { error: { code: number; message: string; data?: string } }) =>
    new RpcNodeError("q", body.error.code, body.error.message, body.error.data);

  test("classifies recorded node answers", () => {
    assert.equal(classifyTokenRpcError(nodeError(fx.testnetUnusedNonceResponse)), "absent");
    assert.equal(classifyTokenRpcError(nodeError(fx.dictionaryURefNotFoundResponse)), "unsupported");
    assert.equal(classifyTokenRpcError(new RpcNodeError("q", RPC_NODE_REQUEST_FAILED, "Node request failure", "connection to node lost")), "unavailable");
    assert.equal(classifyTokenRpcError(new RpcNodeError("q", -32003, "Query failed", "state root hash not available")), "unavailable");
    assert.equal(classifyTokenRpcError(new RpcTransportError("q", "timeout", "t")), "unavailable");
    assert.equal(classifyTokenRpcError(new Error("boom")), "unavailable");
  });

  test("a missing dictionary fails closed as unsupported, never as an unused nonce", async () => {
    const usedSeed = namedKey(fx.testnetContractResponse, "used_nonces");
    const reader = testnetReader({ [`query_global_state ${dictionaryAddress(usedSeed, usedNonceItemKey(PAYER, TESTNET_NONCE))}`]: fx.dictionaryURefNotFoundResponse });
    await assert.rejects(reader.isNonceUsed(TESTNET_TOKEN, PAYER, TESTNET_NONCE), TokenUnsupportedError);
  });

  test("a token package the node does not know is unsupported", async () => {
    const reader = testnetReader({ [`query_global_state hash-${TESTNET_TOKEN}`]: fx.testnetUnusedNonceResponse });
    await assert.rejects(reader.balanceOf(TESTNET_TOKEN, PAYER), (err: unknown) => {
      assert.ok(err instanceof TokenUnsupportedError);
      assert.match((err as Error).message, /token package/);
      return true;
    });
  });
});

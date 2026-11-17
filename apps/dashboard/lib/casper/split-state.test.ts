import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addressKeyBytes,
  cep18BalanceKey,
  decodeAddress,
  decodeU256,
  decodeU32,
  odraStateKey,
  odraValueBytes,
  readSplitState,
  releasableOf,
  SplitReadError,
} from "./split-state";

// Testnet RevenueSplit and its DemoToken (lib/economy.ts), and the two payees (lib/casper/constants.ts).
const SPLIT_PKG = "fa21efb406a8151d15a393bc366e51192a9ea15fd7fe23faffc54f021b32883c";
const TOKEN_PKG = "b3e9908b6cdbf5c565b686938994e3ac8e6749f41bcbe83615604321a0965d49";
const SPLIT_CONTRACT = "177a5b2e6afb5822ed7031c12d4c8f3dedb194695fb20907a34eaec10e9bbabe";
const TOKEN_CONTRACT = "e16152b7bc7e42f60329287c00b986c720d2b7f06a1cdfc8348116d994eff5ea";
const STATE_UREF = "uref-e1bacc34eb863187bcb1b31c4dea3e35b0c07ba21d8235ad3e22766ccb5f8bc3-007";
const BALANCES_UREF = `uref-${"bb".repeat(32)}-007`;
const P1 = "fcf6bc94cef41aab24599669d62e919f0c65382a1bb734ae5e57706b997093ca";
const P2 = "a88a12ab6f3f7942ec3f9ddcc4c5fcc552a535604942f46cf712ddcdb40f903f";
const list = (hex: string) => ({ cl_type: { List: "U8" }, bytes: hex });

// Keys and values exactly as the testnet node answered them (read-only state_get_dictionary_item, 2026-11-02).
const LIVE = {
  token: ["270c07945707b0a86fdbd6930e7bb3cae8978a3bcfb6659e8062ef39ec58c32a", list(`2100000001${TOKEN_PKG}`)],
  totalShares: ["34461635d31fd734cee1f20839218ffef78785d536b348b04204510012a8cbd2", list("0400000064000000")],
  totalReleased: ["b6c377c588b78bf5abaa8a3829ce9fe6989dce6c738fccfb896b66eacaaf6b6d", list("060000000500a0d424f2")],
  sharesP1: ["d89320ce88bd78c370a73c9767a26b54d85e4f24124a189133bde121cb93d18c", list("040000003c000000")],
  releasedP1: ["c484af96d007b9796190ed1fdfe6e23616dba98676b1a8401fc96915464b23a7", list("06000000050070c9b28b")],
  balance: ["Afoh77QGqBUdFaOTvDZuURkqnqFf1/4j+v/FTwIbMog8", { cl_type: "U256", bytes: "050040be4025" }],
} as const;

test("Odra and CEP-18 dictionary keys match the ones the testnet node answers for", () => {
  assert.equal(odraStateKey(1), LIVE.token[0]);
  assert.equal(odraStateKey(4), LIVE.totalShares[0]);
  assert.equal(odraStateKey(6), LIVE.totalReleased[0]);
  assert.equal(odraStateKey(3, addressKeyBytes("account", `account-hash-${P1}`)), LIVE.sharesP1[0]);
  assert.equal(odraStateKey(5, addressKeyBytes("account", P1)), LIVE.releasedP1[0]);
  assert.equal(cep18BalanceKey("contract", `hash-${SPLIT_PKG}`), LIVE.balance[0]);
  assert.throws(() => odraStateKey(16), RangeError);
  assert.throws(() => addressKeyBytes("account", "abc"), RangeError);
});

test("stored values decode to the contract's types", () => {
  assert.deepEqual(decodeAddress(odraValueBytes(LIVE.token[1])), { kind: "contract", hash: TOKEN_PKG });
  assert.equal(decodeU32(odraValueBytes(LIVE.totalShares[1])), 100);
  assert.equal(decodeU256(odraValueBytes(LIVE.totalReleased[1])), 1_040_000_000_000n);
  assert.equal(decodeU256(odraValueBytes(LIVE.releasedP1[1])), 600_000_000_000n);
  assert.equal(decodeU256(Uint8Array.of(0)), 0n);
  assert.throws(() => odraValueBytes({ cl_type: "U256", bytes: "00" }), SplitReadError);
  assert.throws(() => odraValueBytes(list("0500000001")), SplitReadError, "length prefix does not match");
  assert.throws(() => decodeU256(Uint8Array.of(2, 1)), SplitReadError);
});

test("releasable follows the contract: (held + released) × share / total − already released, floored at 0", () => {
  const base = { heldRaw: 160n, totalReleasedRaw: 1040n, totalShares: 100 };
  assert.equal(releasableOf({ ...base, shares: 60, releasedRaw: 600n }), 120n);
  assert.equal(releasableOf({ ...base, shares: 40, releasedRaw: 440n }), 40n);
  assert.equal(releasableOf({ ...base, shares: 60, releasedRaw: 720n }), 0n, "fully paid out: release would revert");
  assert.equal(releasableOf({ ...base, shares: 60, releasedRaw: 900n }), 0n);
  assert.equal(releasableOf({ heldRaw: 10n, totalReleasedRaw: 0n, totalShares: 3, shares: 1, releasedRaw: 0n }), 3n, "integer division");
  assert.equal(releasableOf({ ...base, shares: 0, releasedRaw: 0n }), 0n);
});

type Rpc = { method: string; params: Record<string, unknown> };

/** A fake Casper node serving the recorded answers; `overrides` replaces dictionary items by key. */
function fakeNode(overrides: Record<string, unknown> = {}) {
  const items: Record<string, unknown> = {
    [LIVE.token[0]]: LIVE.token[1],
    [LIVE.totalShares[0]]: LIVE.totalShares[1],
    [LIVE.totalReleased[0]]: LIVE.totalReleased[1],
    [LIVE.sharesP1[0]]: LIVE.sharesP1[1],
    [LIVE.releasedP1[0]]: LIVE.releasedP1[1],
    [odraStateKey(3, addressKeyBytes("account", P2))]: list("0400000028000000"),
    [odraStateKey(5, addressKeyBytes("account", P2))]: list("060000000500300b7266"),
    [LIVE.balance[0]]: LIVE.balance[1],
    ...overrides,
  };
  const calls: Rpc[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const { id, method, params } = JSON.parse(String(init?.body)) as { id: number } & Rpc;
    calls.push({ method, params });
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
    if (method === "chain_get_state_root_hash") return ok({ state_root_hash: "ab".repeat(32) });
    if (method === "query_global_state") {
      const key = String(params.key);
      if (key === `hash-${SPLIT_PKG}`) return ok({ stored_value: { ContractPackage: { versions: [{ contract_hash: `contract-${SPLIT_CONTRACT}` }] } } });
      if (key === `hash-${TOKEN_PKG}`) return ok({ stored_value: { ContractPackage: { versions: [{ contract_hash: `contract-${TOKEN_CONTRACT}` }] } } });
      if (key === `hash-${SPLIT_CONTRACT}`) return ok({ stored_value: { Contract: { named_keys: [{ name: "state", key: STATE_UREF }] } } });
      if (key === `hash-${TOKEN_CONTRACT}`) return ok({ stored_value: { Contract: { named_keys: [{ name: "balances", key: BALANCES_UREF }] } } });
    }
    if (method === "state_get_dictionary_item") {
      const { seed_uref, dictionary_item_key } = (params.dictionary_identifier as { URef: { seed_uref: string; dictionary_item_key: string } }).URef;
      const value = items[dictionary_item_key];
      const right = (seed_uref === BALANCES_UREF) === (dictionary_item_key === LIVE.balance[0]);
      if (value !== undefined && value !== null && right) return ok({ stored_value: { CLValue: value } });
    }
    return Response.json({ jsonrpc: "2.0", id, error: { code: -32003, message: "Query failed", data: "value was not found in the global state" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const options = (fetchImpl: typeof fetch) => ({
  nodeUrl: "https://node.example/rpc",
  splitPackage: SPLIT_PKG,
  tokenPackage: TOKEN_PKG,
  payees: [
    { accountHash: `account-hash-${P1}`, share: 60 },
    { accountHash: `account-hash-${P2}`, share: 40 },
  ],
  fetchImpl,
});

test("reads the testnet split state: 160 held, 1040 released, 120 and 40 releasable", async () => {
  const { fetchImpl, calls } = fakeNode();
  const s = await readSplitState(options(fetchImpl));
  assert.equal(s.heldRaw, "160000000000");
  assert.equal(s.totalReleasedRaw, "1040000000000");
  assert.equal(s.totalShares, 100);
  assert.deepEqual(
    s.payees.map((p) => [p.accountHash, p.shares, p.releasedRaw, p.releasableRaw]),
    [
      [P1, 60, "600000000000", "120000000000"],
      [P2, 40, "440000000000", "40000000000"],
    ],
  );
  // Every read is pinned to one state root.
  const roots = calls.filter((c) => c.method === "state_get_dictionary_item").map((c) => c.params.state_root_hash);
  assert.deepEqual([...new Set(roots)], ["ab".repeat(32)]);
});

test("items that were never written read as zero, like get_or_default", async () => {
  const { fetchImpl } = fakeNode({ [LIVE.releasedP1[0]]: null, [LIVE.balance[0]]: null });
  const s = await readSplitState(options(fetchImpl));
  // Nothing held: P1 is owed 60% of 1040 = 624 and has not been paid anything.
  assert.equal(s.heldRaw, "0");
  assert.equal(s.payees[0]!.releasableRaw, "624000000000");
  assert.equal(s.payees[1]!.releasableRaw, "0", "P2 already got 440 of its 416");
});

test("a state that does not match the expected contract is an error, never an amount", async () => {
  const otherToken = list(`2100000001${"cd".repeat(32)}`);
  await assert.rejects(readSplitState(options(fakeNode({ [LIVE.token[0]]: otherToken }).fetchImpl)), /different token/);
  await assert.rejects(readSplitState(options(fakeNode({ [LIVE.sharesP1[0]]: list("0400000032000000") }).fetchImpl)), /shares differ/);
  await assert.rejects(readSplitState(options(fakeNode({ [LIVE.totalShares[0]]: null }).fetchImpl)), /no total_shares/);
});

test("node failures map to 502, timeouts to 504", async () => {
  const status = async (fetchImpl: typeof fetch) => {
    const e = await readSplitState(options(fetchImpl)).catch((x: unknown) => x);
    assert.ok(e instanceof SplitReadError);
    return e.status;
  };
  assert.equal(await status((async () => new Response("bad gateway", { status: 502 })) as typeof fetch), 502);
  assert.equal(await status((async () => new Response("<html>", { status: 200 })) as typeof fetch), 502);
  assert.equal(
    await status((async () => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "busy" } })) as typeof fetch),
    502,
  );
  assert.equal(await status((async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch), 502);
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  assert.equal(await status((async () => Promise.reject(timeout)) as typeof fetch), 504);
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCesPreemptionChecker, decodeCesEvent } from "./preemption.js";

// Real events #43 and #44 of CasCet's x402 token on casper-test (one transfer_with_authorization).
const REAL_AUTHORIZATION_USED =
  "60000000170000006576656e745f417574686f72697a6174696f6e557365640065190126b1ca282f041fad6b74b845a3c48e0c8411392b13c640a16a1438faf920000000320c94ebedbb5bc01d63644266d33c4088618644ec58ee06bb8ebd328002c2fc";
const REAL_TRANSFER =
  "5a0000000e0000006576656e745f5472616e736665720065190126b1ca282f041fad6b74b845a3c48e0c8411392b13c640a16a1438faf90051a4f8ca1c186b0e93ff6628e2c2303ded5b3cd343fca220e829ce540411abf30500f2052a01";
const REAL_PAYER = "0065190126b1ca282f041fad6b74b845a3c48e0c8411392b13c640a16a1438faf9";
const REAL_PAY_TO = "0051a4f8ca1c186b0e93ff6628e2c2303ded5b3cd343fca220e829ce540411abf3";
const REAL_NONCE = "320c94ebedbb5bc01d63644266d33c4088618644ec58ee06bb8ebd328002c2fc";
const REAL_AMOUNT = "5000000000";

// ---- a minimal CES encoder for synthetic events -------------------------------------------
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const str = (s: string): Buffer => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
const key = (address: string): Buffer => Buffer.concat([Buffer.from([address.startsWith("00") ? 0 : 1]), Buffer.from(address.slice(2), "hex")]);
const byteList = (hex: string): Buffer => Buffer.concat([u32(hex.length / 2), Buffer.from(hex, "hex")]);
const u256 = (n: bigint): Buffer => {
  if (n === 0n) return Buffer.from([0]);
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const le = Buffer.from(hex, "hex").reverse();
  return Buffer.concat([Buffer.from([le.length]), le]);
};
const event = (...parts: Buffer[]): string => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length), body]).toString("hex");
};
const authorizationUsed = (payer: string, nonce: string) => event(str("event_AuthorizationUsed"), key(payer), byteList(nonce));
const authorizationCanceled = (payer: string, nonce: string) => event(str("event_AuthorizationCanceled"), key(payer), byteList(nonce));
const transfer = (from: string, to: string, amount: bigint) => event(str("event_Transfer"), key(from), key(to), u256(amount));
const mint = (to: string, amount: bigint) => event(str("event_Mint"), key(to), u256(amount));

const PACKAGE = "cb".repeat(32);
const CONTRACT = "36".repeat(32);

/** A Casper node that serves one token's events. Records the RPC calls it answered. */
function fakeNode(events: string[], calls: Array<{ method: string; params: unknown }> = []): typeof fetch {
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: Record<string, unknown> };
    calls.push({ method: request.method, params: request.params });
    const answer = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    switch (request.method) {
      case "chain_get_state_root_hash":
        return answer({ state_root_hash: "ff".repeat(32) });
      case "query_global_state": {
        const path = request.params.path as string[];
        if (path.length === 0) {
          assert.equal(request.params.key, `hash-${PACKAGE}`);
          return answer({
            stored_value: {
              ContractPackage: {
                versions: [
                  { contract_hash: `contract-${"00".repeat(32)}`, contract_version: 1 },
                  { contract_hash: `contract-${CONTRACT}`, contract_version: 2 },
                ],
                disabled_versions: [],
              },
            },
          });
        }
        assert.deepEqual(path, ["__events_length"]);
        assert.equal(request.params.key, `hash-${CONTRACT}`);
        return answer({ stored_value: { CLValue: { cl_type: "U32", parsed: events.length } } });
      }
      case "state_get_dictionary_item": {
        const id = (request.params.dictionary_identifier as { ContractNamedKey: { key: string; dictionary_name: string; dictionary_item_key: string } })
          .ContractNamedKey;
        assert.equal(id.key, `hash-${CONTRACT}`);
        assert.equal(id.dictionary_name, "__events");
        const index = Number(id.dictionary_item_key);
        const bytes = events[index];
        if (bytes === undefined) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32003, message: "Query failed", data: "value was not found in the global state" },
            }),
          );
        }
        return answer({ stored_value: { CLValue: { cl_type: { List: "U8" }, bytes } } });
      }
      default:
        throw new Error(`unexpected RPC method ${request.method}`);
    }
  };
}

const checker = (events: string[], scanWindow = 64) =>
  createCesPreemptionChecker({ nodeUrl: "http://node.test/rpc", tokenPackageHash: `hash-${PACKAGE}`, scanWindow, fetchImpl: fakeNode(events) });

const query = { payer: REAL_PAYER, nonce: REAL_NONCE, payTo: REAL_PAY_TO, amount: REAL_AMOUNT };
const filler = (n: number) => Array.from({ length: n }, (_, i) => mint(`00${"ee".repeat(32)}`, BigInt(i + 1)));

describe("decodeCesEvent", () => {
  it("decodes real AuthorizationUsed and Transfer events of the x402 token", () => {
    assert.deepEqual(decodeCesEvent(REAL_AUTHORIZATION_USED), {
      name: "AuthorizationUsed",
      authorizer: { tag: 0, hash: REAL_PAYER.slice(2) },
      nonce: REAL_NONCE,
    });
    assert.deepEqual(decodeCesEvent(REAL_TRANSFER), {
      name: "Transfer",
      sender: { tag: 0, hash: REAL_PAYER.slice(2) },
      recipient: { tag: 0, hash: REAL_PAY_TO.slice(2) },
      amount: 5_000_000_000n,
    });
  });

  it("matches the encoder used for the synthetic events below", () => {
    assert.equal(authorizationUsed(REAL_PAYER, REAL_NONCE), REAL_AUTHORIZATION_USED);
    assert.equal(transfer(REAL_PAYER, REAL_PAY_TO, 5_000_000_000n), REAL_TRANSFER);
  });

  it("returns undefined for malformed bytes and Other for unrelated events", () => {
    assert.equal(decodeCesEvent(REAL_TRANSFER.slice(0, -2)), undefined, "truncated");
    assert.equal(decodeCesEvent(`ff${REAL_TRANSFER.slice(2)}`), undefined, "wrong length prefix");
    assert.equal(decodeCesEvent("zz"), undefined, "not hex");
    assert.equal(decodeCesEvent(`${REAL_TRANSFER}00`), undefined, "trailing bytes");
    assert.deepEqual(decodeCesEvent(mint(REAL_PAY_TO, 1n)), { name: "Other", rawName: "event_Mint" });
  });
});

describe("CES settlement preemption checker", () => {
  it("reports paid when AuthorizationUsed is directly followed by the matching Transfer", async () => {
    const events = [...filler(5), REAL_AUTHORIZATION_USED, REAL_TRANSFER, ...filler(3)];
    assert.deepEqual(await checker(events).check(query), { kind: "paid", eventIndex: 5 });
  });

  it("does not take a used nonce as payment when the transfer went elsewhere or was a different amount", async () => {
    const elsewhere = [...filler(2), REAL_AUTHORIZATION_USED, transfer(REAL_PAYER, `00${"99".repeat(32)}`, 5_000_000_000n)];
    const outcome = await checker(elsewhere).check(query);
    assert.equal(outcome.kind, "consumed-elsewhere");
    if (outcome.kind === "consumed-elsewhere") assert.match(outcome.detail, /different recipient/);

    const cheaper = [REAL_AUTHORIZATION_USED, transfer(REAL_PAYER, REAL_PAY_TO, 1n)];
    const outcome2 = await checker(cheaper).check(query);
    assert.equal(outcome2.kind, "consumed-elsewhere");
    if (outcome2.kind === "consumed-elsewhere") assert.match(outcome2.detail, /paid 1 instead of 5000000000/);

    const noTransfer = [...filler(1), REAL_AUTHORIZATION_USED];
    assert.equal((await checker(noTransfer).check(query)).kind, "consumed-elsewhere");
  });

  it("reports a canceled nonce", async () => {
    const events = [...filler(4), authorizationCanceled(REAL_PAYER, REAL_NONCE), ...filler(2)];
    assert.deepEqual(await checker(events).check(query), { kind: "canceled", eventIndex: 4 });
  });

  it("ignores the same nonce of another payer", async () => {
    const other = `00${"77".repeat(32)}`;
    const events = [authorizationUsed(other, REAL_NONCE), transfer(other, REAL_PAY_TO, 5_000_000_000n)];
    assert.deepEqual(await checker(events).check(query), { kind: "not-found", scanned: 2 });
  });

  it("only scans the configured window of recent events", async () => {
    const events = [REAL_AUTHORIZATION_USED, REAL_TRANSFER, ...filler(20)];
    assert.deepEqual(await checker(events, 10).check(query), { kind: "not-found", scanned: 10 });
    assert.deepEqual(await checker(events, 22).check(query), { kind: "paid", eventIndex: 0 });
  });

  it("refuses malformed queries", async () => {
    await assert.rejects(checker([]).check({ ...query, nonce: "xyz" }), /malformed query/);
    await assert.rejects(checker([]).check({ ...query, amount: "-1" }), /malformed query/);
  });

  it("uses one state root for every read", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const c = createCesPreemptionChecker({
      nodeUrl: "http://node.test/rpc",
      tokenPackageHash: PACKAGE,
      scanWindow: 8,
      fetchImpl: fakeNode([REAL_AUTHORIZATION_USED, REAL_TRANSFER], calls),
    });
    await c.check(query);
    assert.equal(calls.filter(call => call.method === "chain_get_state_root_hash").length, 1);
    for (const call of calls.filter(c2 => c2.method === "state_get_dictionary_item")) {
      assert.equal((call.params as { state_root_hash: string }).state_root_hash, "ff".repeat(32));
    }
  });
});

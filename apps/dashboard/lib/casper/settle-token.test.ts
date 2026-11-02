import { test } from "node:test";
import assert from "node:assert/strict";
import { createSettleTokenReader, settledTokenOf } from "./settle-token";

const CEP18X402 = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
const WCSPR = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";
const REGISTRY = "bdf8422b69d7bfb7581e7b2c63fbfb0fc8b23701181289411170bce5cf996f97";
const SETTLE = "2ffeb8c7a9313cb1df7affc1fc50669bf0ea19be9474498e6960273ea470a8b3";
const OTHER = "ab".repeat(32);

/**
 * The `transaction` of an info_get_transaction answer, shaped as the testnet node
 * answers it for a settle (tools/e2e/src/gas-fixtures.ts, recorded 2026-11-01;
 * arguments trimmed).
 */
const v1 = (pkg: string, entryPoint: string) => ({
  Version1: {
    hash: SETTLE,
    payload: {
      chain_name: "casper-test",
      fields: {
        args: { Named: [["value", { cl_type: "U256", parsed: "500000000" }]] },
        entry_point: { Custom: entryPoint },
        scheduling: "Standard",
        target: { Stored: { id: { ByPackageHash: { addr: pkg, version: null } }, runtime: "VmCasperV1" } },
      },
    },
  },
});
const deploy = (pkg: string, entryPoint: string) => ({
  Deploy: { hash: SETTLE, session: { StoredVersionedContractByHash: { hash: pkg, version: null, entry_point: entryPoint, args: [] } } },
});

test("a settle names the token it paid in: the package its transfer_with_authorization calls", () => {
  assert.equal(settledTokenOf(v1(CEP18X402, "transfer_with_authorization")), CEP18X402);
  assert.equal(settledTokenOf(v1(WCSPR.toUpperCase(), "transfer_with_authorization")), WCSPR);
  assert.equal(settledTokenOf(deploy(`hash-${WCSPR}`, "transfer_with_authorization")), WCSPR);
  // Anything else names no token: another entry point, a session, a malformed answer.
  assert.equal(settledTokenOf(v1(REGISTRY, "record")), undefined);
  assert.equal(settledTokenOf(deploy(CEP18X402, "transfer")), undefined);
  assert.equal(settledTokenOf({ Version1: { payload: { fields: { entry_point: { Custom: "transfer_with_authorization" }, target: { Session: {} } } } } }), undefined);
  assert.equal(settledTokenOf(v1("not-a-hash", "transfer_with_authorization")), undefined);
  for (const junk of [undefined, null, "x", {}, { Version1: null }, { Deploy: { session: null } }]) assert.equal(settledTokenOf(junk), undefined);
});

/** A fake Casper node: `answers` maps "<variant>:<hash>" to a result, or to a JSON-RPC error. */
function node(answers: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; params: { transaction_hash: Record<string, string> } };
    assert.equal(body.method, "info_get_transaction");
    const [variant, hash] = Object.entries(body.params.transaction_hash)[0]!;
    const key = `${variant}:${hash}`;
    calls.push(key);
    const answer = answers[key] ?? { error: { code: -32014, message: "No such transaction" } };
    if (answer instanceof Error) throw answer;
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...(answer as object) }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("the reader asks the node once per settle and keeps the answer, which never changes", async () => {
  const fake = node({
    [`Version1:${SETTLE}`]: { result: { transaction: v1(WCSPR, "transfer_with_authorization") } },
    [`Deploy:${OTHER}`]: { result: { transaction: deploy(CEP18X402, "transfer_with_authorization") } },
  });
  const read = createSettleTokenReader({ nodeUrl: "http://node.test/rpc", fetchImpl: fake.fetchImpl });
  assert.equal(await read(SETTLE), WCSPR);
  assert.equal(await read(SETTLE.toUpperCase()), WCSPR);
  // A legacy deploy: unknown as a Version1 transaction, found as a deploy.
  assert.equal(await read(OTHER), CEP18X402);
  assert.equal(await read(OTHER), CEP18X402);
  assert.deepEqual(fake.calls, [`Version1:${SETTLE}`, `Version1:${OTHER}`, `Deploy:${OTHER}`]);
});

test("a transaction that is no settle is remembered as naming no token", async () => {
  const fake = node({ [`Version1:${SETTLE}`]: { result: { transaction: v1(REGISTRY, "record") } } });
  const read = createSettleTokenReader({ nodeUrl: "http://node.test/rpc", fetchImpl: fake.fetchImpl });
  assert.equal(await read(SETTLE), undefined);
  assert.equal(await read(SETTLE), undefined);
  assert.equal(fake.calls.length, 1);
});

test("an answer that may change later (unknown to the node, failures) is not kept", async () => {
  const fake = node({
    [`Version1:${OTHER}`]: new Response("busy", { status: 503 }),
    [`Version1:${"cd".repeat(32)}`]: { error: { code: -32001, message: "internal" } },
    [`Version1:${"ef".repeat(32)}`]: Object.assign(new Error("timed out"), { name: "TimeoutError" }),
    [`Version1:${"12".repeat(32)}`]: new Response("not json", { status: 200 }),
  });
  const read = createSettleTokenReader({ nodeUrl: "http://node.test/rpc", fetchImpl: fake.fetchImpl });
  for (const hash of [SETTLE, OTHER, "cd".repeat(32), "ef".repeat(32), "12".repeat(32)]) {
    assert.equal(await read(hash), undefined, hash);
    assert.equal(await read(hash), undefined, hash);
  }
  // Each one is asked again; a hash unknown to the node is asked in both forms each time.
  assert.equal(fake.calls.filter(c => c.endsWith(SETTLE)).length, 4);
  assert.equal(fake.calls.filter(c => c.endsWith(OTHER)).length, 2);
});

test("a malformed hash never reaches the node, and the kept answers stay bounded", async () => {
  const answers: Record<string, unknown> = {};
  const hashes = [0, 1, 2].map(i => String(i).repeat(64));
  for (const hash of hashes) answers[`Version1:${hash}`] = { result: { transaction: v1(WCSPR, "transfer_with_authorization") } };
  const fake = node(answers);
  const read = createSettleTokenReader({ nodeUrl: "http://node.test/rpc", fetchImpl: fake.fetchImpl, cacheSize: 2 });
  assert.equal(await read("demo-tx"), undefined);
  assert.equal(await read(`0x${SETTLE}`), undefined);
  assert.equal(fake.calls.length, 0);
  for (const hash of hashes) await read(hash);
  await read(hashes[0]!); // dropped to keep two answers: asked again
  await read(hashes[2]!); // still kept
  assert.equal(fake.calls.length, 4);
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCasperRpc, isNoSuchTransaction, isValueNotFound, RpcNodeError, RpcTransportError, type FetchLike } from "./casper-rpc.js";
import * as fx from "./rpc-fixtures.js";

const respond = (status: number, body: string): FetchLike => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });

describe("casper-rpc error classification", () => {
  test("returns the result of a successful call", async () => {
    const rpc = createCasperRpc("http://rpc.invalid", { fetchImpl: respond(200, JSON.stringify(fx.testnetNameResponse)) });
    const result = await rpc.call<{ stored_value: { CLValue: { parsed: string } } }>("query_global_state", { key: "uref-x", path: [] });
    assert.equal(result.stored_value.CLValue.parsed, "CasCet X402 Token");
  });

  test("a JSON-RPC error is an RpcNodeError (the node answered)", async () => {
    const rpc = createCasperRpc("http://rpc.invalid", { fetchImpl: respond(200, JSON.stringify(fx.testnetUnusedNonceResponse)) });
    const err = await rpc.call("query_global_state", {}).catch(e => e);
    assert.ok(err instanceof RpcNodeError);
    assert.equal(err.code, -32003);
    assert.equal(isValueNotFound(err), true);
    assert.equal(isNoSuchTransaction(err), false);
  });

  test("No such transaction is recognized", async () => {
    const rpc = createCasperRpc("http://rpc.invalid", { fetchImpl: respond(200, JSON.stringify(fx.noSuchTransactionResponse)) });
    const err = await rpc.call("info_get_transaction", {}).catch(e => e);
    assert.equal(isNoSuchTransaction(err), true);
    assert.equal(isValueNotFound(err), false);
  });

  test("not-found matching is strict: other -32003 failures stay indeterminate", () => {
    assert.equal(isValueNotFound(new RpcNodeError("q", -32003, "Query failed", "root not found")), false);
    assert.equal(isValueNotFound(new RpcNodeError("q", -32018, "Node request failure", "value was not found")), false);
    assert.equal(isValueNotFound(new RpcTransportError("q", "timeout", "t")), false);
  });

  test("HTTP errors, bad bodies, network failures and timeouts are RpcTransportErrors", async () => {
    const cases: Array<[FetchLike, string]> = [
      [respond(503, "busy"), "http"],
      [respond(200, "<html>"), "invalid-response"],
      [respond(200, "42"), "invalid-response"],
      [respond(200, JSON.stringify({ jsonrpc: "2.0", id: 1 })), "invalid-response"],
      [async () => Promise.reject(new TypeError("fetch failed")), "network"],
      [
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason));
          }),
        "timeout",
      ],
    ];
    for (const [fetchImpl, kind] of cases) {
      const rpc = createCasperRpc("http://rpc.invalid", { fetchImpl, timeoutMs: 20 });
      const err = await rpc.call("info_get_status", []).catch(e => e);
      assert.ok(err instanceof RpcTransportError, `expected transport error for ${kind}`);
      assert.equal(err.kind, kind);
    }
  });

  test("sends a well-formed JSON-RPC 2.0 request", async () => {
    let sent: { jsonrpc: string; id: number; method: string; params: unknown } | undefined;
    const rpc = createCasperRpc("http://rpc.invalid", {
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(init.body);
        return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }) };
      },
    });
    await rpc.call("query_global_state", { key: "hash-ab", path: [] });
    assert.equal(sent?.jsonrpc, "2.0");
    assert.equal(sent?.method, "query_global_state");
    assert.deepEqual(sent?.params, { key: "hash-ab", path: [] });
  });
});

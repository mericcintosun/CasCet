import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCasperRpc, isNoSuchTransaction, isValueNotFound, RpcNodeError, RpcTransportError, type RpcFetch } from "./casper-rpc.js";
import * as fx from "./testing/rpc-fixtures.js";
import { hangingFetch } from "./testing/rpc-replay.js";

const respond = (status: number, body: string): RpcFetch => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });

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
    const cases: Array<[RpcFetch, string]> = [
      [respond(503, "busy"), "http"],
      [respond(200, "<html>"), "invalid-response"],
      [respond(200, "42"), "invalid-response"],
      [respond(200, JSON.stringify({ jsonrpc: "2.0", id: 1 })), "invalid-response"],
      [async () => Promise.reject(new TypeError("fetch failed")), "network"],
      [hangingFetch(), "timeout"],
    ];
    for (const [fetchImpl, kind] of cases) {
      const rpc = createCasperRpc("http://rpc.invalid", { fetchImpl, timeoutMs: 20 });
      const err = await rpc.call("info_get_status", []).catch(e => e);
      assert.ok(err instanceof RpcTransportError, `expected transport error for ${kind}`);
      assert.equal(err.kind, kind);
    }
  });

  test("its timeout keeps the event loop alive until the call ends, and not after", async () => {
    // AbortSignal.timeout() is unref'd: with a node that never answers and nothing else pending (no socket, as with
    // an injected fetch), a short-lived process or the test runner could end before the call fails.
    const timers = () => process.getActiveResourcesInfo().filter(type => type === "Timeout").length;
    const never: RpcFetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason as Error), { once: true }));
    const before = timers();
    const pending = createCasperRpc("http://rpc.invalid", { fetchImpl: never, timeoutMs: 30 }).call("query_global_state", {});
    assert.equal(timers(), before + 1, "a call in flight holds a timer that keeps the event loop alive");
    const err = await pending.catch(e => e);
    assert.ok(err instanceof RpcTransportError && err.kind === "timeout", String(err));
    assert.equal(timers(), before);
    const answered = createCasperRpc("http://rpc.invalid", { fetchImpl: respond(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })) });
    assert.deepEqual(await answered.call("query_global_state", {}), {});
    const failed = createCasperRpc("http://rpc.invalid", { fetchImpl: respond(503, "down") });
    await assert.rejects(failed.call("query_global_state", {}), RpcTransportError);
    assert.equal(timers(), before, "an answered call leaves no timer behind");
  });

  test("a per-call timeout can only shorten the client's timeout", async () => {
    const hang = hangingFetch();
    const rpc = createCasperRpc("http://rpc.invalid", { fetchImpl: hang, timeoutMs: 5_000 });
    const started = Date.now();
    const err = await rpc.call("query_global_state", {}, { timeoutMs: 30 }).catch(e => e);
    assert.ok(err instanceof RpcTransportError && err.kind === "timeout");
    assert.ok(Date.now() - started < 2_000, "the shorter per-call timeout applied");

    const short = createCasperRpc("http://rpc.invalid", { fetchImpl: hang, timeoutMs: 30 });
    const begun = Date.now();
    await short.call("query_global_state", {}, { timeoutMs: 60_000 }).catch(e => e);
    assert.ok(Date.now() - begun < 2_000, "a longer per-call timeout is ignored");
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

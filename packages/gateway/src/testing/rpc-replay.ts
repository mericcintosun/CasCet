import type { RpcFetch } from "../casper-rpc.js";

/**
 * Test helpers (no network): a `fetch` stand-in that replays recorded JSON-RPC
 * responses keyed by "<method> <params.key>" (or "<method>" alone), one that
 * never answers, and a controllable clock.
 */

export type Replay = unknown | Error | ((params: Record<string, unknown>) => unknown);

export function replayFetch(routes: Record<string, Replay>, calls: string[] = []): RpcFetch {
  return async (_url, init) => {
    const req = JSON.parse(init.body) as { method: string; params?: Record<string, unknown> };
    const params = req.params ?? {};
    const withKey = typeof params["key"] === "string" ? `${req.method} ${params["key"]}` : req.method;
    calls.push(withKey);
    // Own keys only: a method such as "constructor" must not reach Object.prototype.
    const route = Object.hasOwn(routes, withKey)
      ? routes[withKey]
      : Object.hasOwn(routes, req.method)
        ? routes[req.method]
        : undefined;
    if (route === undefined) throw new Error(`unexpected RPC call: ${withKey}`);
    const response = typeof route === "function" ? (route as (p: Record<string, unknown>) => unknown)(params) : route;
    if (response instanceof Error) throw response;
    return { ok: true, status: 200, text: async () => JSON.stringify(response) };
  };
}

/**
 * A node that never answers: the request fails only when its signal aborts.
 * Like the open socket of a real request, a ref'd timer keeps the event loop
 * alive until then. The client's timeout (AbortSignal.timeout) is unref'd, and
 * before Node 24 the test runner cancels a test whose only pending work is an
 * unref'd timer. If the abort never comes, the request fails after `giveUpMs`
 * with a non-timeout error, so the test fails instead of hanging.
 */
export function hangingFetch(giveUpMs = 30_000): RpcFetch {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      if (init.signal.aborted) {
        reject(init.signal.reason);
        return;
      }
      const giveUp = setTimeout(() => reject(new Error(`no abort within ${giveUpMs} ms`)), giveUpMs);
      init.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(giveUp);
          reject(init.signal.reason);
        },
        { once: true },
      );
    });
}

export function rpcError(code: number, message: string, data?: string) {
  return { jsonrpc: "2.0", id: 1, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

export class FakeClock {
  constructor(public ms: number) {}
  now = (): number => this.ms;
  advance(ms: number): void {
    this.ms += ms;
  }
}

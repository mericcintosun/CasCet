import type { FetchLike } from "./casper-rpc.js";

/**
 * Test helpers (no network): a `fetch` stand-in that replays recorded JSON-RPC
 * responses keyed by "<method> <params.key>" (or "<method>" alone), and a
 * controllable clock.
 */

export type Replay = unknown | Error | ((params: Record<string, unknown>) => unknown);

export function replayFetch(routes: Record<string, Replay>, calls: string[] = []): FetchLike {
  return async (_url, init) => {
    const req = JSON.parse(init.body) as { method: string; params?: Record<string, unknown> };
    const params = req.params ?? {};
    const withKey = typeof params["key"] === "string" ? `${req.method} ${params["key"]}` : req.method;
    calls.push(withKey);
    const route = withKey in routes ? routes[withKey] : routes[req.method];
    if (route === undefined) throw new Error(`unexpected RPC call: ${withKey}`);
    const response = typeof route === "function" ? (route as (p: Record<string, unknown>) => unknown)(params) : route;
    if (response instanceof Error) throw response;
    return { ok: true, status: 200, text: async () => JSON.stringify(response) };
  };
}

export function rpcError(code: number, message: string, data?: string) {
  return { jsonrpc: "2.0", id: 1, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

export function rpcResult(result: unknown) {
  return { jsonrpc: "2.0", id: 1, result };
}

export class FakeClock {
  constructor(public ms: number) {}
  now = (): number => this.ms;
  advance(ms: number): void {
    this.ms += ms;
  }
}

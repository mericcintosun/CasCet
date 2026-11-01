import { createServer } from "node:http";
import type { FetchLike } from "./casper-rpc.js";

/**
 * Test helpers (no network): a `fetch` stand-in that replays recorded JSON-RPC
 * responses keyed by "<method> <params.key>" (or "<method>" alone), the same
 * routes served by a local HTTP server, and a controllable clock.
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

export interface FakeRpcCall {
  method: string;
  params: Record<string, unknown>;
}

export interface FakeRpcServer {
  /** JSON-RPC endpoint on 127.0.0.1 (for code that uses the real HTTP client). */
  url: string;
  calls: FakeRpcCall[];
  close(): Promise<void>;
}

/**
 * A local JSON-RPC server answering from `routes` like {@link replayFetch}: a
 * function route gets the params, an Error drops the connection (a transport
 * failure), and a missing route answers "method not found".
 */
export async function startFakeRpcServer(routes: Record<string, Replay>): Promise<FakeRpcServer> {
  const calls: FakeRpcCall[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      let rpcRequest: { id?: unknown; method?: unknown; params?: Record<string, unknown> };
      try {
        rpcRequest = JSON.parse(body) as typeof rpcRequest;
      } catch {
        res.writeHead(400).end();
        return;
      }
      const method = String(rpcRequest.method);
      const params = rpcRequest.params ?? {};
      calls.push({ method, params });
      const withKey = typeof params["key"] === "string" ? `${method} ${params["key"]}` : method;
      const route = withKey in routes ? routes[withKey] : routes[method];
      let response: unknown;
      try {
        response = typeof route === "function" ? (route as (p: Record<string, unknown>) => unknown)(params) : route;
      } catch (err) {
        response = err;
      }
      if (response instanceof Error) {
        req.socket.destroy();
        return;
      }
      if (response === undefined) {
        response = { jsonrpc: "2.0", id: rpcRequest.id ?? 1, error: { code: -32601, message: `no fake route for ${withKey}` } };
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(response));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/rpc`,
    calls,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

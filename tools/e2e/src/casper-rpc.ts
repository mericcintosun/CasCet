/**
 * Minimal Casper JSON-RPC client for the self-hosted facilitator.
 *
 * The facilitator has to tell two kinds of failure apart:
 *  - the node ANSWERED with a JSON-RPC error (definitive: the transaction was
 *    rejected, a dictionary item does not exist, the hash is unknown, ...), and
 *  - we could not get an answer at all (timeout, network error, HTTP 5xx,
 *    garbage body): the outcome is UNKNOWN, e.g. a transaction may or may not
 *    have been accepted.
 * casper-js-sdk's RpcClient folds both into thrown errors and has no timeout,
 * so this client wraps `fetch` with a hard per-call timeout and two explicit
 * error classes. Transactions are still built and signed with casper-js-sdk.
 */

/** The node answered, and the answer is a JSON-RPC error object. */
export class RpcNodeError extends Error {
  readonly method: string;
  readonly code: number;
  readonly data: unknown;

  constructor(method: string, code: number, message: string, data: unknown) {
    super(`${method}: ${message} (code ${code})${typeof data === "string" && data ? `: ${data}` : ""}`);
    this.name = "RpcNodeError";
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

export type RpcTransportFailure = "timeout" | "network" | "http" | "invalid-response";

/** No usable answer from the node: the outcome of the call is unknown. */
export class RpcTransportError extends Error {
  readonly method: string;
  readonly kind: RpcTransportFailure;
  readonly status?: number;

  constructor(method: string, kind: RpcTransportFailure, detail: string, status?: number) {
    super(`${method}: ${kind} (${detail})`);
    this.name = "RpcTransportError";
    this.method = method;
    this.kind = kind;
    this.status = status;
  }
}

/** The subset of `fetch` this client needs (injectable for tests). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface CasperRpc {
  readonly url: string;
  call<T = unknown>(method: string, params: unknown): Promise<T>;
}

export interface CasperRpcOptions {
  /** Hard timeout per call, including reading the body. Default 8000 ms. */
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

/** JSON-RPC error code for "Query failed" (query_global_state & co). */
export const RPC_QUERY_FAILED = -32003;
/** JSON-RPC error code for "No such transaction" (info_get_transaction). */
export const RPC_NO_SUCH_TRANSACTION = -32014;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createCasperRpc(url: string, opts: CasperRpcOptions = {}): CasperRpc {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const doFetch: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  let nextId = 1;

  return {
    url,
    async call<T>(method: string, params: unknown): Promise<T> {
      const id = nextId++;
      const signal = AbortSignal.timeout(timeoutMs);
      const isTimeout = (err: unknown) =>
        signal.aborted || (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"));

      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          signal,
        });
      } catch (err) {
        throw new RpcTransportError(method, isTimeout(err) ? "timeout" : "network", errorText(err));
      }
      if (!response.ok) {
        throw new RpcTransportError(method, "http", `HTTP ${response.status}`, response.status);
      }

      let text: string;
      try {
        text = await response.text();
      } catch (err) {
        throw new RpcTransportError(method, isTimeout(err) ? "timeout" : "network", errorText(err));
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new RpcTransportError(method, "invalid-response", "body is not JSON");
      }
      if (typeof json !== "object" || json === null) {
        throw new RpcTransportError(method, "invalid-response", "body is not a JSON object");
      }
      const envelope = json as { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
      if (envelope.error !== undefined && envelope.error !== null) {
        const e = envelope.error;
        const code = typeof e.code === "number" ? e.code : Number.NaN;
        throw new RpcNodeError(method, code, typeof e.message === "string" ? e.message : "error", e.data);
      }
      if (!("result" in envelope)) {
        throw new RpcTransportError(method, "invalid-response", "neither result nor error");
      }
      return envelope.result as T;
    },
  };
}

/**
 * True when the node says the queried global-state value does not exist.
 * Matched strictly (code AND message), so any other failure stays "unknown".
 */
export function isValueNotFound(err: unknown): boolean {
  if (!(err instanceof RpcNodeError) || err.code !== RPC_QUERY_FAILED) return false;
  return typeof err.data === "string" && /value was not found/i.test(err.data);
}

/** True when the node does not (yet) know the transaction hash. */
export function isNoSuchTransaction(err: unknown): boolean {
  return err instanceof RpcNodeError && err.code === RPC_NO_SUCH_TRANSACTION;
}

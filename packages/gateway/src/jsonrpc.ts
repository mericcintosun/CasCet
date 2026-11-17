/** JSON-RPC 2.0 helpers and the error codes the gateway answers with. */

export type JsonRpcId = string | number | null;

export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

/**
 * Payment required, payment rejected, or settlement failed. Sent with HTTP 402
 * and the x402 PAYMENT-REQUIRED / PAYMENT-RESPONSE headers; `error.data` holds
 * the decoded PaymentRequired object (x402Version, error, resource, accepts).
 */
export const RPC_PAYMENT_REQUIRED = -32002;

/**
 * The settlement outcome is indeterminate (for example the facilitator timed
 * out after it may already have submitted the transfer). The buyer must not
 * pay again for the same call; the receipt is recorded with status "unknown".
 */
export const RPC_PAYMENT_INDETERMINATE = -32003;

export interface JsonRpcErrorBody {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export function rpcResult(id: JsonRpcId | undefined, result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}

export function rpcError(id: JsonRpcId | undefined, code: number, message: string, data?: unknown): JsonRpcErrorBody {
  const error: JsonRpcErrorBody["error"] = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

/** Whether a value is a valid JSON-RPC request id. */
export function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/** Shorten a client-supplied string before echoing it back in an error message. */
export function clip(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

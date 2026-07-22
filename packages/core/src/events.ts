import type { PaymentReceipt } from "./receipts.js";

/** Events a gateway pushes to the dashboard ingest endpoint (and over SSE to browsers). */
export type CascetEvent =
  | { type: "receipt"; receipt: PaymentReceipt }
  | { type: "server-online"; server: string; tools: Array<{ name: string; priceUsd?: string }> }
  | { type: "server-offline"; server: string };

const isStr = (v: unknown): v is string => typeof v === "string";
const isOptStr = (v: unknown): boolean => v === undefined || typeof v === "string";

/**
 * Strictly validate a receipt from an untrusted source (the /ingest endpoint is
 * network-reachable). In particular `amountRaw` MUST be a plain decimal string —
 * the dashboard sums it with `BigInt(...)`, so an unvalidated value like "x"
 * would throw and crash every viewer's render.
 */
function isValidReceipt(r: unknown): r is PaymentReceipt {
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  return (
    isStr(o.id) && o.id.length > 0 && o.id.length <= 128 &&
    isStr(o.createdAt) &&
    isStr(o.network) &&
    isStr(o.server) &&
    isStr(o.tool) &&
    isStr(o.payer) &&
    isStr(o.payTo) &&
    isStr(o.amountRaw) && /^\d{1,40}$/.test(o.amountRaw) &&
    isStr(o.asset) &&
    isStr(o.assetSymbol) &&
    (o.status === "settled" || o.status === "failed") &&
    isOptStr(o.parentId) &&
    isOptStr(o.priceUsd) &&
    isOptStr(o.txHash) &&
    isOptStr(o.anchoredTxHash) &&
    (o.latencyMs === undefined || typeof o.latencyMs === "number")
  );
}

export function isCascetEvent(value: unknown): value is CascetEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type === "receipt") return isValidReceipt(v.receipt);
  if (v.type === "server-online") return isStr(v.server) && Array.isArray(v.tools);
  if (v.type === "server-offline") return isStr(v.server);
  return false;
}

import type { PaymentReceipt } from "./receipts.js";

/** Events a gateway pushes to the dashboard ingest endpoint (and over SSE to browsers). */
export type CascetEvent =
  | { type: "receipt"; receipt: PaymentReceipt }
  | { type: "server-online"; server: string; tools: Array<{ name: string; priceUsd?: string }> }
  | { type: "server-offline"; server: string };

export function isCascetEvent(value: unknown): value is CascetEvent {
  if (typeof value !== "object" || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return t === "receipt" || t === "server-online" || t === "server-offline";
}

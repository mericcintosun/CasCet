import "server-only";
import type { PaymentReceipt } from "@cascet/core";
import { CONTRACTS } from "@/lib/economy";
import { DEMO_TOKEN_PACKAGE } from "./constants";

const CSPR_CLOUD_API = process.env.CSPR_CLOUD_API ?? "https://api.testnet.cspr.cloud";
const RECEIPT_REGISTRY = CONTRACTS.receiptRegistry;

interface CloudDeploy {
  deploy_hash: string;
  timestamp: string;
  status?: string;
  error_message?: string | null;
  args?: Record<string, { parsed?: unknown }>;
}

const argStr = (a: CloudDeploy["args"], key: string): string => {
  const v = a?.[key]?.parsed;
  return v === undefined || v === null ? "" : String(v);
};

/**
 * Read every settled receipt anchored in the on-chain ReceiptRegistry.
 *
 * Odra stores contract state in an internal, hash-keyed dictionary, so the
 * receipts map can't be read directly over RPC. Instead we reconstruct each
 * receipt from the args of its `record` transaction — CSPR.cloud indexes every
 * call to the contract, and a `record` call's arguments ARE the receipt. This
 * makes the explorer genuinely on-chain-backed (not the ephemeral event store).
 */
/**
 * Records anchored on 2026-07-07 while the chain-free mock facilitator was
 * still in use: their settle hashes were never submitted, so they don't exist
 * on-chain. Hidden so every receipt shown resolves on cspr.live.
 */
const UNSETTLED_FIXTURE_IDS = new Set([
  "80703d47-4a0a-4d4f-9cfb-3bc8e2b8903d",
  "8b805540-f598-420c-8642-cdfbe571599d",
  "a7cd779c-bcd9-4497-874d-e59b1aacf8c9",
  "bbaa6fa0-a2fa-47f8-8087-88b8c659945a",
  "e05e3e02-d737-45a7-a4d5-dfc163c9ab65",
]);

const SETTLE_HASH = /^[0-9a-f]{64}$/i;

export async function readAnchoredReceipts(): Promise<PaymentReceipt[]> {
  const token = process.env.CSPR_CLOUD_TOKEN;
  if (!token) return [];

  const out: PaymentReceipt[] = [];
  let page = 1;
  let pages = 1;
  do {
    const url = `${CSPR_CLOUD_API}/deploys?contract_package_hash=${RECEIPT_REGISTRY}&page=${page}&page_size=50`;
    const res = await fetch(url, { headers: { Authorization: token }, next: { revalidate: 30 } });
    if (!res.ok) break;
    const json = (await res.json()) as { data?: CloudDeploy[]; page_count?: number };
    pages = json.page_count ?? 1;
    for (const d of json.data ?? []) {
      const paymentId = argStr(d.args, "payment_id");
      if (!paymentId) continue; // not a `record` call (init/authorize/…)
      if (d.status && d.status !== "processed") continue;
      if (d.error_message) continue;
      // Skip test fixtures: placeholder tx hashes ("demo-tx") and unsettled mock-era records.
      if (!SETTLE_HASH.test(argStr(d.args, "tx_hash")) || UNSETTLED_FIXTURE_IDS.has(paymentId)) continue;
      out.push({
        id: paymentId,
        parentId: argStr(d.args, "parent_id") || undefined,
        createdAt: d.timestamp,
        network: "casper:casper-test",
        server: argStr(d.args, "server"),
        tool: argStr(d.args, "tool"),
        payer: argStr(d.args, "payer"),
        payTo: argStr(d.args, "payee"),
        amountRaw: argStr(d.args, "amount") || "0",
        asset: DEMO_TOKEN_PACKAGE,
        assetSymbol: "WCSPR",
        txHash: argStr(d.args, "tx_hash") || undefined,
        status: "settled",
        anchoredTxHash: d.deploy_hash,
      });
    }
    page++;
  } while (page <= pages && page <= 10);

  // newest first
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

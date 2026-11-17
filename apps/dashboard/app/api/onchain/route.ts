import { ONCHAIN_NETWORK } from "@/lib/economy";
import { OnchainReadError, readAnchoredReceipts } from "@/lib/casper/receipt-registry";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

/**
 * Receipts anchored on-chain in the testnet ReceiptRegistry, reconstructed from
 * record txs. A failed read is reported as a failure (503 not configured, 502
 * upstream error, 504 timeout) with `ok: false` and an `error` message — never
 * as a 200 with an empty list, which the UI would show as a live but empty
 * economy.
 */
export async function GET(): Promise<Response> {
  try {
    const { receipts, truncated } = await readAnchoredReceipts();
    return Response.json(
      { ok: true, network: ONCHAIN_NETWORK, receipts, count: receipts.length, truncated },
      { headers: NO_STORE },
    );
  } catch (e) {
    if (e instanceof OnchainReadError) {
      console.error(`[api/onchain] ${e.code}: ${e.message}`);
      return Response.json({ ok: false, error: e.message, code: e.code }, { status: e.status, headers: NO_STORE });
    }
    console.error("[api/onchain] unexpected failure:", e);
    return Response.json(
      { ok: false, error: "failed to read the on-chain receipts", code: "internal" },
      { status: 500, headers: NO_STORE },
    );
  }
}

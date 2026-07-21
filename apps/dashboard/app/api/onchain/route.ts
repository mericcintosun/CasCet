import { readAnchoredReceipts } from "@/lib/casper/receipt-registry";

export const dynamic = "force-dynamic";

/** Receipts anchored on-chain in the ReceiptRegistry, reconstructed from record txs. */
export async function GET(): Promise<Response> {
  try {
    const receipts = await readAnchoredReceipts();
    return Response.json({ receipts, count: receipts.length });
  } catch (e) {
    return Response.json({ receipts: [], count: 0, error: (e as Error).message }, { status: 200 });
  }
}

import { CSPR_LIVE_TX } from "@/lib/casper/constants";
import { RelayRejectedError, submitSigned } from "@/lib/casper/release-tx";

export const dynamic = "force-dynamic";

/**
 * Attach the wallet signature to a prepared tx, verify it locally and submit it
 * to Casper. Client mistakes (wrong signature format, a signature that does not
 * verify, a foreign transaction) are 400s and never reach the node; a node or
 * network failure is a 502.
 */
export async function POST(req: Request): Promise<Response> {
  let body: { txJson?: unknown; signatureHex?: unknown; publicKeyHex?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { txJson, signatureHex, publicKeyHex } = body ?? {};
  if (!txJson || typeof signatureHex !== "string" || typeof publicKeyHex !== "string") {
    return Response.json({ error: "txJson, signatureHex and publicKeyHex are required" }, { status: 400 });
  }
  try {
    const txHash = await submitSigned(txJson, signatureHex, publicKeyHex);
    return Response.json({ txHash, txUrl: CSPR_LIVE_TX + txHash });
  } catch (e) {
    if (e instanceof RelayRejectedError) {
      return Response.json({ error: e.message }, { status: 400 });
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error("[revenue/submit] putTransaction failed:", message);
    return Response.json({ error: `the Casper node did not accept the transaction: ${message}` }, { status: 502 });
  }
}

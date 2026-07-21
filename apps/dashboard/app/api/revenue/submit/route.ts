import { CSPR_LIVE_TX } from "@/lib/casper/constants";
import { submitSigned } from "@/lib/casper/release-tx";

export const dynamic = "force-dynamic";

/** Attach the wallet signature to a prepared tx and submit it to Casper. */
export async function POST(req: Request): Promise<Response> {
  try {
    const { txJson, signatureHex, publicKeyHex } = (await req.json()) as {
      txJson?: unknown;
      signatureHex?: string;
      publicKeyHex?: string;
    };
    if (!txJson || !signatureHex || !publicKeyHex) {
      return Response.json({ error: "txJson, signatureHex and publicKeyHex are required" }, { status: 400 });
    }
    const txHash = await submitSigned(txJson, signatureHex, publicKeyHex);
    return Response.json({ txHash, txUrl: CSPR_LIVE_TX + txHash });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

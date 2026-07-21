import { PAYEES } from "@/lib/casper/constants";
import { buildUnsignedRelease } from "@/lib/casper/release-tx";

export const dynamic = "force-dynamic";

/** Build an unsigned `release(payee)` tx for the connected wallet to sign. */
export async function POST(req: Request): Promise<Response> {
  try {
    const { payee, publicKeyHex } = (await req.json()) as { payee?: string; publicKeyHex?: string };
    if (!payee || !publicKeyHex) {
      return Response.json({ error: "payee and publicKeyHex are required" }, { status: 400 });
    }
    if (!PAYEES.some((p) => p.accountHash === payee)) {
      return Response.json({ error: "unknown payee" }, { status: 400 });
    }
    if (!/^0[12][0-9a-fA-F]{64,66}$/.test(publicKeyHex)) {
      return Response.json({ error: "invalid public key" }, { status: 400 });
    }
    const txJson = buildUnsignedRelease(payee, publicKeyHex);
    return Response.json({ txJson });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

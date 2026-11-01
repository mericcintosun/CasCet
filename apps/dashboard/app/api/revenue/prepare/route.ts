import { PAYEES } from "@/lib/casper/constants";
import { buildUnsignedRelease } from "@/lib/casper/release-tx";

export const dynamic = "force-dynamic";

/** "01" + 32-byte ed25519 key, or "02" + 33-byte compressed secp256k1 key. */
const PUBLIC_KEY = /^(01[0-9a-fA-F]{64}|02[0-9a-fA-F]{66})$/;

/** Build an unsigned `release(payee)` tx for the connected wallet to sign. */
export async function POST(req: Request): Promise<Response> {
  let body: { payee?: unknown; publicKeyHex?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { payee, publicKeyHex } = body ?? {};
  if (typeof payee !== "string" || typeof publicKeyHex !== "string") {
    return Response.json({ error: "payee and publicKeyHex are required" }, { status: 400 });
  }
  if (!PAYEES.some((p) => p.accountHash === payee)) {
    return Response.json({ error: "unknown payee" }, { status: 400 });
  }
  if (!PUBLIC_KEY.test(publicKeyHex)) {
    return Response.json({ error: "invalid public key" }, { status: 400 });
  }
  try {
    return Response.json({ txJson: buildUnsignedRelease(payee, publicKeyHex) });
  } catch (e) {
    console.error("[revenue/prepare] could not build the release transaction:", e instanceof Error ? e.message : e);
    return Response.json({ error: "could not build the release transaction" }, { status: 500 });
  }
}

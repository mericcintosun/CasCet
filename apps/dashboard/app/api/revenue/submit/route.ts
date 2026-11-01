import { CSPR_LIVE_TX } from "@/lib/casper/constants";
import { RelayRejectedError, RelayTimeoutError, submitSigned } from "@/lib/casper/release-tx";
import { clientKey, createRateLimiter, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Per client address and server instance (L33): this route relays to the
 * Casper node, so one client may not turn it into a free RPC relay. A whole
 * server instance relays at most 60 submissions a minute.
 */
const perClient = createRateLimiter({ limit: 6, windowMs: 60_000 });
const perInstance = createRateLimiter({ limit: 60, windowMs: 60_000 });

/**
 * Attach the wallet signature to a prepared tx, verify it locally and submit it
 * to Casper. Client mistakes (wrong signature format, a signature that does not
 * verify, a foreign transaction) are 400s and never reach the node; a node or
 * network failure is a 502, and a node that does not answer in time a 504.
 */
export async function POST(req: Request): Promise<Response> {
  for (const decision of [perClient.check(clientKey(req)), perInstance.check("*")]) {
    if (!decision.ok) return tooManyRequests(decision.retryAfterSeconds);
  }
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
    if (e instanceof RelayTimeoutError) {
      console.error(`[revenue/submit] putTransaction timed out after ${e.timeoutMs} ms (tx ${e.txHash})`);
      // The node may still have taken it: hand back the hash so the client looks it up instead of paying twice.
      return Response.json(
        {
          error: `${e.message}. The transaction may still have been accepted: open it on cspr.live before you try again.`,
          txHash: e.txHash,
          txUrl: CSPR_LIVE_TX + e.txHash,
        },
        { status: 504 },
      );
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error("[revenue/submit] putTransaction failed:", message);
    return Response.json({ error: `the Casper node did not accept the transaction: ${message}` }, { status: 502 });
  }
}

import { isCascetEvent } from "@cascet/core";
import { ingest } from "@/lib/store";
import { BodyTooLargeError, checkIngestAuth, readBodyCapped } from "@/lib/ingest-auth";

export const dynamic = "force-dynamic";

/** A receipt event is well under 4 KB; anything near this cap is not a gateway. */
const MAX_BODY_BYTES = 64 * 1024;

let warnedUnconfigured = false;

/**
 * Only trusted gateways may push events. Fails closed: CASCET_INGEST_TOKEN must
 * be set on this deployment and the request must send
 * `Authorization: Bearer <token>` (gateways do when the same variable is set in
 * their environment). Without a token every request is rejected, so a public
 * /ingest can never be used to poison the displayed economy.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = checkIngestAuth(request.headers.get("authorization"), process.env.CASCET_INGEST_TOKEN);
  if (!auth.ok) {
    if (auth.reason === "not_configured" && !warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn("[api/ingest] CASCET_INGEST_TOKEN is not set: every ingest request is rejected (401)");
    }
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
  }

  let text: string;
  try {
    text = await readBodyCapped(request, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return Response.json({ error: "payload too large" }, { status: 413 });
    return Response.json({ error: "could not read the request body" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!isCascetEvent(body)) {
    return Response.json({ error: "not a valid CasCet event" }, { status: 422 });
  }
  ingest(body);
  return Response.json({ ok: true });
}

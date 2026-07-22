import { isCascetEvent } from "@cascet/core";
import { ingest } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Only trusted gateways may push events. If CASCET_INGEST_TOKEN is set, require
 * a matching bearer token; otherwise accept only loopback (local dev). A public
 * deployment MUST set CASCET_INGEST_TOKEN — without it, a public /ingest lets
 * anyone poison the displayed economy.
 */
function authorized(request: Request): boolean {
  const token = process.env.CASCET_INGEST_TOKEN;
  if (token) return request.headers.get("authorization") === `Bearer ${token}`;
  const host = request.headers.get("host") ?? "";
  return /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host);
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!isCascetEvent(body)) {
    return Response.json({ error: "not a valid CasCet event" }, { status: 422 });
  }
  ingest(body);
  return Response.json({ ok: true });
}

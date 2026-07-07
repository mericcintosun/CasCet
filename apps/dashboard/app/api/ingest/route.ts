import { isCascetEvent } from "@cascet/core";
import { ingest } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!isCascetEvent(body)) {
    return Response.json({ error: "not a CasCet event" }, { status: 422 });
  }
  ingest(body);
  return Response.json({ ok: true });
}

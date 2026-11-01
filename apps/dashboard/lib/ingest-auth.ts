import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Authorization for POST /api/ingest (the endpoint gateways push receipt
 * events to). It FAILS CLOSED: without CASCET_INGEST_TOKEN nobody may push, and
 * with it the request must carry exactly `Authorization: Bearer <token>`.
 * There is no loopback fallback any more: it trusted the client-controlled
 * Host header (L32). Gateways already send this header when the same
 * CASCET_INGEST_TOKEN is set in their environment.
 */
export type IngestAuth = { ok: true } | { ok: false; reason: "not_configured" | "missing" | "mismatch" };

/** Constant-time comparison: both sides are hashed first, so length differences don't leak either. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function checkIngestAuth(authorization: string | null, configuredToken: string | undefined): IngestAuth {
  if (!configuredToken || !configuredToken.trim()) return { ok: false, reason: "not_configured" };
  if (!authorization) return { ok: false, reason: "missing" };
  return safeEqual(authorization, `Bearer ${configuredToken}`) ? { ok: true } : { ok: false, reason: "mismatch" };
}

export class BodyTooLargeError extends Error {
  override name = "BodyTooLargeError";
}

/** Read a request body as text, aborting as soon as it exceeds `maxBytes` (also for chunked bodies without Content-Length). */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError(`body over ${maxBytes} bytes`);
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(`body over ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

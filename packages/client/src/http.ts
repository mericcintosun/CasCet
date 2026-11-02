import { HEADER_PAYMENT_REQUIRED, HEADER_PAYMENT_RESPONSE } from "@cascet/core";

/** A fetch-compatible function. */
export type FetchLike = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;

/** Default deadline for one request to a gateway, including a paid retry (ms). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default cap on the size of a gateway response body (bytes). */
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const MAX_TIMER_MS = 2_147_483_647;

/** Thrown when a request to a gateway does not complete before its deadline. */
export class RequestTimeoutError extends Error {
  override name = "RequestTimeoutError";
}

/** Thrown when a gateway response body is larger than the configured cap. */
export class ResponseTooLargeError extends Error {
  override name = "ResponseTooLargeError";
}

/** True for our own timeout error and for the DOMException a timed-out AbortSignal produces. */
export function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof RequestTimeoutError ||
    (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "TimeoutError")
  );
}

/** Validate a timeout option: a positive whole number of milliseconds. */
export function validateTimeoutMs(value: unknown, label = "timeoutMs"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new Error(`${label} must be a whole number of milliseconds between 1 and ${MAX_TIMER_MS}; got ${String(value)}`);
  }
  return value;
}

/** Validate a byte-size limit option. */
export function validateByteLimit(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive whole number of bytes; got ${String(value)}`);
  }
  return value;
}

/** An AbortSignal that aborts as soon as any of `signals` does. */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/**
 * Bound every call of `fetchImpl` by a deadline of `timeoutMs`, combined with
 * any signal the caller passed. The deadline also covers reading the body,
 * since the signal stays attached to the response stream.
 */
export function withDeadline(fetchImpl: FetchLike, timeoutMs: number): FetchLike {
  return async (input, init) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = callerSignal ? anySignal([callerSignal, deadline]) : deadline;
    try {
      return await fetchImpl(input, { ...init, signal });
    } catch (err) {
      if (deadline.aborted && !callerSignal?.aborted && !(err instanceof RequestTimeoutError)) {
        throw new RequestTimeoutError(`request to ${urlOf(input)} timed out after ${timeoutMs} ms`, { cause: err });
      }
      throw err;
    }
  };
}

/** Read a response body as text, refusing bodies larger than `maxBytes`. `what` names the body in errors. */
export async function readTextCapped(response: Response, maxBytes: number, what = "gateway response"): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(`${what} is ${declared} bytes, above the ${maxBytes}-byte limit`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(`${what} exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Best-effort reason for a failed payment, read from the x402 headers of a 402
 * (`PAYMENT-REQUIRED.error`) or of a settlement response (`PAYMENT-RESPONSE.errorReason`).
 */
export function paymentFailureReason(headers: Headers): string | undefined {
  for (const [name, field] of [
    [HEADER_PAYMENT_RESPONSE, "errorReason"],
    [HEADER_PAYMENT_REQUIRED, "error"],
  ] as const) {
    const decoded = decodeBase64Json(headers.get(name));
    const value = decoded?.[field];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 300);
  }
  return undefined;
}

/** Decode a base64-encoded JSON object header (as x402 v2 uses), or undefined. */
export function decodeBase64Json(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Encode a JSON object as a base64 header value (as x402 v2 uses); the inverse of {@link decodeBase64Json}. */
export function encodeBase64Json(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/**
 * Human-readable message of an unknown error. Node's fetch reports network
 * failures as a bare `TypeError: fetch failed` with the real reason in `cause`,
 * so that cause is appended.
 */
export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (err.name === "TypeError" && cause instanceof Error && cause.message && !err.message.includes(cause.message)) {
    return `${err.message} (${cause.message})`;
  }
  return err.message;
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

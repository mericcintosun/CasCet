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
 * `promise`, or a rejection with the signal's reason as soon as `signal`
 * aborts, whichever comes first. A fetch follows its Request's signal through
 * weak references (undici's Request follows its parent signal through a
 * WeakRef to its own controller), so a garbage collection that collects an
 * intermediate Request cuts the chain: the request never sees the abort and
 * runs until the server gives up. Settling on the signal itself hands control
 * back at the deadline either way; a Response that arrives after the abort has
 * its body cancelled.
 */
export function settleOnAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted && value instanceof Response) void value.body?.cancel().catch(() => undefined);
        resolve(value);
      },
      err => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** A deadline joined with a caller's signal; see {@link startDeadline}. */
export interface Deadline {
  /** Aborts when the deadline passes (with the timeout error) or the caller's signal aborts (with its reason). */
  readonly signal: AbortSignal;
  /** True once the deadline itself has passed. */
  readonly expired: boolean;
  /** Stop the timer, once the call (its body included) is over. */
  clear(): void;
}

/**
 * A deadline of `timeoutMs` joined with `callerSignal`, aborting with
 * `timeoutError()`. Its timer holds the deadline and the joined signal until
 * it fires or is cleared. The timer of AbortSignal.timeout() holds its signal
 * only weakly, and on Node 22 and 23 AbortSignal.any() does not keep it either,
 * so once the frame that created it returned, a garbage collection could make
 * the deadline never fire. Like AbortSignal.timeout()'s, the timer is unref'd.
 */
export function startDeadline(timeoutMs: number, callerSignal: AbortSignal | undefined, timeoutError: () => Error): Deadline {
  const deadline = new AbortController();
  const signal = callerSignal ? anySignal([callerSignal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => {
    if (!signal.aborted) deadline.abort(timeoutError());
  }, timeoutMs);
  timer.unref();
  return {
    signal,
    get expired() {
      return deadline.signal.aborted;
    },
    clear: () => clearTimeout(timer),
  };
}

/**
 * `response`, with a body that ends when `signal` aborts: the read in progress
 * fails with the signal's reason, and the body is cancelled at its source,
 * which closes the connection. The signal alone may never reach the body: on
 * Node 22 and 23, undici's fetch can stop following it once the headers are
 * in (a garbage collection takes the Request it built, the only link from the
 * signal to the request), and a fetch can lose it in other ways too (see
 * {@link settleOnAbort}). The body would then be read for as long as the
 * server keeps the connection open. `done` runs once, when the body has been
 * read, has failed or was cancelled, or when `signal` aborted.
 */
export function bindBody(response: Response, signal: AbortSignal, done: () => void = () => undefined): Response {
  const source = response.body;
  if (!source || source.locked) {
    done();
    return response;
  }
  let finished = false;
  let control: ReadableStreamDefaultController<Uint8Array> | undefined;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    signal.removeEventListener("abort", onAbort);
    done();
  };
  const onAbort = (): void => {
    if (finished) return;
    control?.error(signal.reason);
    void reader.cancel(signal.reason).catch(() => undefined);
    finish();
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start: controller => {
        control = controller;
      },
      pull: async controller => {
        const chunk = await reader.read().catch((err: unknown) => {
          finish();
          throw err;
        });
        if (finished) return; // aborted meanwhile: the stream is already errored
        if (chunk.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      },
      cancel: reason => {
        finish();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  let bound: Response;
  try {
    bound = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch {
    // A status text the Response constructor refuses (it takes no character above U+00FF).
    bound = new Response(body, { status: response.status, headers: response.headers });
  }
  // Locked before returning: nothing refers to `response` from here on, and undici cancels the body
  // of a Response that is collected while its body is still unlocked.
  const reader = source.getReader();
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return bound;
}

/**
 * Bound every call of `fetchImpl` by a deadline of `timeoutMs`, combined with
 * any signal the caller passed. The deadline also covers reading the body
 * (see {@link bindBody}), and it ends the call even when `fetchImpl` loses the
 * abort (see {@link settleOnAbort}).
 */
export function withDeadline(fetchImpl: FetchLike, timeoutMs: number): FetchLike {
  return async (input, init) => {
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const timedOut = `request to ${urlOf(input)} timed out after ${timeoutMs} ms`;
    const deadline = startDeadline(timeoutMs, callerSignal ?? undefined, () => new RequestTimeoutError(timedOut));
    const { signal } = deadline;
    try {
      return bindBody(await settleOnAbort(fetchImpl(input, { ...init, signal }), signal), signal, deadline.clear);
    } catch (err) {
      deadline.clear();
      if (deadline.expired && !callerSignal?.aborted && !(err instanceof RequestTimeoutError)) {
        throw new RequestTimeoutError(timedOut, { cause: err });
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

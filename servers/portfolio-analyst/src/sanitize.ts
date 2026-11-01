import { randomUUID } from "node:crypto";

/**
 * What the analyst tells its caller about failures.
 *
 * Raw errors from the paying fetch, the MCP client or the data gateway carry
 * stack traces, internal URLs, file paths, full x402 payment requirements and
 * the downstream server's own error text. None of that may reach the caller
 * (the gateway relays tool results verbatim to the paying buyer). A failed
 * purchase is therefore reported with one of the fixed reasons below, and the
 * raw error is written to the operator's log (stderr) only.
 */
export const REASONS = {
  cancelled: "cancelled: the analysis request was aborted",
  timedOut: "timed out",
  policy: "refused by the analyst's payment policy",
  paymentFailed: "payment could not be created",
  paymentRejected: "the data provider did not accept the payment",
  providerError: "the data provider reported an error",
  unreachable: "the data provider is unreachable",
  malformed: "the data provider returned malformed data",
  failed: "purchase failed",
} as const;

/** undici / Node socket failures: the data gateway could not be reached at all. */
const NETWORK_ERROR =
  /fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|UND_ERR/i;

/** "the data provider answered HTTP 503" — the status is the only dynamic part, and it is 3 digits. */
function httpReason(status: string): string {
  return `the data provider answered HTTP ${status}`;
}

/** A purchase failure whose `reason` is already safe to show the caller. */
export class PurchaseFailure extends Error {
  /** Payment id of the purchase when it was paid before failing (e.g. its data was unusable). */
  paymentId?: string;

  constructor(
    readonly reason: string,
    options?: { cause?: unknown; paymentId?: string },
  ) {
    super(reason, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PurchaseFailure";
    this.paymentId = options?.paymentId;
  }
}

/**
 * Map any error thrown while buying one data item to a caller-safe reason.
 *
 * `signal` aborts every purchase (inbound cancellation + local deadline);
 * `cancelled` is the inbound request's own signal, so a cancelled analysis and
 * one that ran out of time are told apart. Classify at the moment the purchase
 * fails, not later, so an unrelated earlier failure is not relabelled.
 */
export function classifyPurchaseError(err: unknown, ctx: { signal: AbortSignal; cancelled: AbortSignal }): string {
  if (err instanceof PurchaseFailure) return err.reason;
  if (ctx.signal.aborted) return ctx.cancelled.aborted ? REASONS.cancelled : REASONS.timedOut;
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") return REASONS.timedOut;

  const text = errorText(err);
  if (/Payment creation aborted|analyst payment policy|No network\/scheme registered|filtered out by policies/i.test(text)) {
    return REASONS.policy;
  }
  if (/Failed to create payment payload|Failed to parse payment requirements|Payment already attempted/i.test(text)) {
    return REASONS.paymentFailed;
  }
  const status = /MCP request [\w/]+ failed: HTTP (\d{3})\b/.exec(text)?.[1];
  if (status) return status === "402" ? REASONS.paymentRejected : httpReason(status);
  if (/MCP [\w/]+ error -?\d+/.test(text)) return REASONS.providerError;
  if (NETWORK_ERROR.test(text)) return REASONS.unreachable;
  if (err instanceof SyntaxError) return REASONS.malformed;
  return REASONS.failed;
}

/** Full error text (message, code and the cause chain) for classification and the operator log. */
export function errorText(err: unknown, depth = 0): string {
  if (depth > 4) return "";
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const own = `${err.name}: ${err.message}${typeof code === "string" ? ` [${code}]` : ""}`;
    const cause = err.cause === undefined ? "" : ` <- ${errorText(err.cause, depth + 1)}`;
    return own + cause;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}

/** Operator-log rendering of an error: the stack when there is one, else the text. */
export function describeError(err: unknown): string {
  if (err instanceof Error && err.stack) {
    return err.cause === undefined ? err.stack : `${err.stack}\n  caused by: ${errorText(err.cause)}`;
  }
  return errorText(err);
}

/** A tool error result with caller-safe text. */
export function errorResult(text: string) {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

/**
 * Unexpected failure: log everything under a short reference and return only
 * the reference, so the operator can find the details without exposing them.
 */
export function internalErrorResult(err: unknown, log: (line: string) => void) {
  const ref = randomUUID().slice(0, 8);
  log(`internal error (ref ${ref}): ${describeError(err)}`);
  return errorResult(`analysis failed: internal error (ref ${ref})`);
}

// Written with escapes only: literal invisible or bidi characters in source are a Trojan Source risk.
// Cc control, Cf format (bidi overrides, zero-width, tag characters), Cs lone surrogates,
// Co private use, Cn unassigned, Zl/Zp line and paragraph separators.
const INVISIBLE_OR_CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu;

/**
 * Text bought from the data provider (venue names, provenance labels) is
 * echoed to the analyst's caller: strip control and bidi characters, collapse
 * whitespace and cap the length so a hostile provider cannot smuggle long or
 * invisible content into the analysis.
 */
export function cleanProviderText(value: string, maxLength: number): string {
  const flat = value.replace(INVISIBLE_OR_CONTROL, " ").replace(/\s+/g, " ").trim();
  // Count and cut by code point, so truncation never leaves half a surrogate pair behind.
  const chars = Array.from(flat);
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join("")}…` : flat;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** CasCet payment ids are UUIDs minted by the gateway; anything else is dropped. */
export function isPaymentId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

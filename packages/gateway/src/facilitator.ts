import type { FacilitatorClient } from "@x402/core/server";
import {
  FacilitatorResponseError,
  SettleError,
  VerifyError,
  type Network,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type SupportedResponse,
  type VerifyResponse,
} from "@x402/core/types";

/**
 * The facilitator may or may not have submitted the transfer: the request
 * timed out, the connection broke, or the answer was not a valid settle
 * response. Extends FacilitatorResponseError so x402's processSettlement
 * rethrows it instead of turning it into an ordinary (determinate) failure.
 */
export class SettlementIndeterminateError extends FacilitatorResponseError {
  constructor(message: string) {
    super(message);
    this.name = "SettlementIndeterminateError";
  }
}

export interface FacilitatorClientOptions {
  url: string;
  /** Sent verbatim as the Authorization header on every facilitator call. */
  authorization?: string;
  /** Timeout of /verify and /supported calls. */
  verifyTimeoutMs: number;
  /** Timeout of /settle calls. */
  settleTimeoutMs: number;
  fetchImpl?: typeof fetch;
}

const SUPPORTED_ATTEMPTS = 3;

/**
 * x402 facilitator client with timeouts.
 *
 * Same wire protocol as @x402/core's HTTPFacilitatorClient, but every call is
 * bounded by an AbortSignal and settle failures are classified: an explicit
 * `success: false` (or an HTTP 4xx) is a determinate failure, while a timeout,
 * a network error, an HTTP 5xx without a settle verdict, or an unparseable
 * answer raises SettlementIndeterminateError, because the transfer may already
 * be on its way to the chain.
 */
export class TimeoutFacilitatorClient implements FacilitatorClient {
  readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: FacilitatorClientOptions) {
    this.url = opts.url.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getSupported(): Promise<SupportedResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < SUPPORTED_ATTEMPTS; attempt++) {
      let response: Response;
      let text: string;
      try {
        ({ response, text } = await this.call("GET", "supported", undefined, this.opts.verifyTimeoutMs));
      } catch (err) {
        throw new Error(`facilitator /supported failed: ${describeFetchError(err, this.opts.verifyTimeoutMs)}`);
      }
      if (response.ok) {
        const data = parseJson(text) as Partial<SupportedResponse> | undefined;
        if (!data || !Array.isArray(data.kinds)) {
          throw new Error(`facilitator /supported returned an invalid answer: ${excerpt(text)}`);
        }
        return {
          kinds: data.kinds,
          extensions: Array.isArray(data.extensions) ? data.extensions : [],
          signers: typeof data.signers === "object" && data.signers !== null ? data.signers : {},
        };
      }
      lastError = new Error(`facilitator /supported failed with HTTP ${response.status}: ${excerpt(text)}`);
      if (response.status !== 429 || attempt === SUPPORTED_ATTEMPTS - 1) break;
      await new Promise(resolve => setTimeout(resolve, 1_000 * 2 ** attempt));
    }
    throw lastError instanceof Error ? lastError : new Error("facilitator /supported failed");
  }

  /**
   * Verify. Every failure here is harmless (nothing moves on-chain), so errors
   * are plain Errors, which x402 turns into a 402 "payment rejected" answer.
   */
  async verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    let response: Response;
    let text: string;
    try {
      ({ response, text } = await this.call(
        "POST",
        "verify",
        requestBody(paymentPayload, paymentRequirements),
        this.opts.verifyTimeoutMs,
      ));
    } catch (err) {
      throw new Error(`facilitator verify failed: ${describeFetchError(err, this.opts.verifyTimeoutMs)}`);
    }
    const data = parseJson(text) as Record<string, unknown> | undefined;
    if (!response.ok) {
      if (data && typeof data.isValid === "boolean") throw new VerifyError(response.status, toVerifyResponse(data));
      throw new Error(`facilitator verify failed with HTTP ${response.status}: ${excerpt(text)}`);
    }
    if (!data || typeof data.isValid !== "boolean") {
      throw new Error(`facilitator verify returned an invalid answer: ${excerpt(text)}`);
    }
    return toVerifyResponse(data);
  }

  async settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    let response: Response;
    let text: string;
    try {
      ({ response, text } = await this.call(
        "POST",
        "settle",
        requestBody(paymentPayload, paymentRequirements),
        this.opts.settleTimeoutMs,
      ));
    } catch (err) {
      throw new SettlementIndeterminateError(
        `facilitator settle ${describeFetchError(err, this.opts.settleTimeoutMs)}; the transfer may still execute`,
      );
    }
    const data = parseJson(text) as Record<string, unknown> | undefined;
    if (!response.ok) {
      if (data && typeof data.success === "boolean") {
        throw new SettleError(response.status, toSettleResponse(data, paymentRequirements.network));
      }
      if (response.status >= 400 && response.status < 500) {
        // The facilitator refused the request itself: nothing was submitted.
        throw new SettleError(response.status, {
          success: false,
          errorReason: `facilitator_http_${response.status}`,
          errorMessage: excerpt(text),
          transaction: "",
          network: paymentRequirements.network,
        });
      }
      throw new SettlementIndeterminateError(
        `facilitator settle failed with HTTP ${response.status} and no settle verdict (${excerpt(text)}); the transfer may still execute`,
      );
    }
    if (!data || typeof data.success !== "boolean" || typeof data.transaction !== "string") {
      throw new SettlementIndeterminateError(`facilitator settle returned an invalid answer: ${excerpt(text)}`);
    }
    return toSettleResponse(data, paymentRequirements.network);
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    body: string | undefined,
    timeoutMs: number,
  ): Promise<{ response: Response; text: string }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.authorization) headers.authorization = this.opts.authorization;
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await this.fetchImpl(`${this.url}/${path}`, { method, headers, body, signal, redirect: "follow" });
    // The same signal bounds reading the body.
    const text = await response.text();
    return { response, text };
  }
}

function requestBody(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): string {
  return JSON.stringify(
    { x402Version: paymentPayload.x402Version, paymentPayload, paymentRequirements },
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function toVerifyResponse(data: Record<string, unknown>): VerifyResponse {
  return {
    isValid: data.isValid === true,
    invalidReason: optStr(data.invalidReason),
    invalidMessage: optStr(data.invalidMessage),
    payer: optStr(data.payer),
    extensions: optRecord(data.extensions),
    extra: optRecord(data.extra),
  };
}

function toSettleResponse(data: Record<string, unknown>, network: Network): SettleResponse {
  return {
    success: data.success === true,
    errorReason: optStr(data.errorReason),
    errorMessage: optStr(data.errorMessage),
    payer: optStr(data.payer),
    transaction: optStr(data.transaction) ?? "",
    network: (optStr(data.network) as Network | undefined) ?? network,
    amount: optStr(data.amount),
    extensions: optRecord(data.extensions),
    extra: optRecord(data.extra),
  };
}

function describeFetchError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return `timed out after ${timeoutMs} ms`;
  }
  const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
  return `request failed: ${err instanceof Error ? err.message : String(err)}${cause}`;
}

function excerpt(text: string, max = 200): string {
  const compact = text.trim().replace(/\s+/g, " ");
  if (!compact) return "<empty response>";
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

/** How a settle that the facilitator reported as unsuccessful should be recorded. */
export interface SettleFailureClass {
  /** "failed": the transfer did not and will not execute. "unknown": it may still execute. */
  kind: "failed" | "unknown";
  /**
   * Whether an on-chain look-up can sharpen the verdict: the authorization may
   * have been executed (by this facilitator or by someone else) or its nonce
   * consumed in another way.
   */
  checkChain: boolean;
}

// Reasons @make-software/casper-x402 returns before anything is submitted.
const CASPER_PRE_SUBMISSION = /^invalid_exact_casper_facilitator_(?!settle_failed$)/;
const CASPER_SETTLE_FAILED = "invalid_exact_casper_facilitator_settle_failed";
// The transfer was submitted and then reverted: final.
const REVERTED = /^transaction execution failed/i;
// Transport-level trouble while the facilitator talked to the chain: the transfer may
// still execute. Deliberately no bare words like "network" or "unknown", which also
// appear in definite rejections (unsupported_network, invalid_network, unknown_asset).
const INDETERMINATE_HINT =
  /timed?[\s_-]?out|timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|fetch failed|network error|pending|indeterminate/i;

/**
 * Classify an unsuccessful settle answer.
 *
 * - A transaction hash in the answer means the transfer was submitted, so
 *   unless it reverted ("transaction execution failed") it may still execute:
 *   unknown.
 * - casper-x402 1.0.0 reports every problem after it built the transaction as
 *   `invalid_exact_casper_facilitator_settle_failed` (and drops the hash);
 *   only "transaction execution failed" means the transfer reverted on-chain.
 *   Anything else under that reason (RPC errors while submitting or polling,
 *   "Timed out waiting for transaction") can hide a transfer that still
 *   executes, so it is unknown.
 * - Other answers are definite failures unless they name transport trouble.
 */
export function classifySettleFailure(
  errorReason: string | undefined,
  errorMessage: string | undefined,
  transaction?: string,
): SettleFailureClass {
  const reason = errorReason ?? "";
  const message = errorMessage ?? "";
  const reverted = REVERTED.test(message);
  if (/^facilitator_http_4\d\d$/.test(reason)) return { kind: "failed", checkChain: false };
  if (transaction && !reverted) return { kind: "unknown", checkChain: true };
  if (CASPER_PRE_SUBMISSION.test(reason)) return { kind: "failed", checkChain: false };
  if (reason === CASPER_SETTLE_FAILED) return reverted ? { kind: "failed", checkChain: true } : { kind: "unknown", checkChain: true };
  if (INDETERMINATE_HINT.test(reason) || INDETERMINATE_HINT.test(message)) return { kind: "unknown", checkChain: true };
  return { kind: "failed", checkChain: true };
}

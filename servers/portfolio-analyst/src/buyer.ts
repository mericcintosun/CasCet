import { createPayingFetch, PaidMcpHttpClient } from "@cascet/client";
import type { DataBuyer } from "./analysis.js";
import type { AnalystConfig } from "./config.js";
import { minRaw } from "./spend-ledger.js";

export type FetchLike = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;

export interface BuyerContext {
  /** Payment id of the inbound call; forwarded as X-CASCET-PARENT-ID on every purchase. */
  parentId?: string;
  /** Aborts every purchase of this analysis (inbound cancellation + purchase deadline). */
  signal: AbortSignal;
  /**
   * Session budget (per asset, raw units) of this analysis' paying fetch, as
   * reserved against CASCET_MAX_TOTAL. The tighter of it and CASCET_MAX_SESSION applies.
   */
  maxSessionRaw?: string;
  log: (line: string) => void;
}

/**
 * Thread the analysis' abort signal into every request of `fetchImpl` (M06).
 *
 * PaidMcpHttpClient and the paying fetch in @cascet/client take no signal of
 * their own yet, so the analyst owns the signal and passes it through the
 * fetch it hands to the client. The paying fetch builds its Requests from this
 * init, so the unpaid probe and the paid retry both carry it: once the signal
 * is aborted no request starts, an in-flight request is aborted, and a payment
 * signed in the meantime is never sent (fetch rejects an aborted Request before
 * it touches the network). A signal the caller already set is kept as well.
 */
export function withAbortSignal(fetchImpl: FetchLike, signal: AbortSignal): FetchLike {
  return (input, init) => {
    if (signal.aborted) return Promise.reject(signal.reason);
    const own = init?.signal;
    return fetchImpl(input, { ...init, signal: own ? AbortSignal.any([own, signal]) : signal });
  };
}

/**
 * Logs each payment the paying fetch signed.
 *
 * @cascet/client calls `onPayment` after signing and only logs what it
 * throws, so this hook cannot refuse a payment. What the analyst may pay goes
 * to createPayingFetch instead: CASCET_NETWORK as `networks`, the allowlists
 * and the budget. An aborted analysis sends no signed payment: withAbortSignal
 * makes fetch reject the paid retry before it reaches the network.
 */
export function paymentLog(log: (line: string) => void) {
  return (info: { amountRaw: string; payTo: string; network: string }): void => {
    log(`💸 buying data: ${info.amountRaw} raw → ${info.payTo.slice(0, 10)}… on ${info.network}`);
  };
}

/**
 * The production buyer: the analyst's own wallet behind a paying fetch with
 * explicit allowlists, network list and budget. One buyer per inbound call,
 * because the cascade parent id is per call; CASCET_MAX_SESSION therefore caps
 * what ONE analysis may spend, and the server's spend ledger enforces
 * CASCET_MAX_TOTAL across analyses.
 *
 * Each purchase may take as long as CASCET_TIMEOUT_MS: the paying fetch and
 * the MCP client get it as their own deadline, which is otherwise the
 * client's 30 s. A paid purchase cut off earlier would still settle, and its
 * data would be lost. The analysis signal still ends every purchase at the
 * analysis deadline.
 */
export async function createDataBuyer(cfg: AnalystConfig, ctx: BuyerContext): Promise<DataBuyer> {
  const sessionCap = minRaw(optionalRaw(cfg.maxSessionRaw), optionalRaw(ctx.maxSessionRaw));
  const paying = await createPayingFetch({
    privateKeyPath: cfg.keyPath,
    keyAlgorithm: cfg.keyAlgorithm,
    networks: [...cfg.networks],
    allowedPayTo: clientAllowedPayTo(cfg.allowedPayTo),
    allowedAssets: cfg.allowedAssets,
    budget: { maxPerCallRaw: cfg.maxPerCallRaw, maxSessionRaw: sessionCap?.toString() },
    parentId: ctx.parentId,
    onPayment: paymentLog(ctx.log),
    timeoutMs: cfg.timeoutMs,
  });
  const client = new PaidMcpHttpClient(cfg.dataGatewayUrl, withAbortSignal(paying.fetch, ctx.signal), {
    timeoutMs: cfg.timeoutMs,
  });
  return {
    callTool: (name, args) => client.callTool(name, args),
    spentRaw: () => paying.spentRaw(),
  };
}

/**
 * The payTo allowlist as @cascet/client expects it. The analyst config only
 * admits account hashes ("00" + 64 hex), which the client takes as they are;
 * contract-package payees are refused on both sides (casper-x402 1.0.0 cannot
 * settle to them).
 */
export function clientAllowedPayTo(entries: readonly string[] | undefined): string[] | undefined {
  return entries === undefined ? undefined : [...entries];
}

function optionalRaw(value: string | undefined): bigint | undefined {
  return value === undefined ? undefined : BigInt(value);
}

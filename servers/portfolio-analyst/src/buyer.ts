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

/** Marks a payment the analyst vetoed itself (see paymentGuard). */
export const POLICY_PREFIX = "analyst payment policy:";

/**
 * Last check before the paying fetch signs a payment.
 *
 * @cascet/client calls `onPayment` from its before-payment hook, after its own
 * payTo/asset allowlist and budget checks and BEFORE the scheme signs; an
 * exception thrown there aborts the payment. The analyst uses it to enforce
 * CASCET_NETWORK (the client takes no network list yet and would pay on any
 * casper:* network a 402 names) and to refuse to sign once the analysis has
 * been aborted.
 */
export function paymentGuard(opts: { networks: readonly string[]; signal: AbortSignal; log: (line: string) => void }) {
  return (info: { amountRaw: string; payTo: string; network: string }): void => {
    if (opts.signal.aborted) throw new Error(`${POLICY_PREFIX} the analysis was aborted, not paying`);
    if (!opts.networks.includes(info.network)) {
      throw new Error(`${POLICY_PREFIX} network ${info.network} is not in CASCET_NETWORK`);
    }
    opts.log(`💸 buying data: ${info.amountRaw} raw → ${info.payTo.slice(0, 10)}… on ${info.network}`);
  };
}

/**
 * The production buyer: the analyst's own wallet behind a paying fetch with
 * explicit allowlists, network list and budget. One buyer per inbound call,
 * because the cascade parent id is per call; CASCET_MAX_SESSION therefore caps
 * what ONE analysis may spend, and the server's spend ledger enforces
 * CASCET_MAX_TOTAL across analyses.
 */
export async function createDataBuyer(cfg: AnalystConfig, ctx: BuyerContext): Promise<DataBuyer> {
  const sessionCap = minRaw(optionalRaw(cfg.maxSessionRaw), optionalRaw(ctx.maxSessionRaw));
  const paying = await createPayingFetch({
    privateKeyPath: cfg.keyPath,
    keyAlgorithm: cfg.keyAlgorithm,
    allowedPayTo: cfg.allowedPayTo,
    allowedAssets: cfg.allowedAssets,
    budget: { maxPerCallRaw: cfg.maxPerCallRaw, maxSessionRaw: sessionCap?.toString() },
    parentId: ctx.parentId,
    onPayment: paymentGuard({ networks: cfg.networks, signal: ctx.signal, log: ctx.log }),
  });
  const client = new PaidMcpHttpClient(cfg.dataGatewayUrl, withAbortSignal(paying.fetch, ctx.signal));
  return {
    callTool: (name, args) => client.callTool(name, args),
    spentRaw: () => paying.spentRaw(),
  };
}

function optionalRaw(value: string | undefined): bigint | undefined {
  return value === undefined ? undefined : BigInt(value);
}

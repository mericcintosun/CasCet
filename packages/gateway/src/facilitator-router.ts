import type { FacilitatorClient } from "@x402/core/server";
import {
  FacilitatorResponseError,
  SettleError,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type SupportedKind,
  type SupportedResponse,
  type VerifyResponse,
} from "@x402/core/types";
import { deepEqual } from "@x402/core/utils";
import { normalizePackageHash } from "@cascet/core";
import { SettlementIndeterminateError } from "./facilitator.js";

/** One accepted token and the facilitator that verifies and settles payments in it. */
export interface AssetRoute {
  /** CAIP-2 network the token lives on. */
  network: string;
  /** Token contract package hash, in any common spelling. */
  asset: string;
  /** The facilitator for payments in this token. Several tokens may share one. */
  facilitator: FacilitatorClient;
  /** How messages name the facilitator, e.g. `facilitator "default" (https://…)`. Never a credential. */
  label: string;
  /**
   * The facilitator's settle timeout, in milliseconds. x402 settles a second
   * time when a facilitator reports a settlement as pending; with this set,
   * both calls together get this long (see {@link AssetRoutingFacilitatorClient.settle}),
   * so x402's retry never doubles how long a paid call can take.
   */
  settleTimeoutMs?: number;
}

export interface AssetRoutingOptions {
  /** Clock in milliseconds (tests). Default Date.now. */
  now?: () => number;
  /** Most pending settlements remembered at once (default 10 000); the oldest is forgotten first. */
  maxPendingSettlements?: number;
}

/**
 * Why the gateway cannot take the payments of `route` that its facilitator
 * describes with `kind` (one kind of the facilitator's own /supported answer,
 * which lists `extensions`), or undefined when it can. The reason is the whole
 * message: it names the facilitator and the asset itself.
 */
export type SupportedKindCheck = (route: AssetRoute, kind: SupportedKind, extensions: readonly string[]) => string | undefined;

/** The `errorReason` of a settlement that was broadcast and whose outcome is not known yet. */
export const SETTLEMENT_PENDING = "settlement_pending";

/** How long after the authorization's validBefore a pending settlement is remembered. */
const PENDING_MEMORY_MARGIN_MS = 120_000;
const DEFAULT_MAX_PENDING_SETTLEMENTS = 10_000;

/** A settlement a facilitator reported as pending: its transfer was broadcast, its outcome is unknown. */
interface PendingSettlement {
  /** Hash of the broadcast transfer. */
  transaction: string;
  payer?: string;
  /** When the first settle call for this payment started (ms). */
  startedAt: number;
  /** When the entry may be forgotten (ms). */
  expiresAt: number;
}

/**
 * A payment in a token that no facilitator is configured for. Raised before
 * any facilitator is contacted, so nothing can have moved on-chain.
 */
export class UnroutedAssetError extends Error {
  constructor(
    readonly network: string,
    readonly asset: string,
  ) {
    super(`no facilitator is configured for asset ${asset} on ${network}; the payment was refused`);
    this.name = "UnroutedAssetError";
  }
}

const routeKey = (network: string, asset: string): string => `${network}|${normalizePackageHash(asset)}`;

/**
 * The facilitator client of a gateway that accepts several tokens.
 *
 * x402's resource server picks a facilitator by (x402 version, network,
 * scheme) only. Every Casper token is paid with the "exact" scheme on the same
 * network, so it cannot tell the facilitator of one token from another's: the
 * first facilitator that supports the network would get every payment. This
 * client sits in between. Verify and settle go to the facilitator configured
 * for the asset of the matched requirements, and a payment in any other asset
 * is refused (fail closed) instead of going to a facilitator that merely
 * supports the network.
 *
 * Being x402's only facilitator client, it also sees both calls of x402's
 * automatic settle retry, and keeps the transaction hash of the first one
 * (see {@link AssetRoutingFacilitatorClient.settle}).
 */
export class AssetRoutingFacilitatorClient implements FacilitatorClient {
  private readonly routes = new Map<string, AssetRoute>();
  /** Each distinct facilitator once, with the label of its first route. */
  private readonly facilitators = new Map<FacilitatorClient, string>();
  /** Answers of the last /supported round, per facilitator. */
  private supportedByFacilitator?: Map<FacilitatorClient, SupportedResponse>;
  /** Settlements reported as pending, by payment (network, asset, payer, nonce); oldest first. */
  private readonly pending = new Map<string, PendingSettlement>();
  private readonly now: () => number;
  private readonly maxPending: number;

  constructor(routes: Iterable<AssetRoute>, options: AssetRoutingOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxPending = Math.max(1, options.maxPendingSettlements ?? DEFAULT_MAX_PENDING_SETTLEMENTS);
    for (const route of routes) {
      const key = routeKey(route.network, route.asset);
      if (this.routes.has(key)) {
        throw new Error(`asset ${normalizePackageHash(route.asset)} on ${route.network} has two facilitator routes`);
      }
      this.routes.set(key, route);
      if (!this.facilitators.has(route.facilitator)) this.facilitators.set(route.facilitator, route.label);
    }
    if (this.routes.size === 0) throw new Error("the facilitator router needs at least one asset route");
  }

  /** The route of `asset` (any spelling) on `network`, or undefined when the asset is not routed. */
  routeFor(network: string, asset: string): AssetRoute | undefined {
    return this.routes.get(routeKey(network, asset));
  }

  /** Verify with the facilitator of the requirements' asset; refuses unrouted assets. */
  async verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.pick(paymentRequirements).facilitator.verify(paymentPayload, paymentRequirements);
  }

  /**
   * Settle with the facilitator of the requirements' asset; refuses unrouted
   * assets.
   *
   * x402 2.29 settles a second time, with the same payment, when the first
   * answer is a `settlement_pending` failure that names a transaction, and
   * keeps only the second answer. A self-hosted facilitator answers
   * `settlement_pending` when it broadcast the transfer but did not see it
   * execute in time, so that transfer may still execute. If the retry then
   * gets a failure that names no transaction (rate limited, shutting down, a
   * proxy error), that answer alone would read as a determinate failure: the
   * buyer would be invited to pay again while the first transfer can still
   * charge them. So the router remembers the transaction of a pending
   * settlement per payment (network, asset, payer, nonce) and answers such a
   * retry with `settlement_pending` and that transaction instead; the gateway
   * records the outcome as unknown, with the hash, and checks it on-chain. A
   * retry that times out (FacilitatorResponseError) stays a throw and carries
   * the transaction as well. A retry that succeeds, or whose failure names a
   * transaction itself, is passed on unchanged.
   *
   * With the route's `settleTimeoutMs`, the retry gets only what the first
   * call left of that timeout: when nothing is left, or the retry does not
   * answer in time, the router answers `settlement_pending` with the
   * remembered transaction without waiting any longer.
   */
  async settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    const route = this.pick(paymentRequirements);
    const key = pendingKeyOf(paymentPayload, paymentRequirements);
    const earlier = key === undefined ? undefined : this.pendingSettlement(key);
    const started = this.now();
    const remember = (transaction: string, payer: string | undefined): void => {
      if (key === undefined) return;
      this.rememberPending(key, {
        transaction,
        payer: payer ?? earlier?.payer ?? payerOf(paymentPayload),
        startedAt: earlier?.startedAt ?? started,
        expiresAt: Math.max(validBeforeMsOf(paymentPayload) ?? 0, this.now()) + PENDING_MEMORY_MARGIN_MS,
      });
    };

    const budgetMs = earlier && route.settleTimeoutMs !== undefined ? earlier.startedAt + route.settleTimeoutMs - started : undefined;
    if (earlier && budgetMs !== undefined && budgetMs <= 0) {
      return pendingAnswer(earlier, paymentRequirements, `nothing: the first call used up the ${route.settleTimeoutMs} ms settle timeout`);
    }

    let result: SettleResponse;
    try {
      if (earlier && budgetMs !== undefined) {
        const answer = await within(route.facilitator.settle(paymentPayload, paymentRequirements), budgetMs);
        if (answer.kind === "late") {
          return pendingAnswer(earlier, paymentRequirements, `nothing within the ${route.settleTimeoutMs} ms settle timeout`);
        }
        if (answer.kind === "threw") throw answer.error;
        result = answer.value;
      } else {
        result = await route.facilitator.settle(paymentPayload, paymentRequirements);
      }
    } catch (err) {
      if (err instanceof SettleError && isPendingWithTransaction(err.errorReason, err.transaction)) {
        remember(err.transaction, err.payer);
        throw err;
      }
      if (!earlier) throw err;
      if (err instanceof FacilitatorResponseError) {
        // Still indeterminate: keep the throw, and let it name the transfer that may execute.
        throw new SettlementIndeterminateError(
          `${err.message} (retrying a settlement the facilitator had reported as pending with transaction ${earlier.transaction})`,
          { transaction: earlier.transaction, cause: err },
        );
      }
      if (err instanceof SettleError && err.transaction) throw err;
      return pendingAnswer(earlier, paymentRequirements, describeFailure(err));
    }

    if (result.success) {
      if (key !== undefined) this.pending.delete(key);
      return result;
    }
    if (isPendingWithTransaction(result.errorReason, result.transaction)) {
      remember(result.transaction, result.payer);
      return result;
    }
    if (earlier && !result.transaction) return pendingAnswer(earlier, paymentRequirements, describeFailure(result));
    return result;
  }

  /**
   * The supported kinds of every routed facilitator, merged (see
   * {@link mergeSupported}). Every facilitator must answer: a gateway that
   * cannot reach the facilitator of one of its assets must not start.
   */
  async getSupported(): Promise<SupportedResponse> {
    const answers = await this.fetchSupported();
    this.supportedByFacilitator = answers;
    return mergeSupported([...answers.values()]);
  }

  /**
   * Startup check: the facilitator of every asset supports x402 `scheme`
   * payments of `x402Version` on that asset's network and, with `refuse`,
   * describes none of them in a way the gateway refuses (every such kind of
   * its answer goes through `refuse`). Uses the answers of the last
   * getSupported() call (x402 makes one when it initializes) and fetches them
   * when there are none. Throws one error naming every gap.
   *
   * Each facilitator is checked on its own answer, not on the merged one x402
   * sees: a gap names the facilitator and its asset, and a facilitator is
   * refused even when the merge happens to hide what it advertises (another
   * facilitator lacks the extension, or describes the kind differently).
   */
  async assertCoverage(x402Version = 2, scheme = "exact", refuse?: SupportedKindCheck): Promise<void> {
    this.supportedByFacilitator ??= await this.fetchSupported();
    const answers = this.supportedByFacilitator;
    const gaps: string[] = [];
    for (const route of this.routes.values()) {
      const answer = answers.get(route.facilitator);
      const kinds = (answer?.kinds ?? []).filter(
        kind => kind.x402Version === x402Version && kind.scheme === scheme && kind.network === route.network,
      );
      if (kinds.length === 0) {
        gaps.push(
          `${route.label} does not support x402 v${x402Version} "${scheme}" payments on ${route.network}, ` +
            `which asset ${normalizePackageHash(route.asset)} needs`,
        );
        continue;
      }
      for (const kind of kinds) {
        const problem = refuse?.(route, kind, answer?.extensions ?? []);
        if (problem !== undefined && !gaps.includes(problem)) gaps.push(problem);
      }
    }
    if (gaps.length > 0) throw new Error(gaps.join("; "));
  }

  private pick(requirements: PaymentRequirements): AssetRoute {
    const route = this.routes.get(routeKey(requirements.network, requirements.asset));
    if (!route) throw new UnroutedAssetError(requirements.network, requirements.asset);
    return route;
  }

  /** The pending settlement remembered for `key`, unless it expired. */
  private pendingSettlement(key: string): PendingSettlement | undefined {
    const entry = this.pending.get(key);
    if (entry && entry.expiresAt <= this.now()) {
      this.pending.delete(key);
      return undefined;
    }
    return entry;
  }

  private rememberPending(key: string, entry: PendingSettlement): void {
    // Re-inserting moves the payment to the end, so the oldest entries come first.
    this.pending.delete(key);
    if (this.pending.size >= this.maxPending) {
      const now = this.now();
      for (const [other, seen] of this.pending) {
        if (seen.expiresAt <= now) this.pending.delete(other);
      }
      for (const other of this.pending.keys()) {
        if (this.pending.size < this.maxPending) break;
        this.pending.delete(other);
      }
    }
    this.pending.set(key, entry);
  }

  private async fetchSupported(): Promise<Map<FacilitatorClient, SupportedResponse>> {
    const answers = await Promise.all(
      [...this.facilitators].map(async ([facilitator, label]) => {
        try {
          return [facilitator, await facilitator.getSupported()] as const;
        } catch (err) {
          throw new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
      }),
    );
    return new Map(answers);
  }
}

/** Whether a settle failure is x402's retryable `settlement_pending`: one that names a transaction. */
function isPendingWithTransaction(errorReason: string | undefined, transaction: string | undefined): boolean {
  return errorReason === SETTLEMENT_PENDING && typeof transaction === "string" && transaction.length > 0;
}

/** The authorization of an "exact" Casper payment payload, as far as the router needs it. */
function authorizationOf(paymentPayload: PaymentPayload): Record<string, unknown> | undefined {
  const authorization = (paymentPayload.payload as { authorization?: unknown } | undefined)?.authorization;
  return typeof authorization === "object" && authorization !== null ? (authorization as Record<string, unknown>) : undefined;
}

/** One payment: network, asset, payer and nonce. Undefined when the payload names no payer or nonce. */
function pendingKeyOf(paymentPayload: PaymentPayload, requirements: PaymentRequirements): string | undefined {
  const authorization = authorizationOf(paymentPayload);
  const from = authorization?.from;
  const nonce = authorization?.nonce;
  if (typeof from !== "string" || typeof nonce !== "string" || from.trim() === "" || nonce.trim() === "") return undefined;
  const payer = from.trim().toLowerCase();
  const bareNonce = nonce.trim().toLowerCase().replace(/^0x/, "");
  return `${requirements.network}|${normalizePackageHash(requirements.asset)}|${payer}|${bareNonce}`;
}

function payerOf(paymentPayload: PaymentPayload): string | undefined {
  const from = authorizationOf(paymentPayload)?.from;
  return typeof from === "string" ? from : undefined;
}

/** The authorization's validBefore in milliseconds, when it is a whole number of seconds. */
function validBeforeMsOf(paymentPayload: PaymentPayload): number | undefined {
  const validBefore = authorizationOf(paymentPayload)?.validBefore;
  const seconds = typeof validBefore === "string" && /^\d{1,12}$/.test(validBefore) ? Number(validBefore) : validBefore;
  return typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

/** The answer to a retry that got no verdict naming a transaction: the earlier settlement is still pending. */
function pendingAnswer(earlier: PendingSettlement, requirements: PaymentRequirements, detail: string): SettleResponse {
  return {
    success: false,
    errorReason: SETTLEMENT_PENDING,
    errorMessage: `retry after pending transaction ${earlier.transaction} answered ${detail}`,
    transaction: earlier.transaction,
    network: requirements.network,
    ...(earlier.payer !== undefined ? { payer: earlier.payer } : {}),
  };
}

/** A short description of a settle failure (thrown or returned), for the message of a pending answer. */
function describeFailure(failure: unknown): string {
  let text: string;
  if (failure instanceof SettleError) {
    text = failure.errorReason && failure.errorMessage ? `${failure.errorReason}: ${failure.errorMessage}` : failure.message;
  } else if (failure instanceof Error) {
    text = failure.message;
  } else if (typeof failure === "object" && failure !== null) {
    const { errorReason, errorMessage } = failure as Partial<SettleResponse>;
    const reason = errorReason || "an unsuccessful settle";
    text = errorMessage && errorMessage !== errorReason ? `${reason}: ${errorMessage}` : reason;
  } else {
    text = String(failure);
  }
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

type Raced<T> = { kind: "answered"; value: T } | { kind: "threw"; error: unknown } | { kind: "late" };

/** What `promise` settled with, or "late" when it did not settle within `ms` (a later rejection is then ignored). */
async function within<T>(promise: Promise<T>, ms: number): Promise<Raced<T>> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<Raced<T>>(resolve => {
    timer = setTimeout(() => resolve({ kind: "late" }), ms);
  });
  const answered = promise.then(
    (value): Raced<T> => ({ kind: "answered", value }),
    (error: unknown): Raced<T> => ({ kind: "threw", error }),
  );
  try {
    return await Promise.race([answered, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Merge the /supported answers of several facilitators into the one answer
 * x402's resource server sees.
 *
 * - kinds: every kind that any facilitator supports, once. x402 hands a
 *   kind's `extra` to the scheme for every requirement of that (version,
 *   scheme, network), whatever its asset. When facilitators describe the same
 *   kind differently (each has its own fee payer, for example), no single
 *   `extra` is right for all of their assets, so the merged kind carries none.
 * - extensions: only those every facilitator supports. A route's extensions
 *   apply to all of its accepts entries, whichever facilitator settles the one
 *   the buyer picks.
 * - signers: every facilitator's signers, per CAIP family.
 */
export function mergeSupported(answers: readonly SupportedResponse[]): SupportedResponse {
  const kinds = new Map<string, SupportedKind>();
  const conflicting = new Set<string>();
  for (const answer of answers) {
    for (const kind of answer.kinds ?? []) {
      const key = `${kind.x402Version}|${kind.scheme}|${kind.network}`;
      const seen = kinds.get(key);
      if (!seen) kinds.set(key, kind);
      else if (!deepEqual(seen.extra ?? {}, kind.extra ?? {})) conflicting.add(key);
    }
  }
  const mergedKinds = [...kinds].map(([key, kind]): SupportedKind => {
    if (!conflicting.has(key)) return kind;
    const { extra: _differs, ...rest } = kind;
    return rest;
  });

  const [first, ...others] = answers;
  const extensions = [...new Set(first?.extensions ?? [])].filter(extension =>
    others.every(answer => (answer.extensions ?? []).includes(extension)),
  );

  const signers = new Map<string, Set<string>>();
  for (const answer of answers) {
    for (const [family, list] of Object.entries(answer.signers ?? {})) {
      const merged = signers.get(family) ?? new Set<string>();
      for (const signer of Array.isArray(list) ? list : []) merged.add(signer);
      signers.set(family, merged);
    }
  }
  return {
    kinds: mergedKinds,
    extensions,
    signers: Object.fromEntries([...signers].map(([family, set]) => [family, [...set]])),
  };
}

/**
 * A facilitator client that leaves the given keys out of `extra` before it
 * forwards a payment: out of the payment requirements and out of the
 * payload's `accepted` copy of them, so the two still agree. Nothing a buyer
 * signed changes (the EIP-712 message covers neither).
 *
 * The gateway shows buyers CasCet's `extra.authorizationStyle`. No facilitator
 * needs it (facilitators read the token's ABI instead), and whether the hosted
 * facilitator tolerates fields it does not know is untested, so the gateway
 * strips it on the way there.
 */
export class ExtraStrippingFacilitatorClient implements FacilitatorClient {
  constructor(
    private readonly inner: FacilitatorClient,
    private readonly keys: readonly string[],
  ) {}

  verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.inner.verify(this.payload(paymentPayload), withoutExtraKeys(paymentRequirements, this.keys));
  }

  settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    return this.inner.settle(this.payload(paymentPayload), withoutExtraKeys(paymentRequirements, this.keys));
  }

  getSupported(): Promise<SupportedResponse> {
    return this.inner.getSupported();
  }

  private payload(paymentPayload: PaymentPayload): PaymentPayload {
    const accepted = (paymentPayload as { accepted?: PaymentRequirements }).accepted;
    if (!accepted) return paymentPayload;
    const stripped = withoutExtraKeys(accepted, this.keys);
    return stripped === accepted ? paymentPayload : { ...paymentPayload, accepted: stripped };
  }
}

/** `value` without `keys` in its `extra` (the same object when there is nothing to remove). */
function withoutExtraKeys<T extends { extra?: Record<string, unknown> }>(value: T, keys: readonly string[]): T {
  const extra = value.extra;
  if (!extra || !keys.some(key => Object.hasOwn(extra, key))) return value;
  const kept = Object.fromEntries(Object.entries(extra).filter(([key]) => !keys.includes(key)));
  return { ...value, extra: kept };
}

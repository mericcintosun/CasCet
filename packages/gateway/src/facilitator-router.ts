import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedKind,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { deepEqual } from "@x402/core/utils";
import { normalizePackageHash } from "@cascet/core";

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
 */
export class AssetRoutingFacilitatorClient implements FacilitatorClient {
  private readonly routes = new Map<string, AssetRoute>();
  /** Each distinct facilitator once, with the label of its first route. */
  private readonly facilitators = new Map<FacilitatorClient, string>();
  /** Answers of the last /supported round, per facilitator. */
  private supportedByFacilitator?: Map<FacilitatorClient, SupportedResponse>;

  constructor(routes: Iterable<AssetRoute>) {
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

  /** Settle with the facilitator of the requirements' asset; refuses unrouted assets. */
  async settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    return this.pick(paymentRequirements).facilitator.settle(paymentPayload, paymentRequirements);
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
   * payments of `x402Version` on that asset's network. Uses the answers of the
   * last getSupported() call (x402 makes one when it initializes) and fetches
   * them when there are none. Throws one error naming every gap.
   */
  async assertCoverage(x402Version = 2, scheme = "exact"): Promise<void> {
    this.supportedByFacilitator ??= await this.fetchSupported();
    const answers = this.supportedByFacilitator;
    const gaps: string[] = [];
    for (const route of this.routes.values()) {
      const kinds = answers.get(route.facilitator)?.kinds ?? [];
      const covered = kinds.some(kind => kind.x402Version === x402Version && kind.scheme === scheme && kind.network === route.network);
      if (!covered) {
        gaps.push(
          `${route.label} does not support x402 v${x402Version} "${scheme}" payments on ${route.network}, ` +
            `which asset ${normalizePackageHash(route.asset)} needs`,
        );
      }
    }
    if (gaps.length > 0) throw new Error(gaps.join("; "));
  }

  private pick(requirements: PaymentRequirements): AssetRoute {
    const route = this.routes.get(routeKey(requirements.network, requirements.asset));
    if (!route) throw new UnroutedAssetError(requirements.network, requirements.asset);
    return route;
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

import { resolvePaymentFlow } from "@x402/core/server";
import type {
  AssetAmount,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import { ExactCasperScheme } from "@x402/casper/exact/server";
import { normalizePackageHash } from "@cascet/core";
import { logSafe } from "./log.js";

/**
 * Payment flows a CasCet route may use: only "authorization" (verify before
 * the handler, settle after it). The gateway settles a verified payment itself,
 * after its own checks of the matched requirements and after the write-ahead
 * record of the authorization, in either order relative to the tool
 * (`settleBeforeExecute`).
 *
 * x402's "upfront" and "escrow" flows are refused (x402 throws when a route or
 * a facilitator's extension asks for them): there x402 skips the facilitator's
 * verify and settles inside processHTTPRequest, before any of those gateway
 * steps, and a failed or indeterminate settle would come back looking like a
 * refused payment, so the gateway would release the authorization and answer
 * "nothing was charged" after money may have moved. A facilitator that asks
 * for another flow stops the gateway at startup (see
 * {@link CascetCasperServerScheme.unsupportedFacilitatorFlow}).
 */
export const CASCET_PAYMENT_FLOWS = {
  default: { supported: ["authorization"], default: "authorization" },
} as const satisfies Record<string, PaymentFlowConfig>;

/** x402's protocol-reserved requirement fields that choose how a payment is verified and settled. */
const PAYMENT_FLOW_KEYS = ["assetTransferMethod", "paymentFlow"] as const;

/**
 * The payment flow fields (`extra.assetTransferMethod`, `extra.paymentFlow`)
 * that a facilitator's /supported answer puts into the requirements of its
 * `kind`'s payments. @x402/casper copies `kind.extra[key]` into every such
 * requirement for each extension key the facilitator lists, and the CasCet
 * scheme keeps them (they are none of the gateway's own extra fields).
 */
export function advertisedPaymentFlow(kind: SupportedKind, extensions: readonly string[]): Record<string, unknown> {
  const extra = kind.extra ?? {};
  return Object.fromEntries(PAYMENT_FLOW_KEYS.filter(key => extensions.includes(key) && Object.hasOwn(extra, key)).map(key => [key, extra[key]]));
}

/** What a facilitator asks for that the CasCet scheme refuses (see {@link CascetCasperServerScheme.unsupportedFacilitatorFlow}). */
export interface UnsupportedFlow {
  /** What the facilitator advertises, e.g. `payment flow "upfront"`. */
  advertised: string;
  /** What CasCet supports instead. */
  supported: string;
}

/** One token a CasCet gateway prices in. */
export interface ServerSchemeAsset {
  network: string;
  /** Contract package hash, with or without "hash-" (stored as bare lower-case hex). */
  asset: string;
  decimals: number;
}

const assetKey = (network: string, asset: string): string => `${network}|${normalizePackageHash(asset)}`;

/**
 * The x402 "exact" server scheme of a CasCet gateway: the official
 * `@x402/casper` server scheme, with the members @x402/core 2.29 requires
 * (`defaultAssetTransferMethod`, `paymentFlows`) and fail-closed pricing.
 *
 * - Only AssetAmount prices are accepted, and only in a configured asset. A
 *   Money price ("$0.01") would silently become @x402/casper's default asset
 *   (csprUSD), so it throws instead; CasCet converts USD prices to raw units of
 *   the configured token itself.
 * - Decimals come from the gateway config, never from @x402/casper's built-in
 *   table (which only knows csprUSD).
 * - Requirements are validated and enriched by @x402/casper (asset and payTo
 *   format, EIP-712 `extra.name` / `extra.version`), except that a
 *   facilitator's extension values never replace an `extra` field the gateway
 *   set itself (the EIP-712 domain, symbol, decimals, authorization style):
 *   @x402/casper copies `supportedKind.extra[key]` for every extension key the
 *   facilitator lists.
 */
export class CascetCasperServerScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  /** @x402/casper has no on-wire asset transfer method; "default" is the SDK's placeholder. */
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = CASCET_PAYMENT_FLOWS;
  private readonly inner = new ExactCasperScheme();
  private readonly decimals = new Map<string, number>();

  constructor(assets: Iterable<ServerSchemeAsset> = []) {
    for (const entry of assets) this.registerAsset(entry);
  }

  /** Allow pricing in `asset` on `network`, with the token's decimals. */
  registerAsset(entry: ServerSchemeAsset): this {
    if (!Number.isInteger(entry.decimals) || entry.decimals < 0 || entry.decimals > 77) {
      throw new Error(`invalid decimals ${String(entry.decimals)} for asset ${entry.asset}`);
    }
    this.decimals.set(assetKey(entry.network, entry.asset), entry.decimals);
    return this;
  }

  getAssetDecimals(asset: string, network: Network): number | undefined {
    return this.decimals.get(assetKey(network, asset));
  }

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price !== "object" || price === null || !("amount" in price)) {
      throw new Error(
        "CasCet prices must be AssetAmounts ({ asset, amount, extra }) in a configured token; " +
          `a money price (${JSON.stringify(price)}) would silently select @x402/casper's default asset`,
      );
    }
    if (!this.decimals.has(assetKey(network, price.asset))) {
      throw new Error(`asset ${price.asset} is not configured for ${network}`);
    }
    return this.inner.parsePrice(price, network);
  }

  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: SupportedKind,
    facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    const enhanced = await this.inner.enhancePaymentRequirements(paymentRequirements, supportedKind, facilitatorExtensions);
    // The gateway's own fields win; the facilitator may only add fields of its own.
    return { ...enhanced, extra: { ...enhanced.extra, ...paymentRequirements.extra } };
  }

  /**
   * The payment flow or asset transfer method that a facilitator's /supported
   * answer (`kind`, with the facilitator's `extensions`) asks for with the
   * payments of that kind, when this scheme does not support it; undefined
   * when it asks for none, or for one this scheme supports.
   *
   * x402 refuses such a flow on every paid call: it throws while it builds the
   * requirements, before anything is verified, and every call ends in a
   * generic error. The gateway runs this check at startup instead, on each
   * facilitator's own answer (see createPaymentRail), with x402's own
   * resolvePaymentFlow: the check x402 runs on every call.
   */
  unsupportedFacilitatorFlow(kind: SupportedKind, extensions: readonly string[]): UnsupportedFlow | undefined {
    const advertised = advertisedPaymentFlow(kind, extensions);
    if (Object.keys(advertised).length === 0) return undefined;
    try {
      resolvePaymentFlow(this, { scheme: kind.scheme, network: kind.network, asset: "", amount: "0", payTo: "", maxTimeoutSeconds: 0, extra: advertised });
      return undefined;
    } catch {
      // Facilitator values: bounded and control-free, they end up in a startup error.
      const shown = (value: unknown): string => logSafe(JSON.stringify(value) ?? String(value), 80);
      const method = advertised.assetTransferMethod;
      if (typeof method === "string" && !Object.hasOwn(this.paymentFlows, method)) {
        return {
          advertised: `asset transfer method ${shown(method)}`,
          supported: `the CasCet scheme has no asset transfer method on the wire (only x402's "${this.defaultAssetTransferMethod}")`,
        };
      }
      return {
        advertised: `payment flow ${shown(advertised.paymentFlow)}`,
        supported: `CasCet supports only the "authorization" flow (verify before the tool runs, settle after the gateway's own checks)`,
      };
    }
  }
}

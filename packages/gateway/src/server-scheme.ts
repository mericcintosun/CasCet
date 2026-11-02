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
 * "nothing was charged" after money may have moved.
 */
export const CASCET_PAYMENT_FLOWS = {
  default: { supported: ["authorization"], default: "authorization" },
} as const satisfies Record<string, PaymentFlowConfig>;

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
}

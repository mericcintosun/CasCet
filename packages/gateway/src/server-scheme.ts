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
 * Payment flows a CasCet route may use. "authorization" (verify before the
 * handler, settle after it) is the default and what every CasCet route uses
 * today; "upfront" (settle before the handler) is accepted so a route can opt
 * into x402's native settle-before-execute with `extra.paymentFlow`.
 */
export const CASCET_PAYMENT_FLOWS = {
  default: { supported: ["authorization", "upfront"], default: "authorization" },
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
 * - Requirements are validated and enriched by @x402/casper unchanged (asset
 *   and payTo format, EIP-712 `extra.name` / `extra.version`).
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

  enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: SupportedKind,
    facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    return this.inner.enhancePaymentRequirements(paymentRequirements, supportedKind, facilitatorExtensions);
  }
}

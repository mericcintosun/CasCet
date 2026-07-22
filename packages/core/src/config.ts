import { z } from "zod";
import { DEFAULT_FACILITATOR_URL, DEFAULT_GATEWAY_PORT, NETWORK_CASPER_TESTNET } from "./constants.js";

/** Upstream MCP server the gateway wraps: a local stdio process or a remote HTTP endpoint. */
export const upstreamSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).optional(),
  }),
  z.object({
    type: z.literal("http"),
    url: z.string().url(),
  }),
]);

/** Price of a single tool. `price` is a USD money string ("$0.001") converted via `asset.usdRate`. */
export const toolPriceSchema = z.object({
  price: z.string().regex(/^\$\d+(\.\d+)?$/, 'price must look like "$0.001"'),
  description: z.string().optional(),
});

/** CEP-18 token the gateway accepts, plus the fixed USD conversion rate used on testnet. */
export const assetSchema = z.object({
  packageHash: z.string().describe("CEP-18 contract package hash (with or without hash- prefix)"),
  name: z.string(),
  symbol: z.string(),
  decimals: z.number().int().min(0).max(18).default(9),
  version: z.string().default("1"),
  /** How many whole tokens equal 1 USD (testnet demo rate). */
  tokensPerUsd: z.number().positive().default(50),
});

export const cascetConfigSchema = z.object({
  /** Display name of this paid server (shows up in receipts + dashboard). */
  name: z.string(),
  upstream: upstreamSchema,
  network: z.string().default(NETWORK_CASPER_TESTNET),
  /** Casper public key that receives payments (or the RevenueSplit contract's account). */
  payTo: z.string(),
  asset: assetSchema,
  facilitator: z.object({
    url: z.string().url().default(DEFAULT_FACILITATOR_URL),
    apiKey: z.string().optional(),
  }),
  pricing: z.object({
    /** Fallback price for tools not listed in `tools`. Omit to keep unlisted tools free. */
    default: toolPriceSchema.optional(),
    tools: z.record(toolPriceSchema).default({}),
  }),
  port: z.number().int().default(DEFAULT_GATEWAY_PORT),
  /** Optional dashboard ingest endpoint; the gateway POSTs receipt events there. */
  eventsUrl: z.string().url().optional(),
  /**
   * Optional on-chain anchoring: when set, each settled receipt is recorded in
   * a deployed ReceiptRegistry contract (async, non-blocking). The anchoring key
   * must be an authorized recorder on that registry.
   */
  anchoring: z
    .object({
      contractPackageHash: z.string().describe("ReceiptRegistry package hash (with or without hash- prefix)"),
      keyPath: z.string().describe("PEM secret key of an authorized recorder"),
      keyAlgo: z.enum(["ed25519", "secp256k1"]).default("ed25519"),
      nodeUrl: z.string().url(),
      chainName: z.string().default("casper-test"),
      gasMotes: z.number().int().default(5_000_000_000),
    })
    .optional(),
});

export type Upstream = z.infer<typeof upstreamSchema>;
export type ToolPrice = z.infer<typeof toolPriceSchema>;
export type AssetConfig = z.infer<typeof assetSchema>;
export type CascetConfig = z.infer<typeof cascetConfigSchema>;

/**
 * Convert a "$0.001" money string into raw CEP-18 token units per the asset
 * config. Done entirely in integer/BigInt space (both the price and the rate are
 * treated as exact decimal fractions) — IEEE-754 float math would silently lose
 * precision for high-decimal tokens and could round a small price to 0.
 */
export function usdPriceToTokenUnits(price: string, asset: AssetConfig): bigint {
  const cleaned = price.replace(/^\$/, "").trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) throw new Error(`invalid price: ${price}`);
  const rateStr = asset.tokensPerUsd.toString();
  if (!/^\d+(\.\d+)?$/.test(rateStr)) {
    throw new Error(`tokensPerUsd not exactly representable: ${asset.tokensPerUsd}`);
  }
  const [pInt, pFrac = ""] = cleaned.split(".");
  const [rInt, rFrac = ""] = rateStr.split(".");
  const priceNum = BigInt(pInt + pFrac);
  const rateNum = BigInt(rInt + rFrac);
  const scale = 10n ** BigInt(pFrac.length + rFrac.length);
  // raw = price * tokensPerUsd * 10^decimals, exact integer division by the combined scale.
  const raw = (priceNum * rateNum * 10n ** BigInt(asset.decimals)) / scale;
  if (raw <= 0n) {
    throw new Error(`price ${price} rounds to 0 raw units for this asset — raise the price or asset.decimals`);
  }
  return raw;
}

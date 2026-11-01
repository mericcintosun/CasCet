import { z } from "zod";
import { DEFAULT_FACILITATOR_URL, DEFAULT_GATEWAY_PORT, NETWORK_CASPER_TESTNET } from "./constants.js";

/** Upstream MCP server the gateway wraps: a local stdio process or a remote HTTP endpoint. */
export const upstreamSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).default([]),
    /**
     * Environment of the upstream process. The gateway never forwards its own
     * environment (keys, tokens): the child sees only the MCP SDK's minimal
     * default set (HOME, LOGNAME, PATH, SHELL, TERM, USER on POSIX) plus exactly
     * the variables listed here.
     */
    env: z.record(z.string(), z.string()).optional(),
    /** Working directory of the upstream process. Defaults to the gateway's. */
    cwd: z.string().optional(),
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
  /**
   * Settle the payment BEFORE running the tool. Default false: the tool runs
   * first and the payment settles afterwards, so buyers are only charged for
   * successful calls, but an authorization that verifies and then fails to
   * settle (empty balance, nonce spent elsewhere) gets the call for free.
   * Turn this on for tools with side effects or that buy from other paid
   * tools (cascades). Trade-off: a tool that fails after settlement is not
   * refunded.
   */
  settleBeforeExecute: z.boolean().default(false),
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

/**
 * Canonical form of a web origin ("scheme://host[:port]", lowercase host, no
 * default port), or undefined when the value is not a plain http(s) origin.
 * The wildcard "*" and the opaque "null" origin are never valid.
 */
export function normalizeOrigin(value: string): string | undefined {
  if (value === "*" || value === "null") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  return `${url.protocol}//${url.host}`;
}

const originSchema = z.string().transform((value, ctx) => {
  const origin = normalizeOrigin(value);
  if (!origin) {
    ctx.addIssue({
      code: "custom",
      message: `"${value}" is not an allowed origin: use scheme://host[:port] (never "*" or "null")`,
    });
    return z.NEVER;
  }
  return origin;
});

/** Browser access to the gateway. Requests carrying an Origin that is not listed get HTTP 403. */
export const corsSchema = z
  .object({
    /** Exact origins allowed to call the gateway from a browser. Empty (default) = no browser access. */
    allowedOrigins: z.array(originSchema).default([]),
  })
  .prefault({});

/**
 * Network timeouts of the gateway, in milliseconds.
 *
 * A paid call in the default run-then-settle mode can take up to
 * facilitatorMs + upstreamMs + settleMs (165 s with the defaults) before the
 * gateway answers, so buyers must wait longer than that: a buyer that gives up
 * earlier may still be charged without receiving the result.
 */
export const timeoutsSchema = z
  .object({
    /** Facilitator /verify and /supported calls. */
    facilitatorMs: z.number().int().positive().default(15_000),
    /**
     * Facilitator /settle call. Longer than `facilitatorMs` because a Casper
     * facilitator only answers once the transfer has executed on-chain
     * (casper-x402 polls for up to 60 s); when it expires the outcome is
     * recorded as "unknown", never as failed.
     */
    settleMs: z.number().int().positive().default(90_000),
    /** One upstream MCP request (tools/list page, tools/call). */
    upstreamMs: z.number().int().positive().default(60_000),
  })
  .prefault({});

/** Read-only on-chain checks used when a settlement does not succeed. */
export const settlementSchema = z
  .object({
    /**
     * Casper node JSON-RPC used to look up the token's events when a settle
     * fails (falls back to `anchoring.nodeUrl`; without either the check is off).
     */
    nodeUrl: z.string().url().optional(),
    /** How many of the token's most recent events a check scans. */
    eventScanWindow: z.number().int().min(1).max(1_000).default(64),
    /**
     * Deliver the tool result when the facilitator's settle failed because this
     * exact authorization was already executed on-chain by another submitter
     * (settlement preemption). Off by default: if this payTo is shared by
     * several gateways that do not share one facilitator nonce cache, a buyer
     * could present one authorization to each of them and be served twice.
     */
    acceptThirdPartySettlement: z.boolean().default(false),
  })
  .prefault({});

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
    /**
     * Fallback price for upstream tools that are neither listed in `tools` nor
     * in `freeTools`. Without it such tools are hidden and refused.
     */
    default: toolPriceSchema.optional(),
    tools: z.record(z.string(), toolPriceSchema).default({}),
    /**
     * Upstream tools served free of charge. An upstream tool that is neither
     * priced (in `tools` or by `default`) nor listed here is hidden from
     * tools/list and refused on tools/call.
     */
    freeTools: z.array(z.string().min(1)).default([]),
  }),
  port: z.number().int().min(0).max(65_535).default(DEFAULT_GATEWAY_PORT),
  /**
   * Interface the gateway listens on. Defaults to loopback; set "0.0.0.0" (or a
   * specific address) only for a deployment that must be reachable from other hosts.
   */
  host: z.string().min(1).default("127.0.0.1"),
  cors: corsSchema,
  timeouts: timeoutsSchema,
  settlement: settlementSchema,
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
      /** Casper chain name. Derived from `network` when omitted ("casper" or "casper-test"). */
      chainName: z.string().min(1).optional(),
      /** Gas limit per anchor transaction. Casper charges the full limit, so keep it tight. */
      gasMotes: z.number().int().positive().default(2_500_000_000),
      /** How long to wait for an anchor transaction to execute before counting it as failed. */
      confirmTimeoutMs: z.number().int().positive().default(120_000),
      /** Consecutive anchor failures that open the circuit breaker (anchoring pauses). */
      maxConsecutiveFailures: z.number().int().positive().default(3),
      /** Pause after the breaker opens before one trial anchor is attempted. */
      cooldownMs: z.number().int().nonnegative().default(600_000),
    })
    .optional(),
}).superRefine((cfg, ctx) => {
  cfg.pricing.freeTools.forEach((tool, index) => {
    if (Object.hasOwn(cfg.pricing.tools, tool)) {
      ctx.addIssue({
        code: "custom",
        path: ["pricing", "freeTools", index],
        message: `tool "${tool}" is both priced in pricing.tools and listed in pricing.freeTools`,
      });
    }
  });
});

export type Upstream = z.infer<typeof upstreamSchema>;
export type ToolPrice = z.infer<typeof toolPriceSchema>;
export type AssetConfig = z.infer<typeof assetSchema>;
export type CascetConfig = z.infer<typeof cascetConfigSchema>;
export type TimeoutsConfig = z.infer<typeof timeoutsSchema>;
export type SettlementConfig = z.infer<typeof settlementSchema>;
export type AnchoringConfig = NonNullable<CascetConfig["anchoring"]>;

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

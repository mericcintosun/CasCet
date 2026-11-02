import { z } from "zod";
import {
  AUTHORIZATION_STYLES,
  defaultAuthorizationStyle,
  hasLoneSurrogate,
  isLegacyAmountToken,
  isPackageHash,
  MAX_TOKEN_NAME_LENGTH,
  MAX_TOKEN_VERSION_LENGTH,
  normalizePackageHash,
  type AuthorizationStyle,
} from "./assets.js";
import { DEFAULT_FACILITATOR_URL, DEFAULT_GATEWAY_PORT, isHostedFacilitatorUrl, NETWORK_CASPER_TESTNET } from "./constants.js";
import { payToSchema } from "./payto.js";

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

/** Price of a single tool. `price` is a USD money string ("$0.001") converted with each asset's `tokensPerUsd`. */
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
  /**
   * Ids of the assets this tool can be paid in (one x402 `accepts` entry each,
   * in config order). Omit to accept every configured asset.
   */
  assets: z.array(z.string().min(1)).min(1).optional(),
});

/** A contract package hash in any common spelling, stored as bare lower-case hex. */
const packageHashSchema = z
  .string()
  .describe("CEP-18 contract package hash (with or without hash- prefix)")
  .transform((value, ctx) => {
    const bare = normalizePackageHash(value);
    if (isPackageHash(bare)) return bare;
    ctx.addIssue({
      code: "custom",
      message:
        'packageHash must be a contract package hash: 64 hex characters, optionally prefixed with "hash-"; ' +
        `got ${JSON.stringify(value.slice(0, 80))}`,
    });
    return z.NEVER;
  });

/** Ids name assets in `pricing.*.assets`: lower-case letters, digits, ".", "_" and "-". */
const ASSET_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Names of the entries of `facilitators`. */
const FACILITATOR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FACILITATOR_NAME_RULE = 'facilitator names are 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit';
/** The longest delay setTimeout accepts. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * How long CasCet buyers let a payment authorization stay valid, by default:
 * @cascet/client's `maxAuthorizationSeconds` and the Python client's limit.
 * They refuse every payment option of a 402 that asks for a longer window.
 */
export const DEFAULT_MAX_AUTHORIZATION_SECONDS = 900;
/** Seconds the payment window keeps for the settle transaction itself (@cascet/gateway's SETTLE_HEADROOM_SECONDS). */
const SETTLE_HEADROOM_SECONDS = 30;
/** The gateway's on-chain preflight of a payment the hosted facilitator settles (@cascet/gateway's HOSTED_PREFLIGHT_DEADLINE_MS). */
const HOSTED_PREFLIGHT_MS = 5_000;
/** x402's customary payment window; the gateway never asks for less. */
const MIN_PAYMENT_WINDOW_SECONDS = 300;

/**
 * A field of the token's EIP-712 domain, bounded as CasCet buyers bound it:
 * they refuse every payment option whose name or version is longer, or holds
 * a lone surrogate, so a gateway configured with one could sell nothing.
 */
function domainFieldSchema(field: "name" | "version", maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength, `${field} must be at most ${maxLength} characters (UTF-16 code units): CasCet buyers refuse a longer one`)
    .refine(value => !hasLoneSurrogate(value), `${field} contains a lone UTF-16 surrogate, which has no UTF-8 form to sign over`);
}

/**
 * A CEP-18 token the gateway accepts, plus the fixed USD conversion rate used
 * on testnet. `packageHash` is stored as bare lower-case hex.
 */
export const assetSchema = z.object({
  /**
   * Short handle used by `pricing.*.assets`. Defaults to the lower-cased
   * symbol (the package hash when the symbol is blank), so two assets with
   * the same symbol need explicit ids.
   */
  id: z.string().regex(ASSET_ID, 'asset id must be 1-64 lower-case letters, digits, ".", "_" or "-"').optional(),
  packageHash: packageHashSchema,
  /** EIP-712 domain name: must equal the token's on-chain `name`. */
  name: domainFieldSchema("name", MAX_TOKEN_NAME_LENGTH),
  /** Display only (receipts, the 402's `extra`); may be empty, as in earlier versions. */
  symbol: z.string(),
  decimals: z.number().int().min(0).max(18).default(9),
  /** EIP-712 domain version ("1" for every Casper x402 token seen so far). */
  version: domainFieldSchema("version", MAX_TOKEN_VERSION_LENGTH).default("1"),
  /** How many whole tokens equal 1 USD (testnet demo rate). */
  tokensPerUsd: z.number().positive().default(50),
  /**
   * The token's `transfer_with_authorization` ABI. Omit to resolve it from the
   * package hash: CasCet's own x402 tokens are "legacy-amount", every other
   * token "cep3009-value".
   */
  authorization: z.enum(AUTHORIZATION_STYLES).optional(),
  /**
   * Name of the facilitator that settles this asset: a key of `facilitators`,
   * or "default" (the top-level `facilitator`, used when omitted).
   */
  facilitator: z.string().min(1).optional(),
});

/**
 * An x402 facilitator the gateway verifies and settles through.
 *
 * The hosted facilitator (x402-facilitator.cspr.cloud) expects the raw
 * CSPR.cloud access key in the Authorization header: `authScheme` defaults to
 * "raw", and "bearer" is refused for it.
 */
export const facilitatorSchema = z.object({
  url: z.string().url(),
  /** Credential sent in the Authorization header of every request. */
  apiKey: z.string().optional(),
  /** "raw": `Authorization: <apiKey>`; "bearer": `Authorization: Bearer <apiKey>`. */
  authScheme: z.enum(["raw", "bearer"]).default("raw"),
  /**
   * Per-request timeout of this facilitator's /supported, /verify and /settle
   * calls. Omit to use `timeouts.facilitatorMs` (/supported, /verify) and
   * `timeouts.settleMs` (/settle). Set, it stands for both of them in how long
   * a paid call in its assets can take, and counts twice in the authorization
   * window buyers are asked to sign, which must stay within the 900 s CasCet
   * buyers accept ({@link paymentWindowSeconds}): at most about 400 s with the
   * default `timeouts.upstreamMs`.
   */
  timeoutMs: z.number().int().positive().max(MAX_TIMER_MS).optional(),
});

/** The top-level `facilitator` ("default"): an entry of `facilitators` whose URL defaults to the hosted facilitator. */
const defaultFacilitatorSchema = facilitatorSchema
  .extend({ url: z.string().url().default(DEFAULT_FACILITATOR_URL) })
  .prefault({});

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
 * gateway answers, plus its read-only chain checks when `settlement.nodeUrl`
 * is set (up to 15 s after a settlement that did not succeed, 5 s before the
 * hosted facilitator verifies a payment), so buyers must wait longer than
 * that: a buyer that gives up earlier may still be charged without receiving
 * the result.
 */
export const timeoutsSchema = z
  .object({
    /** Facilitator /verify and /supported calls. */
    facilitatorMs: z.number().int().positive().max(MAX_TIMER_MS).default(15_000),
    /**
     * Facilitator /settle call. Longer than `facilitatorMs` because a Casper
     * facilitator only answers once the transfer has executed on-chain
     * (casper-x402 polls for up to 60 s); when it expires the outcome is
     * recorded as "unknown", never as failed. x402 settles once more when the
     * facilitator reports the settlement as pending; the gateway keeps both
     * calls within this timeout.
     */
    settleMs: z.number().int().positive().max(MAX_TIMER_MS).default(90_000),
    /** One upstream MCP request (tools/list page, tools/call). */
    upstreamMs: z.number().int().positive().max(MAX_TIMER_MS).default(60_000),
  })
  .prefault({});

/** Read-only on-chain checks of the gateway: when a settlement does not succeed, and before the hosted facilitator verifies. */
export const settlementSchema = z
  .object({
    /**
     * Casper node JSON-RPC used to look up the token's events when a settle
     * fails, and to check payments the hosted facilitator settles (unused
     * nonce, balance, token ABI and name) before it verifies them. Falls back
     * to `anchoring.nodeUrl`; without either both checks are off.
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

const rawConfigSchema = z.object({
  /** Display name of this paid server (shows up in receipts + dashboard). */
  name: z.string(),
  upstream: upstreamSchema,
  network: z.string().default(NETWORK_CASPER_TESTNET),
  /**
   * Who receives payments: the serialized Casper Key the x402 exact scheme signs over.
   * Use the payee's ACCOUNT HASH ("00" + 64 hex, or "account-hash-<64 hex>"). Never a public
   * key: get the account hash with `npx @cascet/cli account-hash <public-key>`.
   * A contract package such as a RevenueSplit ("hash-<64 hex>" or "package-hash-<64 hex>",
   * stored as "01" + 64 hex) passes this check, but cannot be paid today:
   * @make-software/casper-x402 1.0.0 facilitators settle every payTo as an account hash, so
   * that revenue would go to an account nobody controls, and CasCet buyers refuse such a
   * payee. `cascet wrap` warns about it.
   */
  payTo: payToSchema,
  /** The token buyers pay in. Set exactly one of `asset` and `assets`. */
  asset: assetSchema.optional(),
  /**
   * Several tokens buyers can pay in, in order of preference (a 402 lists them
   * in this order). Set exactly one of `asset` and `assets`.
   */
  assets: z.array(assetSchema).min(1).optional(),
  /** The "default" facilitator: settles every asset that names no other one. */
  facilitator: defaultFacilitatorSchema,
  /** More facilitators, by name, for assets that set `facilitator: "<name>"`. */
  facilitators: z
    .record(z.string().regex(FACILITATOR_NAME, FACILITATOR_NAME_RULE), facilitatorSchema, {
      // zod reports a bad key as "Invalid key in record" and nests the rule; say the rule itself.
      error: issue => (issue.code === "invalid_key" ? FACILITATOR_NAME_RULE : undefined),
    })
    .default({}),
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

/** Name of the top-level `facilitator` in {@link CascetConfig.facilitators}. */
export const DEFAULT_FACILITATOR_NAME = "default";

export type FacilitatorConfig = z.output<typeof facilitatorSchema>;

/** A configured asset with every default resolved. */
export interface ResolvedAsset {
  /** Handle used by `pricing.*.assets`; unique within the config. */
  id: string;
  /** Contract package hash, bare lower-case hex; unique within the config. */
  packageHash: string;
  /** EIP-712 domain name. */
  name: string;
  symbol: string;
  decimals: number;
  /** EIP-712 domain version. */
  version: string;
  tokensPerUsd: number;
  authorization: AuthorizationStyle;
  /** Key of the facilitator that settles this asset in {@link CascetConfig.facilitators}. */
  facilitator: string;
}

type RawConfig = z.output<typeof rawConfigSchema>;
type Issues = Array<{ path: PropertyKey[]; message: string }>;

/**
 * Resolve the asset and facilitator sections: `asset` or `assets` become
 * `assets` (plus the `asset` alias of the first one), the top-level
 * `facilitator` joins `facilitators` as "default", and every reference between
 * them is checked.
 */
function resolveConfig(raw: RawConfig, issues: Issues) {
  const { asset: single, assets: list, facilitator, facilitators: named, ...rest } = raw;
  if ((single === undefined) === (list === undefined)) {
    issues.push({
      path: single === undefined ? ["asset"] : ["assets"],
      message: "set exactly one of `asset` (one token) and `assets` (several tokens)",
    });
    return undefined;
  }
  const assetsPath: PropertyKey[] = list ? ["assets"] : ["asset"];
  const at = (index: number, field: string): PropertyKey[] => (list ? [...assetsPath, index, field] : [...assetsPath, field]);

  if (Object.hasOwn(named, DEFAULT_FACILITATOR_NAME)) {
    issues.push({
      path: ["facilitators", DEFAULT_FACILITATOR_NAME],
      message: `"${DEFAULT_FACILITATOR_NAME}" is the top-level \`facilitator\`; configure it there or pick another name`,
    });
  }
  const facilitators: Record<string, FacilitatorConfig> = { ...named, [DEFAULT_FACILITATOR_NAME]: facilitator };
  for (const [name, entry] of Object.entries(facilitators)) {
    if (entry.authScheme === "bearer" && isHostedFacilitatorUrl(entry.url)) {
      issues.push({
        path: name === DEFAULT_FACILITATOR_NAME ? ["facilitator", "authScheme"] : ["facilitators", name, "authScheme"],
        message: 'the hosted facilitator takes the raw CSPR.cloud access key in the Authorization header: use authScheme "raw"',
      });
    }
  }

  const ids = new Map<string, number>();
  const hashes = new Map<string, number>();
  const assets: ResolvedAsset[] = (list ?? [single!]).map((entry, index) => {
    const resolved: ResolvedAsset = {
      id: entry.id ?? (entry.symbol.trim() === "" ? entry.packageHash : entry.symbol.toLowerCase()),
      packageHash: entry.packageHash,
      name: entry.name,
      symbol: entry.symbol,
      decimals: entry.decimals,
      version: entry.version,
      tokensPerUsd: entry.tokensPerUsd,
      authorization: entry.authorization ?? defaultAuthorizationStyle(entry.packageHash),
      facilitator: entry.facilitator ?? DEFAULT_FACILITATOR_NAME,
    };
    if (ids.has(resolved.id)) {
      issues.push({
        path: at(index, "id"),
        message: `asset id "${resolved.id}" is used twice (ids default to the lower-cased symbol); give each asset its own "id"`,
      });
    } else {
      ids.set(resolved.id, index);
    }
    if (hashes.has(resolved.packageHash)) {
      issues.push({ path: at(index, "packageHash"), message: `token ${resolved.packageHash} is listed twice` });
    } else {
      hashes.set(resolved.packageHash, index);
    }
    if (resolved.authorization !== "legacy-amount" && isLegacyAmountToken(resolved.packageHash)) {
      issues.push({
        path: at(index, "authorization"),
        message: `token ${resolved.packageHash} is CasCet's x402 token, whose transfer_with_authorization takes \`amount\`: its authorization style is "legacy-amount"`,
      });
    }
    const settler = Object.hasOwn(facilitators, resolved.facilitator) ? facilitators[resolved.facilitator] : undefined;
    if (!settler) {
      issues.push({
        path: at(index, "facilitator"),
        message: `unknown facilitator "${resolved.facilitator}": name a key of \`facilitators\`, or "${DEFAULT_FACILITATOR_NAME}"`,
      });
    } else if (resolved.authorization === "legacy-amount" && isHostedFacilitatorUrl(settler.url)) {
      issues.push({
        path: at(index, "facilitator"),
        message:
          `asset "${resolved.id}" is a legacy-amount token, but its facilitator is the hosted one, which sends the CEP-3009 ` +
          "`value` argument: every settlement would revert (User error: 64658). Settle it through a self-hosted facilitator",
      });
    }
    return resolved;
  });

  const checkAssetRefs = (price: ToolPrice | undefined, path: PropertyKey[]): void => {
    const seen = new Set<string>();
    price?.assets?.forEach((id, index) => {
      if (!ids.has(id)) {
        issues.push({ path: [...path, "assets", index], message: `unknown asset "${id}": use the id of a configured asset` });
      } else if (seen.has(id)) {
        issues.push({ path: [...path, "assets", index], message: `asset "${id}" is listed twice` });
      }
      seen.add(id);
    });
  };
  checkAssetRefs(rest.pricing.default, ["pricing", "default"]);
  for (const [tool, price] of Object.entries(rest.pricing.tools)) checkAssetRefs(price, ["pricing", "tools", tool]);

  // A window longer than CasCet buyers sign makes each of them refuse every payment. Bounding it also
  // keeps the timeouts' sum, which the gateway's drain timer waits, far below setTimeout's limit.
  if (issues.length === 0) {
    const window = paymentWindow({ ...rest, assets, facilitators });
    if (window.seconds > DEFAULT_MAX_AUTHORIZATION_SECONDS) {
      const seconds = (ms: number) => `${ms / 1_000} s`;
      const terms = [
        ...(window.preflightMs > 0 ? [`preflight ${seconds(window.preflightMs)}`] : []),
        `verify ${seconds(window.verifyMs)}`,
        `tool ${seconds(window.upstreamMs)}`,
        `settle ${seconds(window.settleMs)}`,
        `${SETTLE_HEADROOM_SECONDS} s for the settle transaction`,
      ];
      issues.push({
        path: ["timeouts"],
        message:
          `buyers would be asked to sign a ${window.seconds} s authorization window (${terms.join(" + ")}), above the ` +
          `${DEFAULT_MAX_AUTHORIZATION_SECONDS} s CasCet buyers accept, so they would refuse every payment: lower ` +
          "timeouts.upstreamMs, timeouts.facilitatorMs, timeouts.settleMs or a facilitator's timeoutMs",
      });
    }
  }

  return {
    ...rest,
    /** Every accepted token, in config order (the order of a 402's `accepts`). */
    assets: assets as [ResolvedAsset, ...ResolvedAsset[]],
    /** The first entry of `assets` (the only one for a config written with `asset`). */
    asset: assets[0]!,
    /** The top-level `facilitator`, which is also `facilitators.default`. */
    facilitator,
    /** Every facilitator by name, the top-level one as "default". */
    facilitators,
  };
}

/**
 * The gateway config (`cascet.config.json`).
 *
 * The parsed config lists its tokens in `assets` (the `asset` form becomes a
 * one-entry list, also kept as `asset`), each with its authorization style and
 * facilitator resolved, and every facilitator in `facilitators`, the top-level
 * `facilitator` as "default". Configs written for earlier versions parse
 * unchanged.
 */
export const cascetConfigSchema = rawConfigSchema.transform((raw, ctx) => {
  const issues: Issues = [];
  const resolved = resolveConfig(raw, issues);
  for (const issue of issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  if (!resolved || issues.length > 0) return z.NEVER;
  return resolved;
});

export type Upstream = z.infer<typeof upstreamSchema>;
export type ToolPrice = z.infer<typeof toolPriceSchema>;
/** One entry of `asset` / `assets` as written, with field defaults applied. */
export type AssetConfig = z.infer<typeof assetSchema>;
export type CascetConfig = z.output<typeof cascetConfigSchema>;
/** What a config file may contain (before defaults and resolution). */
export type CascetConfigInput = z.input<typeof cascetConfigSchema>;
export type TimeoutsConfig = z.infer<typeof timeoutsSchema>;
export type SettlementConfig = z.infer<typeof settlementSchema>;
export type AnchoringConfig = NonNullable<CascetConfig["anchoring"]>;

/** The facilitator that settles `asset`. */
export function facilitatorFor(cfg: Pick<CascetConfig, "facilitators">, asset: Pick<ResolvedAsset, "facilitator" | "id">): FacilitatorConfig {
  const entry = Object.hasOwn(cfg.facilitators, asset.facilitator) ? cfg.facilitators[asset.facilitator] : undefined;
  if (!entry) throw new Error(`asset "${asset.id}" names unknown facilitator "${asset.facilitator}"`);
  return entry;
}

/** The Authorization header value for `facilitator`, or undefined without an apiKey. */
export function facilitatorAuthorization(facilitator: Pick<FacilitatorConfig, "apiKey" | "authScheme">): string | undefined {
  if (!facilitator.apiKey) return undefined;
  return facilitator.authScheme === "bearer" ? `Bearer ${facilitator.apiKey}` : facilitator.apiKey;
}

/** Effective request timeouts of `facilitator`: its own `timeoutMs`, else the gateway's `timeouts`. */
export function facilitatorTimeouts(
  cfg: Pick<CascetConfig, "timeouts">,
  facilitator: Pick<FacilitatorConfig, "timeoutMs">,
): { verifyMs: number; settleMs: number } {
  return {
    verifyMs: facilitator.timeoutMs ?? cfg.timeouts.facilitatorMs,
    settleMs: facilitator.timeoutMs ?? cfg.timeouts.settleMs,
  };
}

/** What {@link paymentWindowSeconds} reads of a config. */
type PaymentWindowConfig = Pick<CascetConfig, "facilitators" | "timeouts" | "settlement" | "anchoring"> & {
  assets: ReadonlyArray<Pick<ResolvedAsset, "id" | "facilitator">>;
};

/** The payment window in seconds, and what it is made of in milliseconds (see {@link paymentWindowSeconds}). */
function paymentWindow(cfg: PaymentWindowConfig) {
  const nodeUrl = cfg.settlement.nodeUrl ?? cfg.anchoring?.nodeUrl;
  let preflightMs = 0;
  let verifyMs = 0;
  let settleMs = 0;
  for (const asset of cfg.assets) {
    const facilitator = facilitatorFor(cfg, asset);
    const timeouts = facilitatorTimeouts(cfg, facilitator);
    verifyMs = Math.max(verifyMs, timeouts.verifyMs);
    settleMs = Math.max(settleMs, timeouts.settleMs);
    if (nodeUrl && isHostedFacilitatorUrl(facilitator.url)) preflightMs = HOSTED_PREFLIGHT_MS;
  }
  const upstreamMs = cfg.timeouts.upstreamMs;
  const seconds = Math.max(MIN_PAYMENT_WINDOW_SECONDS, Math.ceil((preflightMs + verifyMs + upstreamMs + settleMs) / 1_000) + SETTLE_HEADROOM_SECONDS);
  return { seconds, preflightMs, verifyMs, upstreamMs, settleMs };
}

/**
 * The validity window, in seconds, the gateway asks buyers to sign (x402
 * `maxTimeoutSeconds`), sized as @cascet/gateway sizes it: its on-chain
 * preflight (when the hosted facilitator settles some asset and a node is
 * configured), the slowest facilitator's verify, the tool, the slowest
 * settle and 30 s for the settle transaction; never below 300 s. The config
 * schema refuses a window above {@link DEFAULT_MAX_AUTHORIZATION_SECONDS}.
 */
export function paymentWindowSeconds(cfg: PaymentWindowConfig): number {
  return paymentWindow(cfg).seconds;
}

/** The assets a price accepts, in config order: those it lists in `assets`, or all of them. */
export function assetsForPrice(cfg: Pick<CascetConfig, "assets">, price: Pick<ToolPrice, "assets">): ResolvedAsset[] {
  const wanted = price.assets;
  return wanted ? cfg.assets.filter(asset => wanted.includes(asset.id)) : [...cfg.assets];
}

/**
 * Convert a "$0.001" money string into raw CEP-18 token units per the asset
 * config. Done entirely in integer/BigInt space (both the price and the rate are
 * treated as exact decimal fractions) — IEEE-754 float math would silently lose
 * precision for high-decimal tokens and could round a small price to 0.
 */
export function usdPriceToTokenUnits(price: string, asset: Pick<AssetConfig, "tokensPerUsd" | "decimals">): bigint {
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

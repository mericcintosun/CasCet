import {
  DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE,
  isAuthorizationStyle,
  isKnownCep3009Asset,
  isLegacyAmountToken,
  type AuthorizationStyle,
} from "@cascet/core";
import { TokenUnsupportedError, type TokenProbe } from "@cascet/gateway";
import { knownAuthorizationStyle, logText, normalizeAsset, type AssetPolicy } from "./facilitator-core.js";
import { AMOUNT_ARGUMENT_BY_STYLE } from "./settlement.js";

/**
 * The assets a self-hosted facilitator settles, each in its own authorization
 * style with its own EIP-712 domain pins and gas limit.
 *
 * Start-up runs in two phases:
 *  1. {@link planAssets}, before the key is loaded or the chain is read:
 *     normalize the configuration and refuse what is wrong on its face
 *     (malformed or duplicate hashes, a style CasCet knows to be wrong, a gas
 *     limit below the measured consumption of the asset's known style, and,
 *     without the on-chain preflight, an asset whose style or name nothing
 *     pins);
 *  2. {@link resolveAssetPolicies}, with the token probe: read every asset's
 *     `transfer_with_authorization` ABI, `chain_name` and `name`, refuse to
 *     start when the chain contradicts the configuration or when the token's
 *     EIP-712 domain cannot be checked (no `chain_name`, or a name neither
 *     on-chain nor pinned), and pin the style and name each asset is settled
 *     with from then on. Every request reads the (cached) ABI again and
 *     refuses payments when it changed.
 */

/** One asset of the facilitator's allowlist, as configured. */
export interface FacilitatorAssetOptions {
  /** Contract package hash: bare 64 hex, or hash-, contract-package- or package- prefixed. */
  packageHash: string;
  /**
   * Expected authorization style. The token's on-chain ABI must agree, at
   * start-up and on every request. Default: the style CasCet knows for the
   * token (its own x402 token: `legacy-amount`), else whatever the ABI shows.
   * Required with the preflight off for a token CasCet does not know.
   */
  authorization?: AuthorizationStyle;
  /**
   * Pinned EIP-712 domain name (`extra.name`). Default: the token's on-chain
   * `name`, read at start-up. Required with the preflight off.
   */
  name?: string;
  /** Pinned EIP-712 domain version (`extra.version`). Default "1". */
  version?: string;
  /** Gas limit (motes) of each settle of this asset. Default: its style's (see {@link DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE}). */
  paymentMotes?: number;
}

/**
 * Lowest gas limit per style, below which a settle is likely to run out of gas
 * and revert, burning the whole limit:
 *  - `legacy-amount`: 3 CSPR. Settles of CasCet's token consumed 2.68–2.71 CSPR
 *    (mainnet tx 2c66141c…, testnet tx 04e54a95…).
 *  - `cep3009-value`: 1.5 CSPR, about 1.3 × the 1.13 CSPR a Wrapped CSPR settle
 *    of the hosted facilitator consumed on testnet. The default stays at
 *    3.5 CSPR until CasCet's own settles are measured.
 */
export const MIN_SETTLE_PAYMENT_MOTES_BY_STYLE: Readonly<Record<AuthorizationStyle, number>> = Object.freeze({
  "legacy-amount": 3_000_000_000,
  "cep3009-value": 1_500_000_000,
});
/** No style accepts a gas limit below this. */
export const MIN_ANY_STYLE_PAYMENT_MOTES = Math.min(...Object.values(MIN_SETTLE_PAYMENT_MOTES_BY_STYLE));
/** Every style accepts a gas limit from this up (a limit that applies to tokens of any style must reach it). */
export const MIN_EVERY_STYLE_PAYMENT_MOTES = Math.max(...Object.values(MIN_SETTLE_PAYMENT_MOTES_BY_STYLE));
/** Lane 4 limit; nothing a settle needs comes close. */
export const MAX_SETTLE_PAYMENT_MOTES = 100_000_000_000;
/** Above this a settle leaves wasm lane 5 (40 tx/block) for lane 4 (2 tx/block). */
export const LANE5_MAX_PAYMENT_MOTES = 5_000_000_000;

/** Total time the start-up reads of one asset may take (package, contract, name, chain_name, retries). */
export const STARTUP_PROBE_DEADLINE_MS = 30_000;

/** An asset after phase 1: normalized, with what the configuration (or CasCet) already knows. */
export interface AssetPlan {
  asset: string;
  /** The style the chain must show: configured, or known for the token. */
  expectedStyle?: AuthorizationStyle;
  name?: string;
  version: string;
  paymentMotes?: number;
}

export interface PlanOptions {
  network: string;
  /** Whether start-up and every request read the token on-chain. */
  preflight: boolean;
  /** Version for assets without their own. Default "1". */
  defaultVersion?: string;
  /** Gas limit for assets without their own. Default: per style. */
  defaultPaymentMotes?: number;
  /** Where the settings came from, for error messages (e.g. "assets[1]" or "CASCET_ASSET_STYLES"). */
  label?: (index: number, field: "packageHash" | "authorization" | "name" | "version" | "paymentMotes") => string;
}

const short = (hex: string) => `${hex.slice(0, 8)}…`;
const PRINTABLE = /^[^\u0000-\u001f\u007f]+$/;

/** Check an EIP-712 domain string (name or version). */
export function checkDomainString(value: string, what: string, maxLength: number): string {
  const s = value.trim();
  if (s === "" || s.length > maxLength || !PRINTABLE.test(s)) throw new Error(`${what} must be 1 to ${maxLength} printable characters`);
  return s;
}

/** Check a gas limit against the minimum of `style` (or of any style when it is not known yet). */
export function checkPaymentMotes(motes: number, style: AuthorizationStyle | undefined, what: string): number {
  const min = style ? MIN_SETTLE_PAYMENT_MOTES_BY_STYLE[style] : MIN_ANY_STYLE_PAYMENT_MOTES;
  if (!Number.isSafeInteger(motes) || motes < min || motes > MAX_SETTLE_PAYMENT_MOTES) {
    throw new Error(
      `${what} must be between ${min} and ${MAX_SETTLE_PAYMENT_MOTES}${style ? ` for a ${style} token` : ""}: ` +
        "a settle that runs out of gas reverts and burns the whole limit",
    );
  }
  return motes;
}

/** Phase 1: normalize and check the configured assets without touching the chain. */
export function planAssets(assets: readonly FacilitatorAssetOptions[], opts: PlanOptions): AssetPlan[] {
  const label = opts.label ?? ((i: number, field: string) => `assets[${i}].${field}`);
  const seen = new Set<string>();
  return assets.map((spec, i) => {
    let asset: string;
    try {
      asset = normalizeAsset(spec.packageHash);
    } catch (err) {
      throw new Error(`${label(i, "packageHash")}: ${(err as Error).message}`);
    }
    if (seen.has(asset)) throw new Error(`${label(i, "packageHash")}: asset ${short(asset)} is listed twice`);
    seen.add(asset);

    if (spec.authorization !== undefined && !isAuthorizationStyle(spec.authorization)) {
      throw new Error(`${label(i, "authorization")} must be legacy-amount or cep3009-value`);
    }
    // Styles CasCet knows, in both directions: with the preflight off nothing
    // else would catch them, and every settle would revert (Odra MissingArg,
    // User error 64658) and burn the whole gas limit.
    if (spec.authorization === "cep3009-value" && isLegacyAmountToken(asset)) {
      throw new Error(
        `${label(i, "authorization")}: ${short(asset)} is CasCet's x402 token, whose transfer_with_authorization takes \`amount\` (legacy-amount)`,
      );
    }
    if (spec.authorization === "legacy-amount" && isKnownCep3009Asset(opts.network, asset)) {
      throw new Error(
        `${label(i, "authorization")}: ${short(asset)} is a known CEP-3009 token whose transfer_with_authorization takes \`value\` (cep3009-value)`,
      );
    }
    const expectedStyle = spec.authorization ?? knownAuthorizationStyle(opts.network, asset);

    const name = spec.name !== undefined ? checkDomainString(spec.name, label(i, "name"), 100) : undefined;
    const version = checkDomainString(spec.version ?? opts.defaultVersion ?? "1", label(i, "version"), 20);
    const configuredMotes = spec.paymentMotes ?? opts.defaultPaymentMotes;
    const paymentMotes =
      configuredMotes !== undefined ? checkPaymentMotes(configuredMotes, expectedStyle, label(i, "paymentMotes")) : undefined;

    if (!opts.preflight) {
      // Nothing reads the token: its style and domain name must be pinned.
      if (name === undefined) {
        throw new Error(`${label(i, "name")}: with the preflight off, pin the EIP-712 domain name of ${short(asset)} (nothing reads it on-chain)`);
      }
      if (expectedStyle === undefined) {
        throw new Error(
          `${label(i, "authorization")}: with the preflight off, declare the authorization style of ${short(asset)} ` +
            "(legacy-amount or cep3009-value): nothing reads its ABI on-chain, and the wrong one reverts and burns gas",
        );
      }
    }
    return {
      asset,
      ...(expectedStyle ? { expectedStyle } : {}),
      ...(name !== undefined ? { name } : {}),
      version,
      ...(paymentMotes !== undefined ? { paymentMotes } : {}),
    };
  });
}

export interface ResolveOptions {
  network: string;
  /** The token probe; undefined = the preflight is off (the plans must pin style and name). */
  probe?: Pick<TokenProbe, "authorizationStyle" | "tokenName" | "chainName">;
  now?: () => number;
  /** Notes for the operator (a pinned name trusted for a token without an on-chain one, …). */
  warn?: (message: string) => void;
}

/**
 * Phase 2: read every planned asset on-chain (when the preflight is on) and
 * pin how it is settled. Throws when the chain contradicts the configuration
 * or cannot be read: a facilitator that cannot tell how to settle a token
 * must not start.
 */
export async function resolveAssetPolicies(plans: readonly AssetPlan[], opts: ResolveOptions): Promise<AssetPolicy[]> {
  const now = opts.now ?? Date.now;
  const policies: AssetPolicy[] = [];
  for (const plan of plans) {
    let style: AuthorizationStyle;
    let name = plan.name;
    if (opts.probe) {
      const read = { deadlineMs: now() + STARTUP_PROBE_DEADLINE_MS };
      let chainName: string | undefined;
      let onChainName: string | undefined;
      try {
        style = await opts.probe.authorizationStyle(plan.asset, read);
        chainName = await opts.probe.chainName(plan.asset, read);
        onChainName = await opts.probe.tokenName(plan.asset, read);
      } catch (err) {
        if (err instanceof TokenUnsupportedError) {
          throw new Error(`asset ${short(plan.asset)} cannot be settled: ${logText(err.message)}`);
        }
        throw new Error(`could not read asset ${short(plan.asset)} on-chain (${logText(err)}); check CASCET_RPC_URL`);
      }
      if (plan.expectedStyle !== undefined && style !== plan.expectedStyle) {
        throw new Error(
          `asset ${short(plan.asset)} is configured as ${plan.expectedStyle} (\`${AMOUNT_ARGUMENT_BY_STYLE[plan.expectedStyle]}\`), ` +
            `but its transfer_with_authorization takes \`${AMOUNT_ARGUMENT_BY_STYLE[style]}\` (${style}): every settle would revert`,
        );
      }
      // The EIP-712 domain must be checkable on every request (fail closed): a
      // payment signed for another domain reverts on-chain and burns the gas limit.
      if (chainName === undefined) {
        throw new Error(
          `asset ${short(plan.asset)} has no on-chain chain_name: this facilitator cannot tell which chain its EIP-712 domain signs for`,
        );
      }
      if (chainName !== opts.network) {
        throw new Error(
          `asset ${short(plan.asset)} signs for chain_name "${logText(chainName).slice(0, 40)}", not ${opts.network}: ` +
            "every signature would be refused on-chain",
        );
      }
      if (name !== undefined && onChainName !== undefined && name !== onChainName) {
        throw new Error(`asset ${short(plan.asset)}: the pinned EIP-712 name "${name}" is not the token's on-chain name "${logText(onChainName)}"`);
      }
      if (onChainName === undefined) {
        if (name === undefined) {
          throw new Error(
            `asset ${short(plan.asset)} has no on-chain name: pin its EIP-712 domain name ` +
              "(assets[].name, or CASCET_ASSET_NAMES / CASCET_TOKEN_NAME), or every buyer-chosen name would be accepted",
          );
        }
        opts.warn?.(`asset ${short(plan.asset)} has no on-chain name: the pinned name "${name}" is its EIP-712 domain name`);
      }
      name ??= onChainName;
    } else {
      // planAssets made sure both are pinned when nothing reads the chain.
      if (plan.expectedStyle === undefined || plan.name === undefined) {
        throw new Error(`asset ${short(plan.asset)}: its style and name must be pinned when the preflight is off`);
      }
      style = plan.expectedStyle;
    }
    const paymentMotes = checkPaymentMotes(
      plan.paymentMotes ?? DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE[style],
      style,
      `gas limit of asset ${short(plan.asset)}`,
    );
    policies.push({
      asset: plan.asset,
      style,
      ...(name !== undefined ? { name } : {}),
      version: plan.version,
      paymentMotes: BigInt(paymentMotes),
    });
  }
  return policies;
}

/** One line per asset for the start-up log (the name may come from the chain: single line, bounded). */
export function describeAssetPolicy(policy: AssetPolicy): string {
  const style = policy.style ? `${policy.style} (\`${AMOUNT_ARGUMENT_BY_STYLE[policy.style]}\`)` : "style read per request";
  const name = policy.name !== undefined ? `"${logText(policy.name).slice(0, 100)}"` : "(on-chain)";
  return (
    `asset ${short(policy.asset)}: ${style}, name ${name}, ` +
    `version "${policy.version}", gas limit ${policy.paymentMotes !== undefined ? `${policy.paymentMotes} motes` : "per style"}`
  );
}

import { CSPR_DECIMALS, formatAmount, formatCspr } from "./amounts.js";
import { expectedNetMotes, expectedRefundMotes, suggestGasLimitMotes } from "./gas-report.js";
import { buildProxySession, type ProxySessionOptions } from "./odra-proxy.js";

/**
 * Wrapping testnet CSPR into the official Wrapped CSPR (WCSPR), the CEP-3009
 * token (`transfer_with_authorization` takes `value`) that the hosted
 * CSPR.cloud facilitator settles. Its `deposit` entry point is payable: it
 * mints as much WCSPR as CSPR is attached, 1:1 at 9 decimals, to the caller.
 * Attaching CSPR from an account takes Odra's proxy session (odra-proxy.ts).
 */

/** Official Wrapped CSPR on Casper testnet: contract version 8, read on-chain (read-only) on 2026-11-02. */
export const TESTNET_WCSPR = Object.freeze({
  packageHash: "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e",
  name: "Wrapped CSPR",
  symbol: "WCSPR",
  decimals: 9,
  version: "1",
  network: "casper:casper-test",
});

/**
 * Consumption of a WCSPR deposit through a proxy session from an account that
 * already had a cargo purse: testnet 77fb850a… (2026-10-27, a 52,814-byte
 * proxy) consumed 0.9876 CSPR.
 */
export const RECORDED_DEPOSIT_CONSUMED_MOTES = 987_646_582n;
/** Allowance for Odra 2.9.1's larger proxy (184,758 bytes), whose deposit consumption is not measured yet. */
export const ODRA_PROXY_ALLOWANCE_MOTES = 500_000_000n;
/**
 * An account's first proxy call with attached CSPR creates its cargo purse:
 * `create_purse` costs 2.5 CSPR (chainspec host function cost), plus `put_key`
 * (0.1 CSPR) and storing the `__cargo_purse` named key.
 */
export const CARGO_PURSE_SETUP_MOTES = 2_700_000_000n;
/**
 * Default gas limit of a wrap. Generous on purpose: the consumption is an
 * estimate until measured, and running out of gas reverts the wrap and burns
 * the whole limit. The script prints the measured consumption afterwards; pass
 * `--gas-cspr` to use a tighter limit for later wraps.
 */
export const DEFAULT_WRAP_GAS_MOTES = 10_000_000_000n;
/**
 * Bounds of `--gas-cspr`. The 2.5 CSPR floor is CasCet policy, not a node rule
 * (Casper requires a minimum initiator balance, not a minimum limit); the plan
 * also refuses a limit below 1.3 × the estimated consumption ({@link minWrapGasMotes}).
 */
export const MIN_WRAP_GAS_MOTES = 2_500_000_000n;
export const MAX_WRAP_GAS_MOTES = 100_000_000_000n;

/** Estimated gas a wrap consumes, with or without an existing cargo purse. */
export function estimateWrapConsumedMotes(hasCargoPurse: boolean): bigint {
  return RECORDED_DEPOSIT_CONSUMED_MOTES + ODRA_PROXY_ALLOWANCE_MOTES + (hasCargoPurse ? 0n : CARGO_PURSE_SETUP_MOTES);
}

export interface WrapPlan {
  depositMotes: bigint;
  gasLimitMotes: bigint;
  /** Whether the account already has `__cargo_purse`; undefined when it could not be read (assumed not). */
  hasCargoPurse: boolean | undefined;
  estimatedConsumedMotes: bigint;
  estimatedRefundMotes: bigint;
  /** Gas the wrap costs on success: limit − refund. */
  estimatedNetGasMotes: bigint;
  /** Balance the account needs: the deposit plus the whole gas limit, which is charged up front. */
  requiredBalanceMotes: bigint;
  /** Expected total debit on success: deposit + net gas. */
  expectedDebitMotes: bigint;
  /** What a revert costs: the whole gas limit (the deposit is not taken). */
  worstCaseLossMotes: bigint;
}

/**
 * The smallest gas limit a wrap may use: 1.3 × the estimated consumption,
 * rounded up to 0.01 CSPR (the headroom rule of every measured limit,
 * gas-report.ts). The estimate itself is not measured for Odra 2.9.1's proxy,
 * and a wrap that runs out of gas reverts and burns its whole limit. 5.45 CSPR
 * for an account's first wrap, 1.94 CSPR afterwards (MIN_WRAP_GAS_MOTES then
 * governs).
 */
export function minWrapGasMotes(hasCargoPurse: boolean | undefined): bigint {
  return suggestGasLimitMotes([estimateWrapConsumedMotes(hasCargoPurse ?? false)]);
}

/**
 * The expected cost of wrapping `depositMotes`. Refuses a gas limit below
 * {@link minWrapGasMotes}: such a wrap could revert and burn it.
 */
export function planWrap(depositMotes: bigint, gasLimitMotes: bigint, hasCargoPurse: boolean | undefined): WrapPlan {
  if (depositMotes <= 0n) throw new Error("the amount to wrap must be more than 0 CSPR");
  const estimatedConsumedMotes = estimateWrapConsumedMotes(hasCargoPurse ?? false);
  const minimum = minWrapGasMotes(hasCargoPurse);
  if (gasLimitMotes < minimum) {
    throw new Error(
      `a gas limit of ${formatCspr(gasLimitMotes, 2)} CSPR is below ${formatCspr(minimum, 2)} CSPR, 1.3 × the estimated consumption ` +
        `of ${formatCspr(estimatedConsumedMotes, 2)} CSPR; a wrap that runs out of gas reverts and burns its whole limit`,
    );
  }
  const estimatedRefundMotes = expectedRefundMotes(gasLimitMotes, estimatedConsumedMotes);
  const estimatedNetGasMotes = expectedNetMotes(gasLimitMotes, estimatedConsumedMotes);
  return {
    depositMotes,
    gasLimitMotes,
    hasCargoPurse,
    estimatedConsumedMotes,
    estimatedRefundMotes,
    estimatedNetGasMotes,
    requiredBalanceMotes: depositMotes + gasLimitMotes,
    expectedDebitMotes: depositMotes + estimatedNetGasMotes,
    worstCaseLossMotes: gasLimitMotes,
  };
}

/** The plan as aligned report lines. */
export function formatWrapPlan(plan: WrapPlan): string[] {
  const cspr = (motes: bigint) => `${formatAmount(motes, CSPR_DECIMALS)} CSPR`;
  const purse =
    plan.hasCargoPurse === true
      ? "the account has a cargo purse"
      : plan.hasCargoPurse === false
        ? `first proxy call with attached CSPR: +${formatCspr(CARGO_PURSE_SETUP_MOTES, 1)} CSPR to create the cargo purse`
        : "cargo purse unknown, assumed missing";
  return [
    `  deposit (attached value):        ${cspr(plan.depositMotes)} → +${formatAmount(plan.depositMotes, TESTNET_WCSPR.decimals)} ${TESTNET_WCSPR.symbol}`,
    `  gas limit (charged up front):    ${cspr(plan.gasLimitMotes)}`,
    `  estimated gas consumed:          ~${formatCspr(plan.estimatedConsumedMotes, 2)} CSPR (${purse})`,
    `  refund on success (75% unused):  ~${formatCspr(plan.estimatedRefundMotes, 2)} CSPR`,
    `  expected gas cost:               ~${formatCspr(plan.estimatedNetGasMotes, 2)} CSPR`,
    `  expected total debit:            ~${formatCspr(plan.expectedDebitMotes, 2)} CSPR (deposit + gas)`,
    `  if it reverts:                   ${cspr(plan.worstCaseLossMotes)} of gas is burned, nothing is wrapped`,
    `  balance needed to submit:        ${cspr(plan.requiredBalanceMotes)} (deposit + gas limit)`,
  ];
}

/**
 * What wrap-wcspr prints once the wrap executed successfully: the signer's new
 * WCSPR balance and how to hand some to a buyer. A balance that cannot be read
 * (`readBalance` rejects, e.g. the node answers 503 twice) is reported as
 * unknown with a warning, never as a failure: the wrap already succeeded, and
 * a re-run would wrap (and pay gas) again.
 */
export async function wrappedReport(readBalance: () => Promise<bigint>): Promise<{ lines: string[]; warning?: string }> {
  const hint = `give some to a buyer: pnpm --filter @cascet/e2e fund-token ${TESTNET_WCSPR.packageHash} <buyer account hash> <amount> --send`;
  try {
    const after = await readBalance();
    return { lines: [`\nwrapped: the signer now holds ${formatAmount(after, TESTNET_WCSPR.decimals)} ${TESTNET_WCSPR.symbol}`, hint] };
  } catch (err) {
    return {
      lines: [`\nwrapped: the wrap executed; the signer's ${TESTNET_WCSPR.symbol} balance is unknown`, hint],
      warning:
        `could not read the new ${TESTNET_WCSPR.symbol} balance (${err instanceof Error ? err.message : String(err)}); ` +
        "the wrap succeeded, so do not wrap again: check the balance on the explorer",
    };
  }
}

/** The (unsigned) wrap: Odra's proxy session calling WCSPR `deposit` with `depositMotes` attached. */
export function buildWrapTransaction(wasm: Uint8Array, depositMotes: bigint, opts: ProxySessionOptions) {
  if (depositMotes <= 0n) throw new Error("the amount to wrap must be more than 0 CSPR");
  return buildProxySession(wasm, { packageHash: TESTNET_WCSPR.packageHash, entryPoint: "deposit", attachedMotes: depositMotes }, opts);
}

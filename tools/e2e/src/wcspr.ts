import { CSPR_DECIMALS, formatAmount, formatCspr } from "./amounts.js";
import { expectedNetMotes, expectedRefundMotes } from "./gas-report.js";
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
 * The expected cost of wrapping `depositMotes`. Refuses a gas limit below the
 * estimated consumption: such a wrap would most likely revert and burn it.
 */
export function planWrap(depositMotes: bigint, gasLimitMotes: bigint, hasCargoPurse: boolean | undefined): WrapPlan {
  if (depositMotes <= 0n) throw new Error("the amount to wrap must be more than 0 CSPR");
  const estimatedConsumedMotes = estimateWrapConsumedMotes(hasCargoPurse ?? false);
  if (gasLimitMotes < estimatedConsumedMotes) {
    throw new Error(
      `a gas limit of ${formatCspr(gasLimitMotes, 2)} CSPR is below the estimated consumption of ${formatCspr(estimatedConsumedMotes, 2)} CSPR; ` +
        "a wrap that runs out of gas reverts and burns its whole limit",
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

/** The (unsigned) wrap: Odra's proxy session calling WCSPR `deposit` with `depositMotes` attached. */
export function buildWrapTransaction(wasm: Uint8Array, depositMotes: bigint, opts: ProxySessionOptions) {
  if (depositMotes <= 0n) throw new Error("the amount to wrap must be more than 0 CSPR");
  return buildProxySession(wasm, { packageHash: TESTNET_WCSPR.packageHash, entryPoint: "deposit", attachedMotes: depositMotes }, opts);
}

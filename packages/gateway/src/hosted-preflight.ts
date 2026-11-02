import type { BeforeVerifyHook } from "@x402/core/server";
import { normalizePackageHash, type ResolvedAsset } from "@cascet/core";
import { log, logSafe } from "./log.js";
import { TokenUnsupportedError, type TokenProbe } from "./token-probe.js";

/**
 * Gateway-side preflight of payments that the hosted facilitator settles.
 *
 * CasCet's self-hosted facilitator checks every payment against the token's
 * on-chain state before it verifies or settles it. The hosted facilitator
 * (@x402/casper 2.29) does not do so reliably: its nonce pre-check reads a
 * dictionary these tokens do not have and takes the error for "unused". An
 * authorization whose nonce was already used on-chain therefore passes its
 * verify; in the default run-then-settle mode the tool runs, and the settle
 * reverts and burns the hosted fee payer's gas, once per gateway the
 * authorization is presented to. So the gateway runs the same reads itself,
 * through the shared {@link TokenProbe}, before x402 asks the hosted
 * facilitator to verify:
 *
 * - the token's `transfer_with_authorization` takes the argument of the
 *   asset's configured authorization style (a token upgrade can change it);
 * - the authorization's nonce is unused;
 * - the token's on-chain `name` is the EIP-712 domain name the buyer signed;
 * - the payer's balance covers the amount.
 *
 * Read failures fail closed: when the token state cannot be read within the
 * deadline the payment is refused with `preflight_unavailable` (nothing was
 * charged, the buyer may retry), as the self-hosted facilitator does. A token
 * that cannot be used at all is refused with `unsupported_asset`.
 *
 * The hook never throws. x402 only logs a beforeVerify hook that throws and
 * then verifies anyway, which would turn every failure here into a pass.
 */

/** Total time the preflight of one payment may take: every read, retries included. */
export const HOSTED_PREFLIGHT_DEADLINE_MS = 5_000;

/** The reasons a preflight refuses a payment with (x402 puts them in the 402 `error`). */
export const PreflightReason = {
  invalidPayload: "invalid_payload",
  unsupportedAsset: "unsupported_asset",
  authorizationStyleMismatch: "authorization_style_mismatch",
  nonceAlreadyUsed: "nonce_already_used",
  tokenDomainMismatch: "token_domain_mismatch",
  insufficientFunds: "insufficient_funds",
  preflightUnavailable: "preflight_unavailable",
} as const;

export interface HostedPreflightOptions {
  /** Reads the token state. Its clock must be `now` (read deadlines are absolute). */
  probe: TokenProbe;
  /** CAIP-2 network of the gateway; payments on other networks are not checked here. */
  network: string;
  /** The assets to check: those the hosted facilitator settles. Payments in other assets pass untouched. */
  assets: readonly ResolvedAsset[];
  /** Default {@link HOSTED_PREFLIGHT_DEADLINE_MS}. */
  deadlineMs?: number;
  now?: () => number;
}

type Abort = { abort: true; reason: string; message: string };
const abort = (reason: string, message: string): Abort => ({ abort: true, reason, message });

/** The `beforeVerify` hook that preflights payments in `assets` (see the module comment). */
export function hostedPreflightHook(opts: HostedPreflightOptions): BeforeVerifyHook {
  const guarded = new Map(opts.assets.map(asset => [normalizePackageHash(asset.packageHash), asset]));
  const deadlineMs = opts.deadlineMs ?? HOSTED_PREFLIGHT_DEADLINE_MS;
  const now = opts.now ?? Date.now;

  return async ({ paymentPayload, requirements }) => {
    if (requirements.network !== opts.network) return undefined;
    const asset = guarded.get(normalizePackageHash(requirements.asset));
    if (!asset) return undefined;
    try {
      const authorization = (paymentPayload.payload as { authorization?: { from?: unknown; nonce?: unknown } } | undefined)
        ?.authorization;
      const from = authorization?.from;
      const nonce = authorization?.nonce;
      if (typeof from !== "string" || typeof nonce !== "string") {
        return abort(PreflightReason.invalidPayload, "the payment names no payer or nonce");
      }
      const read = { deadlineMs: now() + deadlineMs };
      const token = asset.packageHash;
      const [style, used, name, balance] = await Promise.all([
        opts.probe.authorizationStyle(token, read),
        opts.probe.isNonceUsed(token, from, nonce, read),
        opts.probe.tokenName(token, read),
        opts.probe.balanceOf(token, from, read),
      ]);
      if (style !== asset.authorization) {
        log.error(`[x402] asset "${logSafe(asset.id, 64)}" is configured as ${asset.authorization}, but its token now takes ${style}`);
        return abort(
          PreflightReason.authorizationStyleMismatch,
          `token ${token} is ${style} on-chain, but the gateway sells it as ${asset.authorization}`,
        );
      }
      if (used) return abort(PreflightReason.nonceAlreadyUsed, "this authorization nonce was already used on-chain");
      const signed = requirements.extra?.name;
      const signedName = typeof signed === "string" ? signed : asset.name;
      if (name !== undefined && name !== signedName) {
        log.error(`[x402] asset "${logSafe(asset.id, 64)}" is configured with name ${logSafe(signedName, 80)}, but its token is named ${logSafe(name, 80)}`);
        return abort(PreflightReason.tokenDomainMismatch, `the EIP-712 domain name must equal the token name "${name}"`);
      }
      const amount = BigInt(requirements.amount);
      if (balance < amount) return abort(PreflightReason.insufficientFunds, `payer balance ${balance} is below ${amount}`);
      return undefined;
    } catch (err) {
      if (err instanceof TokenUnsupportedError) {
        log.error(`[x402] token of asset "${logSafe(asset.id, 64)}" cannot be used for x402 payments: ${logSafe(err)}`);
        return abort(PreflightReason.unsupportedAsset, "the token cannot be used for x402 payments");
      }
      log.warn(`[x402] preflight of a payment in "${logSafe(asset.id, 64)}" failed: ${logSafe(err)}; refusing it`);
      return abort(PreflightReason.preflightUnavailable, "could not read the token state; retry later");
    }
  };
}

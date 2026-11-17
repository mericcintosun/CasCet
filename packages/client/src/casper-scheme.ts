import { readFile } from "node:fs/promises";
import { AUTHORIZATION_STYLE_EXTRA_KEY, AUTHORIZATION_STYLES, isAuthorizationStyle } from "@cascet/core";
import type { ClientCasperSigner } from "@x402/casper";
import { ExactCasperScheme } from "@x402/casper/exact/client";
import type { PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import casperSdk from "casper-js-sdk";
import {
  CONTRACT_PAYEE_REASON,
  DEFAULT_MAX_AUTHORIZATION_SECONDS,
  normalizeNetworks,
  parseRawAmount,
  RAW_AMOUNT_PATTERN,
} from "./policy.js";

const { KeyAlgorithm, PrivateKey } = casperSdk;

export type CasperKeyAlgorithm = "ed25519" | "secp256k1";

/**
 * Prefix of the error a CasCet client scheme throws when it refuses to sign.
 * Nothing has been signed when it is thrown.
 */
export const SIGNING_REFUSED_PREFIX = "refusing to sign: ";

/** The payee form a CasCet client signs for: "00" + account hash. */
const ACCOUNT_PAYEE = /^00[0-9a-f]{64}$/;

/**
 * A `ClientCasperSigner` for @x402/casper from a PEM private key, built with
 * this package's casper-js-sdk. The signer is a plain object on purpose:
 * @x402/casper pins its own casper-js-sdk (5.1.1), so no casper-js-sdk class
 * instance crosses into it.
 */
export function clientSignerFromPem(pem: string, algorithm: CasperKeyAlgorithm = "ed25519"): ClientCasperSigner {
  const key = PrivateKey.fromPem(pem, algorithm === "secp256k1" ? KeyAlgorithm.SECP256K1 : KeyAlgorithm.ED25519);
  const accountAddress = `00${key.publicKey.accountHash().toHex()}`;
  const publicKey = key.publicKey.toHex();
  return {
    accountAddress: () => accountAddress,
    publicKey: () => publicKey,
    signEIP712: async digest => key.signAndAddAlgorithmBytes(digest),
  };
}

/** {@link clientSignerFromPem} for a PEM key file. */
export async function loadClientSigner(privateKeyPath: string, algorithm: CasperKeyAlgorithm = "ed25519"): Promise<ClientCasperSigner> {
  return clientSignerFromPem(await readFile(privateKeyPath, "utf8"), algorithm);
}

export interface CasperClientSchemeOptions {
  /**
   * The CAIP-2 network this scheme signs for (e.g. "casper:casper-test").
   * Requirements that name any other network are refused. Register one scheme
   * per network the client pays on, never a "casper:*" pattern.
   */
  network?: string;
  /** Largest amount, in raw token units, this scheme signs in one authorization. */
  maxAmountPerPayment?: bigint | string;
  /**
   * Longest validity window, in seconds, this scheme signs (default
   * {@link DEFAULT_MAX_AUTHORIZATION_SECONDS}, 900). @x402/casper sets an
   * authorization's `validBefore` to now + `maxTimeoutSeconds`, so this bounds
   * how long a signed authorization stays spendable.
   */
  maxAuthorizationSeconds?: number;
}

/** What one scheme signs at most, resolved when it is built. */
interface SigningLimits {
  network: string | undefined;
  maxAmount: bigint | undefined;
  maxSeconds: number;
}

/**
 * @x402/casper's exact client scheme, without `findDefaultAsset`, behind
 * CasCet's last checks before a signature.
 *
 * Both authorization styles verify the same EIP-712 TransferWithAuthorization
 * message (signed over `value`), so one scheme pays legacy-amount and
 * cep3009-value tokens alike. `findDefaultAsset` is left out because x402's
 * spend controls treat every asset it recognizes (csprUSD) as allowed by
 * default; CasCet's SpendPolicy decides which assets a buyer pays in.
 *
 * The spending policy has accepted the requirements before this runs. The
 * scheme still refuses, without signing, requirements for another network
 * than its own, a payee that is not an account hash ("01" contract packages
 * included, see CONTRACT_PAYEE_REASON), a validity window (`maxTimeoutSeconds`)
 * that is not a whole number of seconds above zero or is longer than
 * `maxAuthorizationSeconds`, an amount that is not a whole number of raw units
 * above zero, an amount above `maxAmountPerPayment` or above the per-payment
 * cap x402's spend controls pass in, and an authorization style it does not know.
 */
export function createCasperClientScheme(signer: ClientCasperSigner, options: CasperClientSchemeOptions = {}): SchemeNetworkClient {
  const maxSeconds = options.maxAuthorizationSeconds ?? DEFAULT_MAX_AUTHORIZATION_SECONDS;
  if (typeof maxSeconds !== "number" || !Number.isSafeInteger(maxSeconds) || maxSeconds <= 0) {
    throw new Error(`maxAuthorizationSeconds must be a positive whole number of seconds; got ${show(maxSeconds)}`);
  }
  const limits: SigningLimits = {
    network: options.network === undefined ? undefined : normalizeNetworks([options.network])[0],
    maxAmount:
      options.maxAmountPerPayment === undefined
        ? undefined
        : parseRawAmount(
            typeof options.maxAmountPerPayment === "bigint" ? options.maxAmountPerPayment.toString() : options.maxAmountPerPayment,
            "maxAmountPerPayment",
          ),
    maxSeconds,
  };
  const inner = new ExactCasperScheme(signer);
  return {
    scheme: inner.scheme,
    createPaymentPayload: async (x402Version, requirements, context) => {
      const refusal = signingRefusal(requirements, limits, context?.maxAmountPerPayment);
      if (refusal !== undefined) throw new Error(`${SIGNING_REFUSED_PREFIX}${refusal}`);
      return inner.createPaymentPayload(x402Version, requirements);
    },
  };
}

/** Why the scheme refuses to sign these requirements, or undefined when it signs. */
function signingRefusal(requirements: PaymentRequirements, limits: SigningLimits, x402Cap: string | undefined): string | undefined {
  const { network, maxAmount, maxSeconds } = limits;
  if (network !== undefined && requirements.network !== network) {
    return `the requirements name network ${show(requirements.network)}, but this scheme signs for ${network} only`;
  }
  const payTo = typeof requirements.payTo === "string" ? requirements.payTo.toLowerCase() : undefined;
  if (payTo === undefined || !ACCOUNT_PAYEE.test(payTo)) {
    return `payTo ${show(requirements.payTo)} is not an account hash ("00" + 64 hex); ${CONTRACT_PAYEE_REASON}`;
  }
  // @x402/casper computes validBefore = now + maxTimeoutSeconds with `+`: a string would be
  // concatenated ("300" signs a validBefore tens of thousands of years away), so only a whole
  // number of seconds within the limit is signed.
  const seconds: unknown = requirements.maxTimeoutSeconds;
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0) {
    return `malformed validity window maxTimeoutSeconds ${show(seconds)} (expected a whole number of seconds above zero)`;
  }
  if (seconds > maxSeconds) return `validity window ${seconds} s is longer than ${maxSeconds} s`;
  const amountText: unknown = requirements.amount;
  if (typeof amountText !== "string" || !RAW_AMOUNT_PATTERN.test(amountText) || BigInt(amountText) <= 0n) {
    return `malformed amount ${show(amountText)} (expected 1-40 decimal digits, above zero)`;
  }
  const amount = BigInt(amountText);
  if (maxAmount !== undefined && amount > maxAmount) return `amount ${amount} exceeds the per-payment cap ${maxAmount}`;
  if (x402Cap !== undefined) {
    if (typeof x402Cap !== "string" || !RAW_AMOUNT_PATTERN.test(x402Cap)) {
      return `malformed spend-control cap ${show(x402Cap)}`;
    }
    if (amount > BigInt(x402Cap)) return `amount ${amount} exceeds the spend-control cap ${x402Cap}`;
  }
  const extra: unknown = requirements.extra;
  const style = typeof extra === "object" && extra !== null ? (extra as Record<string, unknown>)[AUTHORIZATION_STYLE_EXTRA_KEY] : undefined;
  if (style !== undefined && !isAuthorizationStyle(style)) {
    return `unknown authorization style ${show(style)}; this client knows ${AUTHORIZATION_STYLES.join(", ")}`;
  }
  return undefined;
}

function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.length > 80 ? `${value.slice(0, 77)}...` : value);
  // JSON.stringify would print NaN and Infinity as null.
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

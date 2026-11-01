import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { createClientCasperSigner } from "@make-software/casper-x402";
import { ExactCasperScheme } from "@make-software/casper-x402/exact/client";
import casperSdk from "casper-js-sdk";
import { HEADER_CASCET_PARENT_ID, HEADER_PAYMENT_REQUIRED } from "@cascet/core";
import {
  DEFAULT_TIMEOUT_MS,
  decodeBase64Json,
  RequestTimeoutError,
  validateTimeoutMs,
  withDeadline,
  type FetchLike,
} from "./http.js";
import { SpendPolicy } from "./policy.js";

export type { FetchLike } from "./http.js";

const { KeyAlgorithm } = casperSdk;

/** What was authorized, as reported to `onPayment`. */
export interface PaymentInfo {
  /** Raw CEP-18 token units signed over. */
  amountRaw: string;
  /** Payee, serialized Casper Key ("00" + account hash). */
  payTo: string;
  /** CAIP-2 network. */
  network: string;
  /** CEP-18 contract package hash (bare hex). */
  asset: string;
}

export interface PayingFetchOptions {
  /** Path to a PEM-encoded Casper private key. */
  privateKeyPath: string;
  keyAlgorithm?: "ed25519" | "secp256k1";
  /**
   * CAIP-2 networks this client pays on (default `["casper:casper-test"]`).
   * Only these are registered with x402; a 402 that asks for any other network
   * is refused. Add `"casper:casper"` explicitly to pay on mainnet.
   */
  networks?: string[];
  /**
   * Spending limits in raw CEP-18 token units (strings of 1-40 digits, > 0),
   * validated here. The session limit applies per asset. Payments over a limit
   * are refused before anything is signed.
   */
  budget?: {
    maxPerCallRaw?: string;
    maxSessionRaw?: string;
  };
  /**
   * Payees this client may pay: account hashes ("00" + 64 hex or
   * "account-hash-<hex>"). Without it the client signs whatever account a
   * (possibly hostile or MITM'd) server names, so pin the sellers you intend
   * to pay. A one-time warning is logged when it is missing. Contract-package
   * payees ("hash-<hex>") are rejected here and refused in every 402: no
   * facilitator can settle them today (see CONTRACT_PAYEE_REASON).
   */
  allowedPayTo?: string[];
  /**
   * CEP-18 package hashes this client may pay in. Prevents a malicious 402 from
   * swapping in a more valuable token that also supports
   * transfer_with_authorization. A one-time warning is logged when it is missing.
   */
  allowedAssets?: string[];
  /**
   * Cascade parent: payment id of the inbound call this agent is serving.
   * Forwarded as X-CASCET-PARENT-ID so downstream receipts join the chain.
   */
  parentId?: string;
  /** Called after each payment authorization has been signed. */
  onPayment?: (info: PaymentInfo) => void;
  /**
   * Deadline for one `fetch` call in ms, covering the first request, the 402,
   * signing and the paid retry (default 30000). A caller's own `signal` is
   * honored as well. Note that a timed-out paid call may still settle.
   */
  timeoutMs?: number;
  /** Longest validity window accepted for a signed authorization, in seconds (default 900). */
  maxAuthorizationSeconds?: number;
  /** Receives warnings (default: console.error, i.e. stderr). */
  logger?: (message: string) => void;
}

export interface PayingFetch {
  /** fetch that answers x402 `402` challenges with Casper payments, within the spending policy. */
  fetch: FetchLike;
  /** The same transport (deadline, parent id, no redirects) that never pays. */
  fetchUnpaid?: FetchLike;
  /** Raw token units authorized this session, summed over every asset. */
  spentRaw: () => string;
  /** Raw token units authorized this session, per asset (bare package hash). */
  spentByAsset?: () => Record<string, string>;
}

/** Thrown when the client refuses to pay a 402 (policy, budget, allowlist or network). Nothing was signed. */
export class PaymentRefusedError extends Error {
  override name = "PaymentRefusedError";
}

const OPTION_KEYS = new Set<string>([
  "privateKeyPath",
  "keyAlgorithm",
  "networks",
  "budget",
  "allowedPayTo",
  "allowedAssets",
  "parentId",
  "onPayment",
  "timeoutMs",
  "maxAuthorizationSeconds",
  "logger",
]);
const BUDGET_KEYS = new Set<string>(["maxPerCallRaw", "maxSessionRaw"]);

const defaultLogger = (message: string): void => console.error(message);
const warned = new WeakMap<(message: string) => void, Set<string>>();

/** Build a fetch that transparently answers x402 challenges with Casper payments. */
export async function createPayingFetch(opts: PayingFetchOptions): Promise<PayingFetch> {
  // Unknown keys are an error, so a renamed or misspelled safety option can never be ignored silently (M23).
  assertKnownKeys(opts, OPTION_KEYS, "createPayingFetch");
  if (opts.budget !== undefined) assertKnownKeys(opts.budget, BUDGET_KEYS, "createPayingFetch budget");
  if (typeof opts.privateKeyPath !== "string" || opts.privateKeyPath.trim() === "") {
    throw new Error("createPayingFetch: privateKeyPath (PEM private key path) is required");
  }
  if (opts.keyAlgorithm !== undefined && opts.keyAlgorithm !== "ed25519" && opts.keyAlgorithm !== "secp256k1") {
    throw new Error(`createPayingFetch: keyAlgorithm must be "ed25519" or "secp256k1"; got ${String(opts.keyAlgorithm)}`);
  }
  if (opts.parentId !== undefined && (typeof opts.parentId !== "string" || !/^[\x21-\x7e]{1,128}$/.test(opts.parentId))) {
    throw new Error("createPayingFetch: parentId must be 1-128 printable ASCII characters");
  }
  const timeoutMs = validateTimeoutMs(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, "createPayingFetch timeoutMs");
  const log = opts.logger ?? defaultLogger;

  const policy = new SpendPolicy({
    networks: opts.networks,
    allowedPayTo: opts.allowedPayTo,
    allowedAssets: opts.allowedAssets,
    maxPerCallRaw: opts.budget?.maxPerCallRaw,
    maxSessionRaw: opts.budget?.maxSessionRaw,
    maxAuthorizationSeconds: opts.maxAuthorizationSeconds,
  });
  if (!policy.allowedPayTo) {
    warnOnce(
      log,
      "allowedPayTo",
      "[cascet] WARNING: no allowedPayTo: this client will pay ANY account a gateway names. " +
        "Pin your sellers with allowedPayTo (CASCET_ALLOWED_PAYTO for cascet connect).",
    );
  }
  if (!policy.allowedAssets) {
    warnOnce(
      log,
      "allowedAssets",
      "[cascet] WARNING: no allowedAssets: this client will pay in ANY token a gateway names. " +
        "Pin the token with allowedAssets (CASCET_ALLOWED_ASSETS for cascet connect).",
    );
  }
  if (policy.maxPerCall === undefined && policy.maxSession === undefined) {
    warnOnce(
      log,
      "budget",
      "[cascet] WARNING: no budget: every payment the policy allows is signed, with no per-call or session limit.",
    );
  }

  const algorithm = opts.keyAlgorithm === "secp256k1" ? KeyAlgorithm.SECP256K1 : KeyAlgorithm.ED25519;
  const signer = await createClientCasperSigner(opts.privateKeyPath, algorithm);

  // Register the exact scheme ONLY for the networks this client pays on, never "casper:*" (M02).
  const scheme = new ExactCasperScheme(signer);
  const client = new x402Client();
  for (const network of policy.networks) client.register(network as `${string}:${string}`, scheme);

  // Reservations made by the policy, keyed by the selected requirements object
  // that x402 hands to the before, after and failure hooks of one payment.
  const reservations = new WeakMap<object, { asset: string; amount: bigint; payTo: string; network: string }>();
  client
    .onBeforePaymentCreation(async ctx => {
      const decision = policy.authorize(ctx.selectedRequirements);
      if (!decision.ok) return { abort: true as const, reason: decision.reason };
      reservations.set(ctx.selectedRequirements, decision);
      return undefined;
    })
    .onAfterPaymentCreation(async ctx => {
      const reserved = reservations.get(ctx.selectedRequirements);
      reservations.delete(ctx.selectedRequirements);
      if (!reserved || !opts.onPayment) return;
      try {
        opts.onPayment({
          amountRaw: reserved.amount.toString(),
          payTo: reserved.payTo,
          network: reserved.network,
          asset: reserved.asset,
        });
      } catch (err) {
        log(`[cascet] onPayment callback threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
    .onPaymentCreationFailure(async ctx => {
      // Signing failed after the budget was reserved; no authorization exists, so give it back.
      const reserved = reservations.get(ctx.selectedRequirements);
      reservations.delete(ctx.selectedRequirements);
      if (reserved) policy.release(reserved.asset, reserved.amount);
      return undefined;
    });
  const httpClient = new x402HTTPClient(client);

  // NOTE: wrapFetchWithPayment calls this with a Request object. Passing a fresh
  // `headers` init alongside a Request REPLACES all its headers (dropping
  // content-type), so the parent id is set on a rebuilt Request instead.
  // Redirects are refused: following one would forward PAYMENT-SIGNATURE and the
  // parent id to whatever origin the redirect names.
  const baseFetch: FetchLike = (input, init) => {
    const request = new Request(input, { ...init, redirect: "error" });
    if (opts.parentId) request.headers.set(HEADER_CASCET_PARENT_ID, opts.parentId);
    return fetch(request);
  };

  const paidFetch: FetchLike = async (input, init) => {
    let offeredNetworks: string[] | undefined;
    const observed: FetchLike = async (i, n) => {
      const response = await baseFetch(i, n);
      if (response.status === 402) offeredNetworks = networksOffered(response.headers);
      return response;
    };
    try {
      return await withDeadline(wrapFetchWithPayment(observed, httpClient), timeoutMs)(input, init);
    } catch (err) {
      throw explainPaymentError(err, offeredNetworks, policy.networks);
    }
  };

  return {
    fetch: paidFetch,
    fetchUnpaid: withDeadline(baseFetch, timeoutMs),
    spentRaw: () => policy.spentTotal().toString(),
    spentByAsset: () => policy.spentByAsset(),
  };
}

/** Turn x402's generic errors into a PaymentRefusedError with a readable reason where possible. */
function explainPaymentError(err: unknown, offered: string[] | undefined, allowed: readonly string[]): unknown {
  if (!(err instanceof Error) || err instanceof RequestTimeoutError) return err;
  const aborted = /Payment creation aborted: ([\s\S]*)$/.exec(err.message);
  if (aborted) return new PaymentRefusedError(`payment refused: ${aborted[1]}`, { cause: err });
  if (err.message.includes("No network/scheme registered")) {
    const asked = offered && offered.length > 0 ? offered.join(", ") : "a network this client does not pay on";
    return new PaymentRefusedError(
      `payment refused: the gateway asks for payment on ${asked}, but this client only pays on ${allowed.join(", ")} ` +
        "(networks option / CASCET_NETWORK)",
      { cause: err },
    );
  }
  if (err.cause instanceof Error && /redirect/i.test(err.cause.message)) {
    return new Error(
      "the gateway answered with a redirect; CasCet does not follow redirects (payment headers must not reach another origin). Use the final gateway URL.",
      { cause: err },
    );
  }
  return err;
}

function networksOffered(headers: Headers): string[] | undefined {
  const accepts = decodeBase64Json(headers.get(HEADER_PAYMENT_REQUIRED))?.accepts;
  if (!Array.isArray(accepts)) return undefined;
  const networks = accepts
    .map(option => (typeof option === "object" && option !== null ? (option as { network?: unknown }).network : undefined))
    .filter((network): network is string => typeof network === "string")
    .map(network => network.slice(0, 64));
  return networks.length > 0 ? [...new Set(networks)] : undefined;
}

function assertKnownKeys(value: object, known: ReadonlySet<string>, label: string): void {
  if (typeof value !== "object" || value === null) throw new Error(`${label}: options must be an object`);
  const unknown = Object.keys(value).filter(key => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label}: unknown option(s) ${unknown.join(", ")} (known: ${[...known].join(", ")})`);
  }
}

function warnOnce(log: (message: string) => void, key: string, message: string): void {
  let seen = warned.get(log);
  if (!seen) {
    seen = new Set();
    warned.set(log, seen);
  }
  if (seen.has(key)) return;
  seen.add(key);
  log(message);
}

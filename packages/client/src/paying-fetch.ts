import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import type { PaymentPolicy, SpendControlAsset, SpendControls } from "@x402/core/client";
import type { Network, PaymentRequirements } from "@x402/core/types";
import type { ClientCasperSigner } from "@x402/casper";
import {
  AUTHORIZATION_STYLE_EXTRA_KEY,
  defaultAuthorizationStyle,
  HEADER_CASCET_PARENT_ID,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_SIGNATURE,
  isAuthorizationStyle,
  type AuthorizationStyle,
} from "@cascet/core";
import { createCasperClientScheme, loadClientSigner, SIGNING_REFUSED_PREFIX } from "./casper-scheme.js";
import {
  DEFAULT_TIMEOUT_MS,
  decodeBase64Json,
  readTextCapped,
  RequestTimeoutError,
  validateTimeoutMs,
  withDeadline,
  type FetchLike,
} from "./http.js";
import { normalizePreferStyles, SpendPolicy, type SpendDecision } from "./policy.js";

export type { FetchLike } from "./http.js";

/**
 * Largest 402 body handed to @x402/fetch. @x402/fetch 2.29 caps the bodies it
 * reads at 1 MiB itself; CasCet gateways send a few bytes, so this client
 * refuses anything above 64 KiB before x402 sees it.
 */
export const MAX_402_BODY_BYTES = 64 * 1024;

/**
 * x402 spend controls of a CasCet client without an asset allowlist. By default
 * @x402/core 2.29 pays only assets its scheme recognizes as defaults (for
 * Casper: csprUSD), capped at $1, and drops every other offer, including
 * CasCet's own tokens and Wrapped CSPR, before selection. CasCet enforces its
 * own rules in {@link SpendPolicy} (network, payee and asset allowlists,
 * raw-unit per-call and session budgets, validity window), so without an
 * allowlist x402's controls are opened up. See {@link buildSpendControls}.
 */
export const CASCET_SPEND_CONTROLS: Readonly<SpendControls> = Object.freeze({ allowedAssets: true, maxAmountPerPayment: false });

/**
 * x402 spend controls derived from a spending policy, so that x402 enforces
 * the asset allowlist and the per-call budget on its own too, before CasCet's
 * policy runs:
 *
 * - no asset allowlist: {@link CASCET_SPEND_CONTROLS} (any asset, no cap);
 *   the policy still applies the per-call budget;
 * - an asset allowlist: one entry per (network, asset) the client pays,
 *   capped at the per-call budget when there is one, and no USD cap (CasCet
 *   budgets are raw token units). Nothing else is allowed: the CasCet client
 *   scheme has no default assets.
 */
export function buildSpendControls(policy: Pick<SpendPolicy, "networks" | "allowedAssets" | "maxPerCall">): SpendControls {
  if (!policy.allowedAssets) return { ...CASCET_SPEND_CONTROLS };
  const cap = policy.maxPerCall?.toString();
  const allowedAssets: SpendControlAsset[] = [];
  for (const network of policy.networks) {
    for (const asset of policy.allowedAssets) {
      allowedAssets.push({ network: network as Network, asset, ...(cap !== undefined ? { maxAmountPerPayment: cap } : {}) });
    }
  }
  return { allowedAssets, maxAmountPerPayment: false };
}

/**
 * x402 payment policy that keeps the options `policy` would accept, so that a
 * 402 offering several (assets, payees) selects one this client pays. It
 * reserves nothing: the before-payment hook makes the binding decision. When
 * no option passes, every option is kept, so that hook refuses with the
 * precise reason instead of x402's generic "filtered out by policies".
 */
export function spendPolicyFilter(policy: Pick<SpendPolicy, "check">): PaymentPolicy {
  return (_x402Version, requirements) => {
    const acceptable = requirements.filter(option => policy.check(option).ok);
    return acceptable.length > 0 ? acceptable : requirements;
  };
}

/**
 * The authorization style of a payment option: the one it advertises in
 * `extra.authorizationStyle`, else the one its token is known to use (see
 * `defaultAuthorizationStyle` in @cascet/core). Undefined for a style this
 * client does not know. Used to order options, never to accept one.
 */
export function optionAuthorizationStyle(requirements: PaymentRequirements): AuthorizationStyle | undefined {
  const extra: unknown = requirements.extra;
  const advertised =
    typeof extra === "object" && extra !== null ? (extra as Record<string, unknown>)[AUTHORIZATION_STYLE_EXTRA_KEY] : undefined;
  if (advertised !== undefined) return isAuthorizationStyle(advertised) ? advertised : undefined;
  return typeof requirements.asset === "string" ? defaultAuthorizationStyle(requirements.asset) : undefined;
}

/**
 * x402 payment policy that orders options by authorization style, most
 * preferred first. Options of the same rank, and options whose style is not
 * listed, keep the gateway's order. It never drops an option. Register it
 * after {@link spendPolicyFilter} so that it only orders acceptable options.
 */
export function preferStylesPolicy(order: readonly AuthorizationStyle[]): PaymentPolicy {
  const rank = (requirements: PaymentRequirements): number => {
    const style = optionAuthorizationStyle(requirements);
    const index = style === undefined ? -1 : order.indexOf(style);
    return index < 0 ? order.length : index;
  };
  return (_x402Version, requirements) =>
    requirements
      .map((option, index) => ({ option, index, rank: rank(option) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map(entry => entry.option);
}

/** At most this many distinct reasons are listed when every option of a 402 is refused. */
const MAX_REFUSAL_REASONS = 4;

/**
 * Why `policy` refuses every payment option of a 402, or undefined when it
 * accepts at least one. Nothing is reserved. A 402 that only names networks
 * the client does not pay on gets one message naming them.
 */
export function refusalReason(policy: Pick<SpendPolicy, "check" | "networks">, accepts: readonly unknown[]): string | undefined {
  if (accepts.length === 0) return "the gateway's 402 offers no payment option";
  const reasons: string[] = [];
  for (const option of accepts) {
    const decision = policy.check(option);
    if (decision.ok) return undefined;
    if (!reasons.includes(decision.reason)) reasons.push(decision.reason);
  }
  const networks = accepts.map(networkOf);
  if (networks.every(network => network === undefined || !policy.networks.includes(network))) {
    return networkRefusal(networks, policy.networks);
  }
  if (reasons.length === 1) return reasons[0];
  const listed = reasons.slice(0, MAX_REFUSAL_REASONS);
  const more = reasons.length - listed.length;
  return (
    `none of the ${accepts.length} payment options the gateway offers is acceptable: ${listed.join("; ")}` +
    (more > 0 ? `; and ${more} more reason(s)` : "")
  );
}

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
  /** The token's authorization style, when the gateway advertised it (`extra.authorizationStyle`). */
  authorizationStyle?: AuthorizationStyle;
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
   * It also becomes x402's own spend-control allowlist (see buildSpendControls).
   */
  allowedAssets?: string[];
  /**
   * Authorization styles in order of preference, e.g. `["cep3009-value"]` to
   * pay in a CEP-3009 token (such as Wrapped CSPR) when a gateway also offers
   * CasCet's legacy-amount token. It only orders the options the spending
   * policy accepts and never makes another option payable. Without it the
   * gateway's order decides. An option that advertises no style ranks by its
   * token's known style.
   */
  preferStyles?: AuthorizationStyle[];
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
  "preferStyles",
  "parentId",
  "onPayment",
  "timeoutMs",
  "maxAuthorizationSeconds",
  "logger",
]);
const BUDGET_KEYS = new Set<string>(["maxPerCallRaw", "maxSessionRaw"]);

const defaultLogger = (message: string): void => console.error(message);
const warned = new WeakMap<(message: string) => void, Set<string>>();

export interface PaymentClientOptions {
  /** The spending rules; its session budget is reserved by the before-payment hook. */
  policy: SpendPolicy;
  /** The buyer's key, as @x402/casper's structural signer (see loadClientSigner). */
  signer: ClientCasperSigner;
  /** Authorization styles in order of preference (see PayingFetchOptions.preferStyles). */
  preferStyles?: readonly AuthorizationStyle[];
  /** Called after each payment authorization has been signed. */
  onPayment?: (info: PaymentInfo) => void;
  /** Receives warnings (default: console.error). */
  log?: (message: string) => void;
}

/**
 * The x402 client behind {@link createPayingFetch}:
 *
 * - one exact scheme per network the policy pays on, bound to that network
 *   (never a "casper:*" pattern) and capped at the per-call budget and the
 *   policy's longest validity window;
 * - x402's spend controls derived from the policy ({@link buildSpendControls});
 * - the policy filter, then the optional style preference, before selection;
 * - hooks that reserve the budget before signing (the binding decision,
 *   atomic with selection), report the payment after signing and give the
 *   reservation back when signing fails.
 *
 * It registers no payment-response hook: @x402/fetch 2.29 would sign a second
 * payment when one reports `{ recovered: true }`.
 */
export function createPaymentClient(opts: PaymentClientOptions): x402Client {
  const { policy, onPayment } = opts;
  const preferStyles = normalizePreferStyles(opts.preferStyles);
  const log = opts.log ?? defaultLogger;
  const client = new x402Client();
  // @x402/casper signs both authorization styles the same way (one EIP-712 message), and each
  // scheme refuses to sign above the per-call budget or for longer than the policy's validity
  // window even if every check before it were bypassed.
  for (const network of policy.networks) {
    client.register(
      network as Network,
      createCasperClientScheme(opts.signer, {
        network,
        maxAuthorizationSeconds: policy.maxAuthorizationSeconds,
        ...(policy.maxPerCall !== undefined ? { maxAmountPerPayment: policy.maxPerCall } : {}),
      }),
    );
  }
  // x402's own spend controls: the asset allowlist and the per-call cap when there is an
  // allowlist, otherwise opened up (they would only pay csprUSD up to $1). See buildSpendControls.
  client.setSpendControls(buildSpendControls(policy));
  // Choose among several offered options one the policy accepts; the hook below still decides.
  client.registerPolicy(spendPolicyFilter(policy));
  if (preferStyles) client.registerPolicy(preferStylesPolicy(preferStyles));

  // Budget reserved by the policy for each payment being signed, handed back if signing fails.
  const reservations = new PendingReservations<Extract<SpendDecision, { ok: true }>>();
  client
    .onBeforePaymentCreation(async ctx => {
      const decision = policy.authorize(ctx.selectedRequirements);
      if (!decision.ok) {
        // Only reached when no offered option passes (the filter keeps the ones that do), e.g.
        // when a concurrent payment used the budget after the 402 was checked: name every reason.
        const offered: unknown = ctx.paymentRequired?.accepts;
        const reason = (Array.isArray(offered) ? refusalReason(policy, offered) : undefined) ?? decision.reason;
        return { abort: true as const, reason };
      }
      reservations.add(ctx.selectedRequirements, decision);
      return undefined;
    })
    .onAfterPaymentCreation(async ctx => {
      const reserved = reservations.take(ctx.selectedRequirements);
      if (!reserved || !onPayment) return;
      try {
        onPayment({
          amountRaw: reserved.amount.toString(),
          payTo: reserved.payTo,
          network: reserved.network,
          asset: reserved.asset,
          ...(reserved.authorizationStyle ? { authorizationStyle: reserved.authorizationStyle } : {}),
        });
      } catch (err) {
        log(`[cascet] onPayment callback threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
    .onPaymentCreationFailure(async ctx => {
      // Signing failed after the budget was reserved; no authorization exists, so give it back.
      const reserved = reservations.take(ctx.selectedRequirements);
      if (reserved) policy.release(reserved.asset, reserved.amount);
      return undefined;
    });
  return client;
}

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
  const preferStyles = normalizePreferStyles(opts.preferStyles);
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

  const signer = await loadClientSigner(opts.privateKeyPath, opts.keyAlgorithm ?? "ed25519");
  const client = createPaymentClient({
    policy,
    signer,
    ...(preferStyles ? { preferStyles } : {}),
    ...(opts.onPayment ? { onPayment: opts.onPayment } : {}),
    log,
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
    let offered: unknown[] | undefined;
    let requests = 0;
    const observed: FetchLike = async (i, n) => {
      // @x402/fetch sends the caller's request first, then (this client registers no
      // payment-required or recovery hooks) at most one paid retry.
      const first = ++requests === 1;
      const response = await baseFetch(i, n);
      if (response.status !== 402) return response;
      // @x402/fetch would read an unbounded 402 body into memory (L117): give it a capped copy.
      const text = await readTextCapped(response, MAX_402_BODY_BYTES, "the gateway's 402 response");
      // The challenge to the caller's request: when the policy refuses every option it offers,
      // stop here, before x402 selects or signs anything, with the policy's own reason. A 402
      // that answers the paid retry goes back to the caller as before: that payment was signed.
      if (first) {
        if (carriesPayment(i, n)) {
          // x402 would sign a second payment, then refuse to send it ("Payment already attempted").
          throw new PaymentRefusedError(
            "payment refused: the request already carries an x402 payment header and the gateway answered 402; " +
              "this client does not add a second payment to it",
          );
        }
        offered = acceptsOffered(response.headers);
        const refusal = offered === undefined ? undefined : refusalReason(policy, offered);
        if (refusal !== undefined) throw new PaymentRefusedError(`payment refused: ${refusal}`);
      }
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(text, { status: 402, statusText: response.statusText, headers });
    };
    try {
      return await withDeadline(wrapFetchWithPayment(observed, httpClient), timeoutMs)(input, init);
    } catch (err) {
      throw explainPaymentError(err, offered, policy);
    }
  };

  return {
    fetch: paidFetch,
    fetchUnpaid: withDeadline(baseFetch, timeoutMs),
    spentRaw: () => policy.spentTotal().toString(),
    spentByAsset: () => policy.spentByAsset(),
  };
}

/**
 * Budget reservations of payments being signed, keyed by the requirements
 * object x402 hands to the before, after and failure hooks of one payment.
 * @x402/core (2.17 and 2.29) passes the same object to all three hooks; a content key
 * (network, payTo, asset, amount) still finds the reservation if a later
 * version passes each hook a copy. Payments with the same content reserve the
 * same amount of the same asset, so taking any one of them keeps the budget exact.
 */
export class PendingReservations<T> {
  private readonly byKey = new Map<string, T[]>();
  private readonly keyOf = new WeakMap<object, string>();

  /** Remember the reservation made for these requirements. */
  add(requirements: object, reservation: T): void {
    const key = reservationKey(requirements);
    this.keyOf.set(requirements, key);
    const queue = this.byKey.get(key);
    if (queue) queue.push(reservation);
    else this.byKey.set(key, [reservation]);
  }

  /** Remove and return the reservation made for these requirements (or an identical copy of them). */
  take(requirements: object): T | undefined {
    const key = this.keyOf.get(requirements) ?? reservationKey(requirements);
    this.keyOf.delete(requirements);
    const queue = this.byKey.get(key);
    const reservation = queue?.shift();
    if (queue && queue.length === 0) this.byKey.delete(key);
    return reservation;
  }

  /** Reservations not yet taken. */
  get size(): number {
    let size = 0;
    for (const queue of this.byKey.values()) size += queue.length;
    return size;
  }
}

function reservationKey(requirements: object): string {
  const req = requirements as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : String(value));
  return JSON.stringify([text(req.network), text(req.payTo), text(req.asset), text(req.amount)]);
}

/**
 * x402 errors raised while choosing an option, before any hook runs or anything
 * is signed: no registered network, x402's spend controls, the policies, an
 * unknown payment flow, an x402 version this client does not pay.
 */
const SELECTION_FAILURES = [
  /No network\/scheme registered/,
  /rejected by spendControls/,
  /filtered out by policies/,
  /recognized paymentFlow/,
  /No client registered for x402 version/,
];

/** Turn x402's generic errors into a PaymentRefusedError with a readable reason where possible. */
function explainPaymentError(err: unknown, offered: readonly unknown[] | undefined, policy: SpendPolicy): unknown {
  if (!(err instanceof Error) || err instanceof RequestTimeoutError || err instanceof PaymentRefusedError) return err;
  const aborted = /Payment creation aborted: ([\s\S]*)$/.exec(err.message);
  if (aborted) return new PaymentRefusedError(`payment refused: ${aborted[1]}`, { cause: err });
  const index = err.message.indexOf(SIGNING_REFUSED_PREFIX);
  if (index >= 0) {
    return new PaymentRefusedError(`payment refused: ${err.message.slice(index + SIGNING_REFUSED_PREFIX.length)}`, { cause: err });
  }
  if (SELECTION_FAILURES.some(pattern => pattern.test(err.message))) {
    const reason =
      (offered === undefined ? undefined : refusalReason(policy, offered)) ??
      (err.message.includes("No network/scheme registered")
        ? networkRefusal([], policy.networks)
        : err.message.replace(/^Failed to create payment payload: /, "").slice(0, 300));
    return new PaymentRefusedError(`payment refused: ${reason}`, { cause: err });
  }
  if (err.cause instanceof Error && /redirect/i.test(err.cause.message)) {
    return new Error(
      "the gateway answered with a redirect; CasCet does not follow redirects (payment headers must not reach another origin). Use the final gateway URL.",
      { cause: err },
    );
  }
  return err;
}

/** The payment options of a 402's PAYMENT-REQUIRED header; an empty list when it has none, undefined without the header. */
function acceptsOffered(headers: Headers): unknown[] | undefined {
  const paymentRequired = decodeBase64Json(headers.get(HEADER_PAYMENT_REQUIRED));
  if (paymentRequired === undefined) return undefined;
  return Array.isArray(paymentRequired.accepts) ? paymentRequired.accepts : [];
}

/** Whether a request carries an x402 payment header. */
function carriesPayment(input: Parameters<typeof fetch>[0], init?: RequestInit): boolean {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  return headers.has(HEADER_PAYMENT_SIGNATURE) || headers.has("X-PAYMENT");
}

function networkOf(option: unknown): string | undefined {
  const network = typeof option === "object" && option !== null ? (option as { network?: unknown }).network : undefined;
  return typeof network === "string" ? network : undefined;
}

function networkRefusal(offered: ReadonlyArray<string | undefined>, allowed: readonly string[]): string {
  // Names supplied by the gateway: shortened, with control characters escaped.
  const named = offered
    .filter((network): network is string => network !== undefined)
    .map(network => JSON.stringify(network.slice(0, 64)).slice(1, -1));
  const asked = [...new Set(named)];
  return (
    `the gateway asks for payment on ${asked.length > 0 ? asked.join(", ") : "a network this client does not pay on"}, ` +
    `but this client only pays on ${allowed.join(", ")} (networks option / CASCET_NETWORK)`
  );
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

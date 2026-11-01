import { createServer, type Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
// Default import on purpose: CodeQL's js/missing-rate-limiting model recognizes
// invocations of the "express-rate-limit" module import as rate limiters.
import rateLimit from "express-rate-limit";
import type { Network } from "@x402/core/types";
import { ExactCasperScheme } from "@make-software/casper-x402/exact/facilitator";
import { AuthorizationLedger } from "./authorization-ledger.js";
import { createCasperRpc } from "./casper-rpc.js";
import { assertUsableToken, authorizationMatches, MIN_MAINNET_TOKEN_LENGTH } from "./facilitator-auth.js";
import {
  createFacilitatorCore,
  DEFAULT_MIN_SETTLE_WINDOW_SECONDS,
  DEFAULT_PREFLIGHT_DEADLINE_MS,
  logText,
  normalizeAsset,
  normalizePayTo,
  parsePaymentRequest,
  Reason,
  type FacilitatorCore,
  type FacilitatorLogger,
  type ParsedPayment,
  type SettlementStatus,
} from "./facilitator-core.js";
import {
  DEFAULT_DAILY_GAS_CAP_MOTES,
  DEFAULT_SETTLE_PAYMENT_MOTES,
  DEFAULT_SETTLE_WAIT_MS,
  MAX_SETTLE_PAYMENT_MOTES,
  MIN_SETTLE_PAYMENT_MOTES,
  NETWORKS,
  ownerAccountsFor,
} from "./facilitator-env.js";
import { checkRoleSeparation } from "./facilitator-roles.js";
import { accountsSignableBy } from "./account-keys.js";
import { DailyGasBudget } from "./gas-budget.js";
import { loadSecretKeyFile } from "./key-file.js";
import { createCasperSettlementChain } from "./settlement.js";
import { TokenStateReader } from "./token-state.js";

/**
 * Self-hosted REAL x402 facilitator for Casper.
 *
 * Why this exists: in July 2026 the Casper x402 stack renamed the settle
 * runtime arg `amount` → `value` (CEP-3009, make-software/casper-x402
 * `3ee705ec`) and the hosted CSPR.cloud facilitator
 * (`https://x402-facilitator.cspr.cloud`) followed. CasCet's token is the
 * earlier reference build whose `transfer_with_authorization` expects `amount`,
 * so a hosted settle against it reverts `User error: 64658`
 * (Odra `ExecutionError::MissingArg`). This facilitator verifies with the
 * published `@make-software/casper-x402` 1.0.0 scheme and settles with its own
 * transaction builder (same `amount` argument), fee-sponsored by a Casper key.
 *
 * SECURITY: the fee payer pays real CSPR gas for every settle it submits, and
 * a reverted deploy burns its whole gas limit. The server therefore:
 *   - binds to 127.0.0.1 by default; a non-loopback host requires the token;
 *   - requires a bearer token (constant-time compare) on /verify and /settle —
 *     always on mainnet, where it must be ≥ 32 characters;
 *   - rate-limits per client IP before authentication, and globally plus per
 *     payer on /verify and /settle (express-rate-limit);
 *   - only settles to allowlisted payees and assets (required on mainnet);
 *   - refuses authorizations that expire too soon to be settled in time
 *     (default 20 s; casper-x402 alone accepts 6 s, less than one block);
 *   - keeps an in-flight ledger of (network, asset, from, nonce) until the
 *     authorization can no longer execute, answering duplicates with 409;
 *   - checks on-chain, before submitting, that the nonce is unused, that the
 *     payer's balance covers the value plus everything already in flight, and
 *     that the EIP-712 domain name is the token's (required on mainnet; a
 *     testnet facilitator without it must pin the name);
 *   - re-checks the validity window right before submitting and caps the
 *     transaction's TTL so it can never execute after validBefore;
 *   - caps sponsored gas per UTC day, reserving it only right before
 *     submission and counting the real on-chain cost when known;
 *   - answers "pending"/"unknown" with the transaction hash instead of a
 *     failure when RPC errors hide the outcome;
 *   - refuses to start on mainnet when the fee-payer key is an owner account
 *     (the deployer always counts as one) or a seller account, or when it is
 *     an associated key of one of them (read on-chain at start-up).
 */
export interface RealFacilitatorOptions {
  /** Port to listen on (0 = any free port). */
  port: number;
  /** CAIP-2 network id. Defaults to `casper:casper-test`. */
  network?: Network;
  /** Path to the fee-payer PEM (signs and pays for each settle transaction). */
  keyPath: string;
  /** Fee-payer key algorithm. Defaults to `ed25519`. */
  keyAlgo?: "ed25519" | "secp256k1";
  /** Casper node JSON-RPC URL. Defaults to the public node of the network. */
  rpcUrl?: string;
  /** Gas limit (motes) per settle transaction. Defaults to 4 CSPR; at least 3 CSPR. */
  paymentMotes?: number;
  /** Interface to bind. Defaults to 127.0.0.1 (not remotely reachable). */
  host?: string;
  /** Shared secret expected in the `Authorization` header (raw or `Bearer …`). Required on mainnet. */
  authToken?: string;
  /** Payees (serialized account-hash Keys "00…") this facilitator settles to. Required on mainnet. */
  allowedPayTo?: string[];
  /** CEP-18 package hashes this facilitator settles. Required on mainnet. */
  allowedAssets?: string[];
  /**
   * Owner accounts (e.g. a new ReceiptRegistry owner); the fee payer must be none
   * of them. On mainnet the CasCet deployer is always added.
   */
  ownerAccountHashes?: string[];
  /** Max settle requests accepted per minute (all payers). Default 60. */
  maxSettlesPerMinute?: number;
  /** Max /verify + /settle requests per minute (all payers). Default 300. */
  maxRequestsPerMinute?: number;
  /** Max /verify + /settle requests per payer per minute. Default 30. */
  maxRequestsPerPayerPerMinute?: number;
  /** Max requests per client IP per minute on any route, before authentication. Default 600. */
  maxRequestsPerIpPerMinute?: number;
  /** Cap on sponsored gas (motes) per UTC day; settles get 503 past it. Default 500 CSPR. */
  dailyGasCapMotes?: bigint;
  /**
   * How long /settle waits for execution before answering "pending" with the
   * hash. Default 60 s; keep it below the gateway's settle timeout
   * (timeouts.settleMs, 90 s by default).
   */
  settleWaitMs?: number;
  /**
   * On-chain nonce / balance / token-name checks before verifying and settling.
   * Default true. Required on mainnet; turning it off elsewhere requires `tokenName`.
   */
  preflight?: boolean;
  /**
   * Total time one request's preflight may take (all reads and retries). Default
   * 10 s; keep it below the gateway's verify timeout (timeouts.facilitatorMs, 15 s).
   */
  preflightDeadlineMs?: number;
  /** Pinned EIP-712 domain version (`extra.version`) of the token. Default "1". */
  tokenVersion?: string;
  /**
   * Pinned EIP-712 domain name (`extra.name`), e.g. "CasCet X402 Token". Checked
   * without RPC; with the preflight on, the on-chain name is checked as well.
   * Required when the preflight is off.
   */
  tokenName?: string;
  /** Reject authorizations that stay valid longer than this. Default 3600 s. */
  maxAuthorizationValiditySeconds?: number;
  /** Reject authorizations that expire sooner than this (at /verify and /settle). Default 20 s. */
  minSettleWindowSeconds?: number;
  /** Per-call RPC timeout. Default 8000 ms. */
  rpcTimeoutMs?: number;
  /** Log sink (defaults to the console with a `[real-facilitator]` prefix). */
  logger?: FacilitatorLogger;
}

export interface RealFacilitatorHandle {
  /**
   * Stop accepting requests (new ones get 503), wait for running /verify and
   * /settle requests to finish and answer, then close. Idempotent.
   */
  close: () => Promise<void>;
  /** Base URL to point the gateway's `facilitator.url` at. */
  url: string;
  /** Account-hash hex of the fee payer that submits settle transactions. */
  feePayer: string;
  network: Network;
  /** Bound port (useful with `port: 0`). */
  port: number;
}

const consoleLogger: FacilitatorLogger = {
  info: m => console.log(`[real-facilitator] ${m}`),
  warn: m => console.warn(`[real-facilitator] ${m}`),
  error: m => console.error(`[real-facilitator] ${m}`),
};

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "::1" || h === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export interface FacilitatorAppOptions {
  network: Network;
  authToken?: string;
  maxSettlesPerMinute: number;
  maxRequestsPerMinute: number;
  maxRequestsPerPayerPerMinute: number;
  maxRequestsPerIpPerMinute: number;
  logger: FacilitatorLogger;
  /** Tracks running /verify and /settle work so a shutdown can wait for it. */
  inFlight?: InFlightRequests;
}

/**
 * Counts /verify and /settle requests whose core work is still running. A
 * settle may already have submitted a transaction: a shutdown waits for it
 * (see {@link closeGracefully}) instead of cutting the connection, which would
 * leave the gateway with an indeterminate outcome and lose the ledger entry.
 */
export class InFlightRequests {
  private count = 0;
  private closing = false;
  private readonly idleWaiters = new Set<() => void>();

  get size(): number {
    return this.count;
  }

  /** True once shutting down: new /verify and /settle requests get 503. */
  get isClosing(): boolean {
    return this.closing;
  }

  close(): void {
    this.closing = true;
  }

  enter(): void {
    this.count++;
  }

  leave(): void {
    if (this.count > 0) this.count--;
    if (this.count === 0) for (const wake of [...this.idleWaiters]) wake();
  }

  /** Resolves true once nothing is in flight, or false after `timeoutMs`. */
  whenIdle(timeoutMs: number): Promise<boolean> {
    if (this.count === 0) return Promise.resolve(true);
    return new Promise(resolve => {
      const done = (idle: boolean) => {
        clearTimeout(timer);
        this.idleWaiters.delete(wake);
        resolve(idle);
      };
      const wake = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      this.idleWaiters.add(wake);
    });
  }
}

/**
 * Stop accepting connections, let running /verify and /settle requests finish
 * and answer (up to `drainTimeoutMs`), then close every remaining connection.
 */
export async function closeGracefully(
  server: Server,
  inFlight: InFlightRequests,
  drainTimeoutMs: number,
  logger: FacilitatorLogger,
): Promise<void> {
  inFlight.close();
  let closed = false;
  const serverClosed = new Promise<void>(resolve =>
    server.close(() => {
      closed = true;
      resolve();
    }),
  );
  if (!(await inFlight.whenIdle(drainTimeoutMs))) {
    logger.warn(
      `shutting down with ${inFlight.size} /verify or /settle request(s) still running after ${drainTimeoutMs} ms; ` +
        "reconcile their settlements by transaction hash or nonce",
    );
  }
  // Answers are written as soon as the core returns: close keep-alive sockets
  // as they become idle, then whatever is left.
  const deadline = Date.now() + 1_000;
  while (!closed && Date.now() < deadline) {
    server.closeIdleConnections();
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  server.closeAllConnections();
  await serverClosed;
}

type RouteKind = "verify" | "settle" | "other";

const routeKind = (req: Request): RouteKind =>
  req.path === "/verify" ? "verify" : req.path === "/settle" ? "settle" : "other";

/**
 * Send a rejection in the shape the caller's x402 client parses for this route.
 * `settlementStatus` (settle only) defaults to not_submitted: everything that is
 * rejected before the core runs has submitted nothing.
 */
function sendRejection(
  req: Request,
  res: Response,
  network: Network,
  status: number,
  reason: string,
  message: string,
  settlementStatus: SettlementStatus = "not_submitted",
): void {
  const kind = routeKind(req);
  if (kind === "verify") {
    res.status(status).json({ isValid: false, invalidReason: reason, invalidMessage: message });
  } else if (kind === "settle") {
    res.status(status).json({
      success: false,
      errorReason: reason,
      errorMessage: message,
      transaction: "",
      network,
      extra: { settlementStatus },
    });
  } else {
    res.status(status).json({ error: reason, message });
  }
}

/**
 * The HTTP surface: rate limiting, authentication, request validation and the
 * x402-shaped error bodies around a {@link FacilitatorCore}. Exported so tests
 * can drive it with a fake core.
 */
export function createFacilitatorApp(core: FacilitatorCore, opts: FacilitatorAppOptions): express.Express {
  const { network, logger } = opts;
  const inFlight = opts.inFlight ?? new InFlightRequests();
  const app = express();
  app.disable("x-powered-by");

  const onLimit = (req: Request, res: Response) => {
    logger.warn(`rate limited: ${routeKind(req)}`);
    sendRejection(req, res, network, 429, Reason.rateLimited, "too many requests; retry after the window resets");
  };

  // 1) Per client IP, before anything else (also shields the token check).
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: opts.maxRequestsPerIpPerMinute,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: onLimit,
    }),
  );
  app.use(express.json({ limit: "64kb" }));

  const requireToken = (req: Request, res: Response, next: NextFunction): void => {
    if (opts.authToken === undefined) return next();
    if (authorizationMatches(req.get("authorization"), opts.authToken)) return next();
    logger.warn(`unauthorized ${routeKind(req)} request`);
    sendRejection(req, res, network, 401, Reason.unauthorized, "missing or invalid facilitator token");
  };

  const parsePayment = (req: Request, res: Response, next: NextFunction): void => {
    const parsed = parsePaymentRequest(req.body, network);
    if (parsed.ok) {
      res.locals["payment"] = parsed.value;
      return next();
    }
    logger.warn(`malformed ${routeKind(req)} request: ${parsed.reason}`);
    sendRejection(req, res, network, parsed.status, parsed.reason, parsed.message);
  };

  // 2) After authentication: all callers together, and per payer.
  const allCallersLimiter = rateLimit({
    windowMs: 60_000,
    limit: opts.maxRequestsPerMinute,
    keyGenerator: () => "all-callers",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: onLimit,
  });
  const perPayerLimiter = rateLimit({
    windowMs: 60_000,
    limit: opts.maxRequestsPerPayerPerMinute,
    keyGenerator: (_req, res) => `payer:${(res.locals["payment"] as ParsedPayment).authorization.from.toLowerCase()}`,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: onLimit,
  });
  const settleLimiter = rateLimit({
    windowMs: 60_000,
    limit: opts.maxSettlesPerMinute,
    keyGenerator: () => "settles",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: onLimit,
  });

  app.get("/supported", (_req, res) => {
    res.json(core.supported());
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", network });
  });

  const refuseWhenClosing = (req: Request, res: Response, next: NextFunction): void => {
    if (!inFlight.isClosing) return next();
    res.set("connection", "close");
    sendRejection(req, res, network, 503, Reason.shuttingDown, "the facilitator is shutting down; retry later");
  };

  app.post("/verify", refuseWhenClosing, requireToken, parsePayment, allCallersLimiter, perPayerLimiter, async (_req, res) => {
    inFlight.enter();
    try {
      const result = await core.verify(res.locals["payment"] as ParsedPayment);
      res.status(result.status).json(result.body);
    } finally {
      inFlight.leave();
    }
  });

  app.post("/settle", refuseWhenClosing, requireToken, parsePayment, allCallersLimiter, perPayerLimiter, settleLimiter, async (_req, res) => {
    inFlight.enter();
    try {
      const result = await core.settle(res.locals["payment"] as ParsedPayment);
      res.status(result.status).json(result.body);
    } finally {
      inFlight.leave();
    }
  });

  app.use((req: Request, res: Response) => {
    sendRejection(req, res, network, 404, "not_found", "no such route");
  });

  // JSON errors only: never Express's HTML page or a stack trace.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    // An answer is already on its way: let Express close the connection.
    if (res.headersSent) return next(err);
    const e = err as { status?: unknown; statusCode?: unknown; type?: unknown };
    const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : 500;
    if (status >= 400 && status < 500) {
      // Body parsing and other request errors: nothing reached the core.
      sendRejection(req, res, network, status, Reason.invalidRequest, typeof e.type === "string" ? e.type : "bad request");
      return;
    }
    logger.error(`internal error on ${routeKind(req)}: ${logText(err)}`);
    if (routeKind(req) === "settle") {
      // The core may already have submitted a transaction: never claim "not submitted".
      sendRejection(
        req,
        res,
        network,
        500,
        Reason.unknown,
        "internal facilitator error; the settlement outcome is unknown: reconcile by the authorization nonce",
        "unknown",
      );
      return;
    }
    sendRejection(req, res, network, 500, Reason.internal, "internal facilitator error");
  });

  return app;
}

function listen(app: express.Express, port: number, host: string): Promise<Server> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer(app);
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolvePromise(server);
    });
  });
}

export async function startRealFacilitator(opts: RealFacilitatorOptions): Promise<RealFacilitatorHandle> {
  const network = (opts.network ?? "casper:casper-test") as Network;
  if (network !== "casper:casper" && network !== "casper:casper-test") {
    throw new Error(`unsupported network ${network}: use casper:casper or casper:casper-test`);
  }
  const mainnet = network === "casper:casper";
  const logger = opts.logger ?? consoleLogger;
  const host = opts.host ?? "127.0.0.1";
  const rpcUrl = opts.rpcUrl ?? NETWORKS[network].rpcUrl;

  // --- refuse unsafe configurations before touching the key ---
  assertUsableToken(opts.authToken, {
    required: mainnet || !isLoopbackHost(host),
    minLength: mainnet ? MIN_MAINNET_TOKEN_LENGTH : 1,
    label: mainnet ? "authToken (CASCET_FACILITATOR_TOKEN) on mainnet" : "authToken for a non-loopback host",
  });
  const allowedPayTo = opts.allowedPayTo?.map(normalizePayTo);
  const allowedAssets = opts.allowedAssets?.map(normalizeAsset);
  if (mainnet && (!allowedPayTo?.length || !allowedAssets?.length)) {
    throw new Error("mainnet requires allowedPayTo and allowedAssets (CASCET_SELLER_ACCOUNT_HASH, CASCET_ALLOWED_ASSETS)");
  }
  if (!allowedPayTo || !allowedAssets) {
    logger.warn("no payTo/asset allowlist: any payee and token can be settled at the fee payer's expense (testnet only)");
  }
  const paymentMotes = opts.paymentMotes ?? DEFAULT_SETTLE_PAYMENT_MOTES;
  if (!Number.isSafeInteger(paymentMotes) || paymentMotes < MIN_SETTLE_PAYMENT_MOTES || paymentMotes > MAX_SETTLE_PAYMENT_MOTES) {
    throw new Error(
      `paymentMotes must be between ${MIN_SETTLE_PAYMENT_MOTES} and ${MAX_SETTLE_PAYMENT_MOTES}: ` +
        "a settle consumes ~2.7 CSPR and a revert burns the whole limit",
    );
  }
  const maxValiditySeconds = opts.maxAuthorizationValiditySeconds ?? 3_600;
  const minSettleWindowSeconds = opts.minSettleWindowSeconds ?? DEFAULT_MIN_SETTLE_WINDOW_SECONDS;
  if (!Number.isSafeInteger(minSettleWindowSeconds) || minSettleWindowSeconds < 6 || minSettleWindowSeconds >= maxValiditySeconds) {
    throw new Error(`minSettleWindowSeconds must be a whole number from 6 to ${maxValiditySeconds - 1}`);
  }
  const preflight = opts.preflight ?? true;
  const tokenName = opts.tokenName?.trim();
  if (tokenName !== undefined && (tokenName === "" || tokenName.length > 100 || /[\u0000-\u001f\u007f]/.test(tokenName))) {
    throw new Error("tokenName must be 1 to 100 printable characters");
  }
  if (!preflight && mainnet) {
    throw new Error(
      "the on-chain preflight is required on mainnet (CASCET_PREFLIGHT=off): without it, replayed, unfunded or " +
        "wrongly signed authorizations are submitted and burn the fee payer's gas",
    );
  }
  if (!preflight && tokenName === undefined) {
    throw new Error("with the preflight off, set tokenName (CASCET_TOKEN_NAME) so the EIP-712 domain name is still checked");
  }
  const preflightDeadlineMs = opts.preflightDeadlineMs ?? DEFAULT_PREFLIGHT_DEADLINE_MS;
  if (!Number.isSafeInteger(preflightDeadlineMs) || preflightDeadlineMs < 1_000 || preflightDeadlineMs > 60_000) {
    throw new Error("preflightDeadlineMs must be a whole number of milliseconds from 1000 to 60000");
  }
  const owners = ownerAccountsFor(network, opts.ownerAccountHashes ?? []);

  // --- fee payer and key-role separation (M07) ---
  const privateKey = loadSecretKeyFile(opts.keyPath, opts.keyAlgo ?? "ed25519", "fee-payer", m => logger.warn(m));
  const feePayer = privateKey.publicKey.accountHash().toHex();
  const roles = checkRoleSeparation({
    network,
    feePayerAccountHash: feePayer,
    ownerAccountHashes: owners,
    sellerAccountHashes: allowedPayTo ?? [],
  });
  for (const w of roles.warnings) logger.warn(`key roles: ${w}`);
  if (roles.errors.length > 0) throw new Error(`refusing to start on mainnet: ${roles.errors.join("; ")}`);

  const rpcTimeoutMs = opts.rpcTimeoutMs ?? 8_000;
  const settleWaitMs = opts.settleWaitMs ?? DEFAULT_SETTLE_WAIT_MS;
  const rpc = createCasperRpc(rpcUrl, { timeoutMs: rpcTimeoutMs });
  if (mainnet) {
    // Account comparisons cannot see associated keys: if the fee-payer key were
    // added to the owner or a seller account, its leak would let an attacker
    // sign for that account. Read it on-chain; refuse when it cannot be read.
    let signable: string[];
    try {
      signable = await accountsSignableBy(rpc, [...owners, ...(allowedPayTo ?? [])], feePayer);
    } catch (err) {
      throw new Error(
        `refusing to start on mainnet: could not read the owner and seller accounts' keys (${logText(err)}); check CASCET_RPC_URL`,
      );
    }
    if (signable.length > 0) {
      throw new Error(
        `refusing to start on mainnet: the fee-payer key is an associated key of ${signable.map(a => `${a.slice(0, 10)}…`).join(", ")}; ` +
          "a leak of the hot fee-payer key could sign for that account. Remove it there or use another fee-payer key",
      );
    }
  }

  // --- wiring ---
  const chain = createCasperSettlementChain({
    rpc,
    privateKey,
    chainName: NETWORKS[network].chainName,
    log: m => logger.warn(m),
  });
  // casper-x402's scheme does the cryptographic verification; it never signs
  // or submits here (settlement goes through `chain`).
  const notUsed = async (): Promise<never> => {
    throw new Error("settlement is handled by the CasCet settlement chain");
  };
  const scheme = new ExactCasperScheme(
    {
      getNetworkConfig: async n => ({ chainName: n.split(":").slice(1).join(":"), rpcUrl }),
      getAddresses: () => [feePayer],
      getPublicKeyHex: () => privateKey.publicKey.toHex(),
      signTransaction: notUsed,
      putTransaction: notUsed,
      waitForTransaction: notUsed,
    },
    { limitedPaymentMotes: paymentMotes },
  );
  const ledger = new AuthorizationLedger();
  const gas = new DailyGasBudget({ capMotes: opts.dailyGasCapMotes ?? DEFAULT_DAILY_GAS_CAP_MOTES });
  if (!preflight) logger.warn("on-chain preflight disabled: replayed or unfunded authorizations are only caught by the in-memory ledger");

  const core = createFacilitatorCore(
    {
      network,
      ...(allowedPayTo ? { allowedPayTo } : {}),
      ...(allowedAssets ? { allowedAssets } : {}),
      tokenVersion: opts.tokenVersion ?? "1",
      ...(tokenName !== undefined ? { tokenName } : {}),
      paymentMotes: BigInt(paymentMotes),
      settleWaitMs,
      maxValiditySeconds,
      minSettleWindowSeconds,
      preflightDeadlineMs,
    },
    {
      verifySignature: (payload, requirements) => scheme.verify(payload, requirements),
      ...(preflight ? { tokenState: new TokenStateReader(rpc) } : {}),
      chain,
      ledger,
      gas,
      log: logger,
      now: Date.now,
    },
  );

  const inFlight = new InFlightRequests();
  const app = createFacilitatorApp(core, {
    network,
    ...(opts.authToken ? { authToken: opts.authToken } : {}),
    maxSettlesPerMinute: opts.maxSettlesPerMinute ?? 60,
    maxRequestsPerMinute: opts.maxRequestsPerMinute ?? 300,
    maxRequestsPerPayerPerMinute: opts.maxRequestsPerPayerPerMinute ?? 30,
    maxRequestsPerIpPerMinute: opts.maxRequestsPerIpPerMinute ?? 600,
    logger,
    inFlight,
  });

  const server = await listen(app, opts.port, host);
  const sweeper = setInterval(() => ledger.sweep(), 60_000);
  sweeper.unref();

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  const urlHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

  logger.info(
    `listening on http://${urlHost}:${port} (feePayer=${feePayer.slice(0, 12)}…, net=${network}, ` +
      `auth=${opts.authToken ? "on" : "off"}, allowlist=${allowedPayTo && allowedAssets ? "on" : "off"}, ` +
      `preflight=${preflight ? "on" : "off"}, gasLimit=${paymentMotes} motes)`,
  );

  // Longest a settle can run: its preflight, submission and polling (until
  // settleWaitMs after it started) plus one last RPC call.
  const drainTimeoutMs = settleWaitMs + preflightDeadlineMs + 2 * rpcTimeoutMs;
  let closing: Promise<void> | undefined;
  return {
    close: () => {
      clearInterval(sweeper);
      closing ??= closeGracefully(server, inFlight, drainTimeoutMs, logger);
      return closing;
    },
    url: `http://${urlHost}:${port}`,
    feePayer,
    network,
    port,
  };
}

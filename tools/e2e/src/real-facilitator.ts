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
  logText,
  normalizeAsset,
  normalizePayTo,
  parsePaymentRequest,
  Reason,
  type FacilitatorCore,
  type FacilitatorLogger,
  type ParsedPayment,
} from "./facilitator-core.js";
import {
  DEFAULT_DAILY_GAS_CAP_MOTES,
  DEFAULT_SETTLE_PAYMENT_MOTES,
  DEFAULT_SETTLE_WAIT_MS,
  MAX_SETTLE_PAYMENT_MOTES,
  MIN_SETTLE_PAYMENT_MOTES,
  NETWORKS,
} from "./facilitator-env.js";
import { checkRoleSeparation, normalizeAccountHash } from "./facilitator-roles.js";
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
 *   - checks on-chain, before submitting, that the nonce is unused and that the
 *     payer's balance covers the value plus everything already in flight;
 *   - caps sponsored gas per UTC day, reserving it only right before
 *     submission and counting the real on-chain cost when known;
 *   - answers "pending"/"unknown" with the transaction hash instead of a
 *     failure when RPC errors hide the outcome;
 *   - refuses to start on mainnet when the fee-payer key is the contract owner
 *     or a seller account.
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
  /** Contract owner account; the fee payer must differ from it. Required on mainnet. */
  ownerAccountHash?: string;
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
  /** On-chain nonce / balance / token-name checks before verifying and settling. Default true. */
  preflight?: boolean;
  /** Pinned EIP-712 domain version (`extra.version`) of the token. Default "1". */
  tokenVersion?: string;
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
}

type RouteKind = "verify" | "settle" | "other";

const routeKind = (req: Request): RouteKind =>
  req.path === "/verify" ? "verify" : req.path === "/settle" ? "settle" : "other";

/** Send a rejection in the shape the caller's x402 client parses for this route. */
function sendRejection(req: Request, res: Response, network: Network, status: number, reason: string, message: string): void {
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
      extra: { settlementStatus: "not_submitted" },
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

  app.post("/verify", requireToken, parsePayment, allCallersLimiter, perPayerLimiter, async (_req, res) => {
    const result = await core.verify(res.locals["payment"] as ParsedPayment);
    res.status(result.status).json(result.body);
  });

  app.post("/settle", requireToken, parsePayment, allCallersLimiter, perPayerLimiter, settleLimiter, async (_req, res) => {
    const result = await core.settle(res.locals["payment"] as ParsedPayment);
    res.status(result.status).json(result.body);
  });

  app.use((req: Request, res: Response) => {
    sendRejection(req, res, network, 404, "not_found", "no such route");
  });

  // JSON errors only: never Express's HTML page or a stack trace.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const e = err as { status?: unknown; statusCode?: unknown; type?: unknown };
    const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : 500;
    if (status >= 400 && status < 500) {
      sendRejection(req, res, network, status, Reason.invalidRequest, typeof e.type === "string" ? e.type : "bad request");
      return;
    }
    logger.error(`internal error on ${routeKind(req)}: ${logText(err)}`);
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
  const ownerAccountHash = opts.ownerAccountHash ? normalizeAccountHash(opts.ownerAccountHash) : undefined;

  // --- fee payer and key-role separation (M07) ---
  const privateKey = loadSecretKeyFile(opts.keyPath, opts.keyAlgo ?? "ed25519", "fee-payer", m => logger.warn(m));
  const feePayer = privateKey.publicKey.accountHash().toHex();
  const roles = checkRoleSeparation({
    network,
    feePayerAccountHash: feePayer,
    ...(ownerAccountHash ? { ownerAccountHash } : {}),
    sellerAccountHashes: allowedPayTo ?? [],
  });
  for (const w of roles.warnings) logger.warn(`key roles: ${w}`);
  if (roles.errors.length > 0) throw new Error(`refusing to start on mainnet: ${roles.errors.join("; ")}`);

  // --- wiring ---
  const rpc = createCasperRpc(rpcUrl, { timeoutMs: opts.rpcTimeoutMs ?? 8_000 });
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
  const preflight = opts.preflight ?? true;
  if (!preflight) logger.warn("on-chain preflight disabled: replayed or unfunded authorizations are only caught by the in-memory ledger");

  const core = createFacilitatorCore(
    {
      network,
      ...(allowedPayTo ? { allowedPayTo } : {}),
      ...(allowedAssets ? { allowedAssets } : {}),
      tokenVersion: opts.tokenVersion ?? "1",
      paymentMotes: BigInt(paymentMotes),
      settleWaitMs: opts.settleWaitMs ?? DEFAULT_SETTLE_WAIT_MS,
      maxValiditySeconds,
      minSettleWindowSeconds,
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

  const app = createFacilitatorApp(core, {
    network,
    ...(opts.authToken ? { authToken: opts.authToken } : {}),
    maxSettlesPerMinute: opts.maxSettlesPerMinute ?? 60,
    maxRequestsPerMinute: opts.maxRequestsPerMinute ?? 300,
    maxRequestsPerPayerPerMinute: opts.maxRequestsPerPayerPerMinute ?? 30,
    maxRequestsPerIpPerMinute: opts.maxRequestsPerIpPerMinute ?? 600,
    logger,
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

  return {
    close: () =>
      new Promise<void>(resolveClose => {
        clearInterval(sweeper);
        server.close(() => resolveClose());
        server.closeAllConnections?.();
      }),
    url: `http://${urlHost}:${port}`,
    feePayer,
    network,
    port,
  };
}

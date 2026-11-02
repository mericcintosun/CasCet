import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  HTTPProcessResult,
  HTTPRequestContext,
  HTTPResponseInstructions,
  VerifiedPaymentCancelOptions,
} from "@x402/core/server";
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import {
  facilitatorFor,
  HEADER_CASCET_PARENT_ID,
  HEADER_CASCET_PAYMENT_ID,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  isHostedFacilitatorUrl,
  normalizeOrigin,
  normalizePackageHash,
  type CascetConfig,
  type PaymentReceipt,
  type ReceiptStatus,
  type ResolvedAsset,
} from "@cascet/core";
import { expressAdapter, withoutPaymentHeader } from "./adapter.js";
import { Anchorer, chainNameForNetwork, createCasperAnchorChain, type AnchorChain, type AnchoringHealth } from "./anchor.js";
import { normalizeAccountAddress, parseCasperAuthorization, paymentAssetOf, type CasperAuthorization } from "./authorization.js";
import { buildDiscovery } from "./discovery.js";
import { classifySettleFailure, SettlementIndeterminateError } from "./facilitator.js";
import { withPaymentHold, type PaymentHold } from "./in-flight.js";
import {
  clip,
  isJsonRpcId,
  rpcError,
  rpcResult,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  RPC_PAYMENT_INDETERMINATE,
  RPC_PAYMENT_REQUIRED,
  type JsonRpcErrorBody,
  type JsonRpcId,
} from "./jsonrpc.js";
import { errorMessage, log, logSafe } from "./log.js";
import {
  assetsSharingASymbol,
  buildToolTable,
  createPaymentRail,
  facilitatorOrigin,
  longestPaidCallMs,
  MAX_CLOCK_SKEW_SECONDS,
  priceIn,
  requiredValiditySeconds,
  settlementNodeUrl,
  unmatchedConfiguredTools,
  upstreamPingMs,
  type AssetPrice,
  type PaidToolPolicy,
  type PaymentRail,
  type ToolTable,
} from "./paywall.js";
import { createCesPreemptionChecker, routePreemptionChecks, type SettlementPreemptionChecker } from "./preemption.js";
import { isSupportedProtocolVersion, negotiateProtocolVersion } from "./protocol.js";
import { ReplayGuard, replayKey } from "./replay.js";
import { ReceiptStore, makeEventPusher } from "./store.js";
import { GATEWAY_VERSION } from "./version.js";
import {
  createUpstreamTransport,
  UpstreamSupervisor,
  UpstreamUnavailableError,
  type HealthCheckPolicy,
  type ReconnectPolicy,
  type UpstreamState,
} from "./upstream.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CONCURRENT_CHAIN_CHECKS = 4;
const CORS_ALLOW_HEADERS = [
  "accept",
  "authorization",
  "content-type",
  HEADER_PAYMENT_SIGNATURE,
  HEADER_CASCET_PARENT_ID,
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
  // @x402/fetch sets this (as a request header) on its paid retry.
  "access-control-expose-headers",
].join(", ");
const CORS_EXPOSE_HEADERS = [HEADER_PAYMENT_REQUIRED, HEADER_PAYMENT_RESPONSE, HEADER_CASCET_PAYMENT_ID, "mcp-session-id"].join(", ");

export interface GatewayOptions {
  /** Replace the upstream transport (embedding, tests). Defaults to the configured stdio/http upstream. */
  createUpstreamTransport?: () => Transport | Promise<Transport>;
  /**
   * Called when the upstream is gone for good (reconnect attempts exhausted).
   * Default: log, close the gateway and set process.exitCode = 1 so a process
   * supervisor restarts it.
   */
  onFatal?: (error: Error) => void;
  /**
   * On-chain settlement check; `null` disables it. Defaults to one token-event checker per
   * asset when a node URL is configured. Queries name the asset (`query.asset`).
   */
  preemptionChecker?: SettlementPreemptionChecker | null;
  /** Replace fetch for every facilitator request (tests). */
  facilitatorFetch?: typeof fetch;
  /** Replace the anchoring chain client (tests). */
  anchorChain?: AnchorChain;
  /** How often a submitted anchor is polled for execution (default 5 s). */
  anchorPollIntervalMs?: number;
  /** Receipt log path. Defaults to .cascet/<name>.receipts.jsonl under the working directory. */
  receiptsPath?: string;
  /** Upstream reconnect policy. */
  reconnect?: Partial<ReconnectPolicy>;
  /** Upstream liveness checks (periodic pings, failure threshold). */
  upstreamHealthCheck?: Partial<HealthCheckPolicy>;
  /**
   * How long close() waits for calls in flight (a paid call may be settling) before it cuts
   * the remaining connections. Default: the longest a paid call can take (see longestPaidCallMs):
   * the preflight, the facilitator's verify, timeouts.upstreamMs, the settle timeout (x402's
   * retry of a pending settlement shares it), the upstream ping before a settle-first call
   * settles when a tool settles first, and the on-chain settlement check when it is on.
   */
  drainTimeoutMs?: number;
}

export interface GatewayHealth {
  /** ok | degraded (anchoring paused) | unavailable (upstream down; HTTP 503). */
  status: "ok" | "degraded" | "unavailable";
  server: string;
  upstream: {
    state: UpstreamState;
    tools: { priced: number; free: number; hidden: number };
    error?: string;
  };
  anchoring: AnchoringHealth | { state: "disabled" };
  /** Whether failed settlements are cross-checked against the token's on-chain events. */
  settlementCheck: "on" | "off";
}

export interface RunningGateway {
  port: number;
  host: string;
  /** MCP endpoint URL. */
  url: string;
  health: () => GatewayHealth;
  close: () => Promise<void>;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/** Result of trying to settle one payment. */
interface SettleOutcome {
  status: ReceiptStatus;
  settledBy?: "facilitator" | "third-party";
  txHash?: string;
  payer?: string;
  /** Facilitator's reason when it did not settle. */
  reason?: string;
  /** Context for the receipt (on-chain findings). */
  note?: string;
  /** x402 headers to return (PAYMENT-RESPONSE). */
  headers?: Record<string, string>;
  /**
   * The token's events show this authorization's nonce used or canceled:
   * whatever the status, the transfer can no longer execute (and spend the
   * payer's balance).
   */
  nonceUsed?: boolean;
}

/** x402's answer for a payment that matched a route and passed the facilitator's verify. */
type VerifiedPayment = Extract<HTTPProcessResult, { type: "payment-verified" }>;

/** A tools/call of a priced tool, before its payment is checked. */
interface PaidRequest {
  id: JsonRpcId;
  name: string;
  args: Record<string, unknown>;
  policy: PaidToolPolicy;
  table: ToolTable;
  started: number;
  /** Where the preflight reserves the call's payment, once verified, while it is in flight; released when the call ends. */
  hold: PaymentHold;
}

/** Everything about one verified paid call. */
interface PaidCall {
  id: JsonRpcId;
  name: string;
  args: Record<string, unknown>;
  policy: PaidToolPolicy;
  /** The token and amount of the requirements x402 matched and the facilitator verified. */
  price: AssetPrice;
  table: ToolTable;
  context: HTTPRequestContext;
  verified: VerifiedPayment;
  authorization: CasperAuthorization;
  paymentId: string;
  parentId?: string;
  started: number;
  /**
   * The payment's in-flight reservation (see PaidRequest.hold), released once its settlement finished, or
   * kept until it expires when the outcome is unknown (the transfer may still execute).
   */
  hold: PaymentHold;
}

/** Start a paid MCP gateway in front of the configured upstream server. */
export async function startGateway(cfg: CascetConfig, options: GatewayOptions = {}): Promise<RunningGateway> {
  const rail: PaymentRail = await createPaymentRail(cfg, { fetch: options.facilitatorFetch });

  const anchoringCfg = cfg.anchoring;
  let anchorer: Anchorer | undefined;
  if (anchoringCfg) {
    const chainName = anchoringCfg.chainName ?? chainNameForNetwork(cfg.network);
    const chain = options.anchorChain ?? createCasperAnchorChain(anchoringCfg, chainName);
    anchorer = new Anchorer(chain, {
      maxConsecutiveFailures: anchoringCfg.maxConsecutiveFailures,
      cooldownMs: anchoringCfg.cooldownMs,
      confirmTimeoutMs: anchoringCfg.confirmTimeoutMs,
      pollIntervalMs: options.anchorPollIntervalMs,
    });
    log.info(
      `    on-chain anchoring: ReceiptRegistry ${logSafe(anchoringCfg.contractPackageHash)} on ${logSafe(chainName)} ` +
        `(gas limit ${anchoringCfg.gasMotes} motes per anchor)`,
    );
  }

  const settlementNode = settlementNodeUrl(cfg);
  // One event checker per token: a payment's on-chain trace is in the events of the token it paid in.
  const preemption: SettlementPreemptionChecker | undefined =
    options.preemptionChecker === null
      ? undefined
      : (options.preemptionChecker ??
        (settlementNode
          ? routePreemptionChecks(
              new Map(
                rail.assets.map(asset => [
                  asset.packageHash,
                  createCesPreemptionChecker({
                    nodeUrl: settlementNode,
                    tokenPackageHash: asset.packageHash,
                    scanWindow: cfg.settlement.eventScanWindow,
                  }),
                ]),
              ),
            )
          : undefined));
  let chainChecksInFlight = 0;

  const store = new ReceiptStore(options.receiptsPath ?? `.cascet/${slug(cfg.name)}.receipts.jsonl`);
  const pushEvent = makeEventPusher(cfg.eventsUrl);
  const replay = new ReplayGuard();
  seedReplayGuard(replay, store, rail.maxTimeoutSeconds);
  const keptInFlight = seedInFlight(rail, store);

  let table: ToolTable = buildToolTable(cfg, rail, []);
  let listening = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  /** /mcp requests being handled; close() lets them finish (paid calls may be settling). */
  const inFlight = new Set<Promise<void>>();
  // Cutting a call short could leave a settled payment without its receipt.
  const drainTimeoutMs = options.drainTimeoutMs ?? longestPaidCallMs(cfg, preemption !== undefined);

  const announceOnline = (): void => {
    pushEvent({
      type: "server-online",
      server: cfg.name,
      tools: table.pricedToolNames
        .map(name => {
          const policy = table.policyOf(name);
          return { name, priceUsd: policy?.kind === "paid" ? policy.price.price : undefined };
        })
        .concat(table.freeToolNames.map(name => ({ name, priceUsd: undefined }))),
    });
  };

  const upstream = new UpstreamSupervisor(
    {
      createTransport: options.createUpstreamTransport ?? (() => createUpstreamTransport(cfg.upstream)),
      timeoutMs: cfg.timeouts.upstreamMs,
      reconnect: options.reconnect,
      healthCheck: options.upstreamHealthCheck,
    },
    {
      onTools: tools => {
        table = buildToolTable(cfg, rail, tools);
        for (const name of unmatchedConfiguredTools(cfg, tools)) {
          log.warn(`    config names tool "${logSafe(name, 80)}", which the upstream does not offer`);
        }
        if (listening && upstream.state === "connected") announceOnline();
      },
      onState: (state, error) => {
        if (state === "reconnecting") {
          log.error(`[upstream] lost: ${logSafe(error ?? "connection closed")}; tools/call answers 503 until it is back`);
          pushEvent({ type: "server-offline", server: cfg.name });
        } else if (state === "connected" && listening) {
          announceOnline();
        }
      },
      onFatal: error => {
        if (options.onFatal) {
          options.onFatal(error);
          return;
        }
        log.error(`[upstream] ${logSafe(error)}; stopping the gateway (exit code 1)`);
        process.exitCode = 1;
        void close();
      },
    },
  );
  await upstream.start();

  const allowedOrigins = new Set(cfg.cors.allowedOrigins);

  function health(): GatewayHealth {
    const anchoring = anchorer ? anchorer.health() : ({ state: "disabled" } as const);
    const state = upstream.state;
    const status: GatewayHealth["status"] =
      state !== "connected" ? "unavailable" : anchoring.state === "open" || anchoring.state === "half-open" ? "degraded" : "ok";
    return {
      status,
      server: cfg.name,
      upstream: {
        state,
        tools: {
          priced: table.pricedToolNames.length,
          free: table.freeToolNames.length,
          hidden: table.hiddenToolNames.length,
        },
        error: state === "connected" || !upstream.error ? undefined : logSafe(upstream.error.message),
      },
      anchoring,
      settlementCheck: preemption ? "on" : "off",
    };
  }

  // ---------------------------------------------------------------- receipts

  /**
   * Write a receipt to the log. A failure (disk full, permissions) is logged and
   * swallowed: by now the payment may have settled, and losing the buyer's result
   * over a log write would be worse. The receipt stays in memory (/receipts).
   */
  function persist(receipt: PaymentReceipt, kind: "add" | "update"): void {
    try {
      if (kind === "add") store.add(receipt);
      else store.update(receipt);
    } catch (err) {
      log.error(`[receipts] could not write receipt ${logSafe(receipt.id)} to the receipt log (${logSafe(err)}); kept in memory only`);
    }
  }

  function recordReceipt(input: {
    id: string;
    tool: string;
    started: number;
    status: ReceiptStatus;
    payer: string;
    nonce: string;
    /** The token of the matched requirements. */
    asset: ResolvedAsset;
    /** The amount of the matched requirements. */
    amountRaw: string;
    priceUsd: string;
    txHash?: string;
    parentId?: string;
    settledBy?: "facilitator" | "third-party";
    note?: string;
  }): PaymentReceipt {
    const receipt: PaymentReceipt = {
      id: input.id,
      parentId: input.parentId,
      createdAt: new Date().toISOString(),
      network: cfg.network,
      server: cfg.name,
      tool: input.tool,
      payer: input.payer,
      payTo: rail.payTo,
      amountRaw: input.amountRaw,
      asset: input.asset.packageHash,
      assetSymbol: input.asset.symbol,
      priceUsd: input.priceUsd,
      txHash: input.txHash,
      status: input.status,
      latencyMs: Date.now() - input.started,
      nonce: input.nonce,
      settledBy: input.settledBy,
      note: input.note === undefined ? undefined : clip(input.note, 900),
    };
    persist(receipt, "add");
    pushEvent({ type: "receipt", receipt });
    if (receipt.status === "settled" && anchorer) {
      anchorer.enqueue(receipt, anchoredTxHash => {
        receipt.anchoredTxHash = anchoredTxHash;
        persist(receipt, "update");
        pushEvent({ type: "receipt", receipt });
      });
    }
    return receipt;
  }

  function annotateReceipt(receipt: PaymentReceipt, note: string): void {
    receipt.note = clip(receipt.note ? `${receipt.note}; ${note}` : note, 900);
    persist(receipt, "update");
    pushEvent({ type: "receipt", receipt });
  }

  // ----------------------------------------------------------- x402 helpers

  /** A fresh 402 challenge for a priced tool, optionally carrying an error reason. */
  async function challenge(req: Request, snapshot: ToolTable, name: string, error?: string) {
    const processed = await snapshot.http.processHTTPRequest({
      adapter: withoutPaymentHeader(expressAdapter(req)),
      path: snapshot.routeFor(name),
      method: "POST",
    });
    const paymentRequired = processed.type === "payment-error" ? paymentRequiredOf(processed.response.headers) : undefined;
    if (!paymentRequired) throw new Error(`no payment route for priced tool ${name}`);
    if (error !== undefined) paymentRequired.error = error;
    return {
      headers: { [HEADER_PAYMENT_REQUIRED]: encodePaymentRequiredHeader(paymentRequired) },
      paymentRequired,
    };
  }

  /** Refuse a payment before verification (402 with a fresh challenge naming the reason). */
  async function rejectPayment(req: Request, res: Response, id: JsonRpcId, snapshot: ToolTable, name: string, reason: string): Promise<void> {
    log.warn(`[x402] payment for ${logSafe(name, 80)} refused: ${logSafe(reason)}`);
    const { headers, paymentRequired } = await challenge(req, snapshot, name, reason);
    res.status(402).set(headers).json(rpcError(id, RPC_PAYMENT_REQUIRED, `payment rejected: ${clip(reason, 200)}`, paymentRequired));
  }

  /** Forward an x402 payment-error (challenge or verification failure) as a JSON-RPC error. */
  function sendPaymentError(res: Response, id: JsonRpcId, response: HTTPResponseInstructions, name: string, paid: boolean): void {
    const paymentRequired = paymentRequiredOf(response.headers);
    if (paid) log.warn(`[x402] payment for ${logSafe(name, 80)} rejected: ${logSafe(paymentRequired?.error ?? `HTTP ${response.status}`)}`);
    const message = paid ? `payment rejected: ${clip(paymentRequired?.error ?? "invalid payment", 200)}` : "payment required";
    const data = paymentRequired ?? (isRecord(response.body) ? response.body : undefined);
    res.status(response.status).set(withoutContentType(response.headers)).json(rpcError(id, RPC_PAYMENT_REQUIRED, message, data));
  }

  /**
   * The tool's price in the token the payment says it pays in, or the reason to
   * refuse it: the buyer must pay in one of the tool's tokens, and the amount
   * and every later check depend on which one.
   */
  function requestedPrice(payload: unknown, policy: PaidToolPolicy): { price: AssetPrice } | { problem: string } {
    const asset = paymentAssetOf(payload);
    if (asset === undefined) return { problem: "invalid_payload: accepted.asset is missing or not a contract package hash" };
    const price = priceIn(policy, asset);
    if (!price) {
      const accepted = policy.accepts.map(entry => entry.asset.id).join(", ");
      return { problem: `unsupported_asset: this tool is not sold for token ${asset} (it accepts ${accepted})` };
    }
    return { price };
  }

  /** Check the authorization against this gateway's terms, in the token it pays in, before asking the facilitator. */
  function authorizationProblem(auth: CasperAuthorization, price: AssetPrice, settleBeforeExecute: boolean): string | undefined {
    if (auth.to !== rail.payTo) return "invalid_payload: authorization.to is not this gateway's payTo";
    if (auth.value !== price.amount) {
      return `invalid_payload: authorization.value ${auth.value} does not equal the price ${price.amount} (${price.asset.symbol})`;
    }
    const now = Math.floor(Date.now() / 1_000);
    const remaining = auth.validBefore - now;
    const needed = requiredValiditySeconds(cfg, settleBeforeExecute);
    if (remaining < needed) {
      return `authorization_expires_too_soon: it must stay valid for at least ${needed} s, it has ${Math.max(0, remaining)} s`;
    }
    if (remaining > rail.maxTimeoutSeconds + MAX_CLOCK_SKEW_SECONDS) {
      return `authorization_validity_too_long: validBefore may be at most ${rail.maxTimeoutSeconds} s ahead`;
    }
    return undefined;
  }

  /**
   * Fail closed when what the facilitator verified is not exactly this tool's
   * configured price in the token the gateway checked locally (`requested`).
   * `matched` is the tool's price in the asset of the requirements x402 matched.
   */
  function requirementsProblem(
    reqs: PaymentRequirements,
    auth: CasperAuthorization,
    requested: AssetPrice,
    matched: AssetPrice | undefined,
  ): string | undefined {
    if (reqs.scheme !== "exact") return "verified payment uses an unexpected scheme";
    if (reqs.network !== rail.network) return "verified payment is for another network";
    if (reqs.payTo.toLowerCase() !== rail.payTo || auth.to !== rail.payTo) return "verified payment pays another payee";
    if (!matched || matched.asset.packageHash !== requested.asset.packageHash) return "verified payment is in another asset";
    if (reqs.amount !== matched.amount || auth.value !== matched.amount) {
      return "verified payment amount does not equal the configured price";
    }
    return undefined;
  }

  /**
   * Tell x402 that verified work ended before settlement: it runs the
   * verified-payment cancellation hooks and, for schemes that refund on
   * cancel, settles the refund. "exact" defines no refund, so nothing moves
   * on-chain. Never throws: the caller is already answering a failure.
   */
  async function cancelVerified(verified: VerifiedPayment, tool: string, options: VerifiedPaymentCancelOptions): Promise<void> {
    try {
      const refund = await verified.cancellationDispatcher.cancel(options);
      if (refund && !refund.success) {
        log.warn(`[x402] cancel settlement for ${logSafe(tool, 80)} failed: ${logSafe(refund.errorReason ?? "unknown reason")}`);
      }
    } catch (err) {
      log.warn(`[x402] canceling the verified payment for ${logSafe(tool, 80)} failed: ${logSafe(err)}`);
    }
  }

  /**
   * Settle a verified payment and classify the outcome. A payment that
   * settled or failed no longer counts as in flight: its reservation is
   * released before the tool runs (settleBeforeExecute) and before the receipt
   * is written. One whose outcome is unknown (or whose settling threw) may
   * still execute until its authorization expires, so its reservation keeps
   * counting until then (see in-flight.ts), unless the token's events show its
   * nonce used.
   */
  async function settle(call: PaidCall): Promise<SettleOutcome> {
    let outcome: SettleOutcome | undefined;
    try {
      outcome = await settleAndClassify(call);
      return outcome;
    } finally {
      if (outcome && (outcome.status !== "unknown" || outcome.nonceUsed)) call.hold.release();
      else call.hold.keepUntilExpiry();
    }
  }

  async function settleAndClassify(call: PaidCall): Promise<SettleOutcome> {
    let result;
    try {
      // CASCET_PAYMENT_FLOWS refuses every flow that settles before the handler, so x402 hands over
      // no before-handler settlement; passing it on keeps x402 from ever settling a payment twice.
      result = await call.table.http.processSettlement(
        call.verified.paymentPayload,
        call.verified.paymentRequirements,
        call.verified.declaredExtensions,
        { request: call.context },
        undefined,
        call.verified.beforeHandlerSettlement,
      );
    } catch (err) {
      // FacilitatorResponseError (including our SettlementIndeterminateError and x402's
      // FacilitatorTimeoutError) or anything unexpected: the transfer may still execute.
      // The router names the transfer when an earlier answer reported it as pending.
      if (err instanceof SettlementIndeterminateError) {
        return reconcile({ status: "unknown", reason: err.message, txHash: err.transaction }, call);
      }
      return reconcile({ status: "unknown", reason: `facilitator gave an unusable settle answer: ${errorMessage(err)}` }, call);
    }
    if (result.success) {
      return {
        status: "settled",
        settledBy: "facilitator",
        txHash: result.transaction || undefined,
        payer: result.payer,
        headers: result.headers,
      };
    }
    const reason =
      result.errorMessage && result.errorMessage !== result.errorReason
        ? `${result.errorReason}: ${result.errorMessage}`
        : result.errorReason;
    const classified = classifySettleFailure(result.errorReason, result.errorMessage, result.transaction);
    const outcome: SettleOutcome = {
      status: classified.kind,
      reason,
      payer: result.payer,
      txHash: result.transaction || undefined,
      headers: result.headers,
    };
    return classified.checkChain ? reconcile(outcome, call) : outcome;
  }

  /**
   * Sharpen an unsuccessful settle with the token's on-chain events:
   * - this exact authorization already paid payTo (settlement preemption, or a
   *   facilitator that lost track of its own transfer): settled by a third
   *   party when `settlement.acceptThirdPartySettlement` is on, else unknown.
   *   The events do not say which transaction executed it: the hash of a
   *   transfer the facilitator reported as broadcast but not executed for this
   *   payment (an unknown outcome) is kept, as possibly the one that paid. A
   *   transfer it reported as reverted (a failed outcome) cannot be that one:
   *   another transaction used the nonce first;
   * - the payer canceled the nonce: failed (the cancel event alone proves the
   *   transfer can never execute);
   * - the nonce was used without the expected transfer right after it: noted,
   *   but an unknown outcome stays unknown. That reading depends on the token's
   *   event layout (AuthorizationUsed immediately followed by its Transfer); if
   *   a token upgrade changed the order, the facilitator's own successful
   *   transfer would look "consumed elsewhere", and calling it failed would
   *   invite the buyer to pay twice;
   * - nothing found: the facilitator's verdict stands.
   * The events read are those of the token the payment was in.
   */
  async function reconcile(outcome: SettleOutcome, call: PaidCall): Promise<SettleOutcome> {
    if (!preemption) return outcome;
    if (chainChecksInFlight >= MAX_CONCURRENT_CHAIN_CHECKS) {
      return { ...outcome, note: "on-chain settlement check skipped (too many in flight)" };
    }
    const auth = call.authorization;
    chainChecksInFlight++;
    try {
      const found = await preemption.check({
        payer: auth.from,
        nonce: auth.nonce,
        payTo: rail.payTo,
        amount: auth.value,
        asset: call.price.asset.packageHash,
      });
      switch (found.kind) {
        case "paid": {
          // A transfer the facilitator reported as broadcast (pending) may well be the one that paid; one it
          // reported as reverted never is.
          const pendingTx = outcome.status === "unknown" ? outcome.txHash : undefined;
          const through = pendingTx ? `possibly through transaction ${pendingTx}, which this gateway's facilitator broadcast` : undefined;
          if (cfg.settlement.acceptThirdPartySettlement) {
            const reverted = outcome.txHash && !pendingTx ? `; transaction ${outcome.txHash} of this gateway's facilitator reverted` : "";
            // Not the settle answer's headers: its PAYMENT-RESPONSE reports a failure.
            return {
              status: "settled",
              settledBy: "third-party",
              payer: auth.from,
              txHash: pendingTx,
              note: `facilitator answered "${clip(outcome.reason ?? "", 200)}", but token event #${found.eventIndex} shows this exact authorization paid payTo (${through ?? `settled by another submitter${reverted}`})`,
              nonceUsed: true,
            };
          }
          return {
            ...outcome,
            status: "unknown",
            note:
              `token event #${found.eventIndex} shows this exact authorization paid payTo, ` +
              `${through ?? "executed by a submitter other than this gateway's facilitator"}; ` +
              "settlement.acceptThirdPartySettlement is off, so the result was withheld",
            nonceUsed: true,
          };
        }
        case "canceled":
          return {
            ...outcome,
            status: "failed",
            note: `the payer canceled the authorization nonce on-chain (token event #${found.eventIndex})`,
            nonceUsed: true,
          };
        case "consumed-elsewhere":
          // Layout-dependent evidence: never turns an unknown outcome into a failure. The nonce is used, though,
          // so this authorization can no longer execute.
          return {
            ...outcome,
            note: `the authorization nonce was used on-chain without the expected transfer to payTo right after it (token event #${found.eventIndex}: ${found.detail})`,
            nonceUsed: true,
          };
        case "not-found":
          return outcome;
      }
    } catch (err) {
      log.warn(`[x402] on-chain settlement check failed: ${logSafe(err)}`);
      return { ...outcome, note: `on-chain settlement check failed: ${clip(errorMessage(err), 200)}` };
    } finally {
      chainChecksInFlight--;
    }
  }

  function receiptFor(call: PaidCall, outcome: SettleOutcome): PaymentReceipt {
    // The receipt (and the replay guard after a restart) keys on the payer the gateway
    // verified itself, never on however the facilitator chose to spell it.
    if (outcome.payer !== undefined && normalizeAccountAddress(outcome.payer) !== call.authorization.from) {
      log.warn(
        `[x402] facilitator reported payer ${logSafe(outcome.payer, 80)} for an authorization from ` +
          `${logSafe(call.authorization.from)}; the receipt records the authorization's payer`,
      );
    }
    // Token and amount come from the requirements x402 matched and the facilitator verified.
    return recordReceipt({
      id: call.paymentId,
      tool: call.name,
      started: call.started,
      status: outcome.status,
      payer: call.authorization.from,
      nonce: call.authorization.nonce,
      asset: call.price.asset,
      amountRaw: call.verified.paymentRequirements.amount,
      priceUsd: call.policy.price.price,
      txHash: outcome.txHash,
      parentId: call.parentId,
      settledBy: outcome.status === "settled" ? outcome.settledBy : undefined,
      note: [outcome.status === "settled" ? undefined : outcome.reason, outcome.note].filter(Boolean).join("; ") || undefined,
    });
  }

  function withPaymentMeta(result: CallToolResult, receipt: PaymentReceipt): CallToolResult {
    return {
      ...result,
      _meta: {
        ...(result._meta as Record<string, unknown> | undefined),
        cascet: {
          paymentId: receipt.id,
          txHash: receipt.txHash,
          amountRaw: receipt.amountRaw,
          asset: receipt.asset,
          assetSymbol: receipt.assetSymbol,
          network: receipt.network,
          settledBy: receipt.settledBy,
        },
      },
    };
  }

  /** Answer a payment that did not settle. */
  async function sendUnsettled(req: Request, res: Response, call: PaidCall, outcome: SettleOutcome, receipt: PaymentReceipt): Promise<void> {
    res.set(HEADER_CASCET_PAYMENT_ID, call.paymentId);
    if (outcome.status === "unknown") {
      log.warn(`[x402] settlement of ${logSafe(call.name, 80)} is indeterminate: ${logSafe(receipt.note ?? outcome.reason ?? "")}`);
      res.json(
        rpcError(
          call.id,
          RPC_PAYMENT_INDETERMINATE,
          "payment settlement outcome is indeterminate: do not pay again for this call; the payment is being reconciled",
          { status: "unknown", paymentId: call.paymentId, reason: outcome.reason, note: receipt.note },
        ),
      );
      return;
    }
    log.warn(`[x402] settlement of ${logSafe(call.name, 80)} failed: ${logSafe(receipt.note ?? outcome.reason ?? "")}`);
    const reason = `settlement_failed: ${outcome.reason ?? "unknown reason"}`;
    const { paymentRequired } = await challenge(req, call.table, call.name, reason);
    if (outcome.headers) res.set(withoutContentType(outcome.headers));
    res
      .status(402)
      .json(rpcError(call.id, RPC_PAYMENT_REQUIRED, `payment settlement failed: ${clip(outcome.reason ?? "unknown reason", 200)}`, {
        ...paymentRequired,
        paymentId: call.paymentId,
        note: receipt.note,
      }));
  }

  /** Default mode: run the tool, then settle; buyers pay only for successful calls. */
  async function executeThenSettle(req: Request, res: Response, call: PaidCall): Promise<void> {
    let result: CallToolResult;
    try {
      result = await upstream.callTool({
        name: call.name,
        arguments: call.args,
        _meta: { cascet: { paymentId: call.paymentId, server: cfg.name } },
      });
    } catch (err) {
      await cancelVerified(call.verified, call.name, { reason: "handler_threw", error: err });
      sendUpstreamError(res, call.id, err, " (not charged)");
      return;
    }
    if (result.isError) {
      // Not charged: the authorization is left unsettled (and stays single-use here).
      await cancelVerified(call.verified, call.name, { reason: "handler_failed" });
      res.json(rpcResult(call.id, result));
      return;
    }
    const outcome = await settle(call);
    const receipt = receiptFor(call, outcome);
    if (outcome.status !== "settled") {
      await sendUnsettled(req, res, call, outcome, receipt);
      return;
    }
    if (outcome.headers) res.set(withoutContentType(outcome.headers));
    res.set(HEADER_CASCET_PAYMENT_ID, call.paymentId);
    res.json(rpcResult(call.id, withPaymentMeta(result, receipt)));
  }

  /** settleBeforeExecute: settle first, run the tool only once the payment is final. */
  async function settleThenExecute(req: Request, res: Response, call: PaidCall): Promise<void> {
    // Settling is irreversible: make sure the upstream still answers before charging for a call it must run.
    try {
      await upstream.ping(upstreamPingMs(cfg));
    } catch (err) {
      log.warn(`[upstream] not answering before settlement of ${logSafe(call.name, 80)}: ${logSafe(err)}`);
      await cancelVerified(call.verified, call.name, { reason: "handler_failed", error: err, responseStatus: 503 });
      res.status(503).json(rpcError(call.id, RPC_INTERNAL_ERROR, "upstream MCP server is unavailable; nothing was charged"));
      return;
    }
    const outcome = await settle(call);
    const receipt = receiptFor(call, outcome);
    if (outcome.status !== "settled") {
      await sendUnsettled(req, res, call, outcome, receipt);
      return;
    }
    if (outcome.headers) res.set(withoutContentType(outcome.headers));
    res.set(HEADER_CASCET_PAYMENT_ID, call.paymentId);
    let result: CallToolResult;
    try {
      result = await upstream.callTool({
        name: call.name,
        arguments: call.args,
        _meta: { cascet: { paymentId: call.paymentId, server: cfg.name } },
      });
    } catch (err) {
      annotateReceipt(receipt, `tool failed after the payment settled (not refunded): ${clip(errorMessage(err), 200)}`);
      sendUpstreamError(res, call.id, err, " after the payment settled (not refunded)", {
        paymentId: call.paymentId,
        txHash: receipt.txHash,
      });
      return;
    }
    if (result.isError) annotateReceipt(receipt, "tool returned an error after the payment settled (not refunded)");
    res.json(rpcResult(call.id, withPaymentMeta(result, receipt)));
  }

  // -------------------------------------------------------------- tools/call

  async function handleToolCall(req: Request, res: Response, id: JsonRpcId, params: Record<string, unknown>): Promise<void> {
    const started = Date.now();
    const snapshot = table;
    const name = params.name;
    if (typeof name !== "string" || name.length === 0) {
      res.json(rpcError(id, RPC_INVALID_PARAMS, "tools/call requires params.name"));
      return;
    }
    const rawArgs = params.arguments;
    if (rawArgs !== undefined && !isRecord(rawArgs)) {
      res.json(rpcError(id, RPC_INVALID_PARAMS, "tools/call params.arguments must be an object"));
      return;
    }
    const args = (rawArgs ?? {}) as Record<string, unknown>;

    // Unpriced tools that are not listed as free are hidden: same answer as a tool that does not exist.
    const policy = snapshot.policyOf(name);
    if (!policy) {
      res.json(rpcError(id, RPC_INVALID_PARAMS, `Unknown tool: ${clip(name)}`));
      return;
    }
    // Do not ask a buyer to sign for a call that cannot run.
    if (upstream.state !== "connected") {
      res.status(503).json(rpcError(id, RPC_INTERNAL_ERROR, "upstream MCP server is unavailable; nothing was charged"));
      return;
    }

    if (policy.kind === "free") {
      try {
        res.json(rpcResult(id, await upstream.callTool({ name, arguments: args })));
      } catch (err) {
        sendUpstreamError(res, id, err, "");
      }
      return;
    }

    // However a paid call ends (its settlement, a refusal, a cancellation, an upstream error or
    // timeout, a throw), the payment the preflight reserved for it is no longer in flight; unless
    // its settlement outcome was unknown: settle() then kept the reservation, and this changes nothing.
    const hold = rail.inFlight.open();
    try {
      await handlePaidCall(req, res, { id, name, args, policy, table: snapshot, started, hold });
    } finally {
      hold.release();
    }
  }

  /**
   * A paid tool call: the gateway's local checks, x402's verification (with the
   * hosted preflight, which reserves the payment on the call's hold once the
   * facilitator verified it), the write-ahead record, then the tool and the
   * settlement in the configured order.
   */
  async function handlePaidCall(req: Request, res: Response, paid: PaidRequest): Promise<void> {
    const { id, name, args, policy, table: snapshot, started, hold } = paid;
    // x402 hands this context to its hooks: that is how the preflight finds the call's hold.
    const context: HTTPRequestContext = withPaymentHold(
      {
        adapter: expressAdapter(req),
        path: snapshot.routeFor(name),
        method: "POST",
        paymentHeader: req.get(HEADER_PAYMENT_SIGNATURE) ?? undefined,
      },
      hold,
    );
    if (!snapshot.http.requiresPayment(context)) {
      log.error(`[x402] priced tool ${logSafe(name, 80)} has no payment route; refusing to run it for free`);
      res.status(500).json(rpcError(id, RPC_INTERNAL_ERROR, "gateway pricing is inconsistent; the tool was not run and nothing was charged"));
      return;
    }

    // 1. Local checks on the authorization, in the token it pays in, before any facilitator or upstream work.
    let authorization: CasperAuthorization | undefined;
    let requested: AssetPrice | undefined;
    let reservation: string | undefined;
    if (context.paymentHeader) {
      let payload: unknown;
      try {
        payload = decodePaymentSignatureHeader(context.paymentHeader);
      } catch {
        payload = undefined; // undecodable: x402 answers it with a fresh challenge
      }
      if (payload !== undefined) {
        const parsed = parseCasperAuthorization(payload);
        if (!parsed.ok) return rejectPayment(req, res, id, snapshot, name, parsed.reason);
        authorization = parsed.authorization;
        const asked = requestedPrice(payload, policy);
        if ("problem" in asked) return rejectPayment(req, res, id, snapshot, name, asked.problem);
        requested = asked.price;
        const problem = authorizationProblem(authorization, requested, policy.settleBeforeExecute);
        if (problem) return rejectPayment(req, res, id, snapshot, name, problem);
        const key = replayKey(authorization.from, authorization.nonce);
        const reserved = replay.reserve(key, (authorization.validBefore + MAX_CLOCK_SKEW_SECONDS) * 1_000);
        if (reserved === "duplicate") {
          return rejectPayment(req, res, id, snapshot, name, "duplicate_payment: this authorization was already presented to this gateway");
        }
        if (reserved === "full") {
          res.status(503).json(rpcError(id, RPC_INTERNAL_ERROR, "gateway is overloaded; try again later (nothing was charged)"));
          return;
        }
        reservation = key;
      }
    }

    // 2. x402: match the payment to one of this tool's requirements and verify it with the
    //    facilitator of that token (its balance and nonce preflight runs here, right before execution,
    //    and reserves the verified payment).
    let processed: HTTPProcessResult;
    try {
      processed = await snapshot.http.processHTTPRequest(context);
    } catch (err) {
      if (reservation) replay.release(reservation);
      log.error(`[x402] verification of a payment for ${logSafe(name, 80)} failed: ${logSafe(err)}`);
      res.status(502).json(rpcError(id, RPC_INTERNAL_ERROR, "payment verification failed: the facilitator gave an unusable answer; nothing was charged"));
      return;
    }
    if (processed.type === "payment-error") {
      if (reservation) replay.release(reservation);
      sendPaymentError(res, id, processed.response, name, reservation !== undefined);
      return;
    }
    if (processed.type === "no-payment-required" || !authorization || !requested || !reservation) {
      if (reservation) replay.release(reservation);
      if (processed.type === "payment-verified") await cancelVerified(processed, name, { reason: "after_verify_aborted" });
      log.error(`[x402] payment for ${logSafe(name, 80)} was not verified as expected; refusing to run it`);
      res.status(500).json(rpcError(id, RPC_INTERNAL_ERROR, "payment could not be verified; the tool was not run and nothing was charged"));
      return;
    }

    // Everything from here on reads the requirements x402 matched (token, amount), never a default asset.
    const matched = priceIn(policy, processed.paymentRequirements.asset);
    const mismatch = requirementsProblem(processed.paymentRequirements, authorization, requested, matched);
    if (mismatch || !matched) {
      const reason = mismatch ?? "verified payment is in another asset";
      // Nothing ran and nothing was charged: the authorization stays the buyer's.
      replay.release(reservation);
      await cancelVerified(processed, name, { reason: "after_verify_aborted" });
      log.error(`[x402] ${logSafe(reason)} for ${logSafe(name, 80)}; refusing to run it`);
      const { headers, paymentRequired } = await challenge(req, snapshot, name, reason);
      res.status(402).set(headers).json(rpcError(id, RPC_PAYMENT_REQUIRED, `payment rejected: ${reason}`, paymentRequired));
      return;
    }

    // 3. Write ahead: once this record is on disk a restart keeps refusing the authorization,
    //    even if the process dies before the receipt is written. No record, no execution.
    const paymentId = uuidv4();
    try {
      store.appendAuthorization({
        kind: "authorization",
        payer: authorization.from,
        nonce: authorization.nonce,
        validBefore: authorization.validBefore,
        asset: matched.asset.packageHash,
        paymentId,
        tool: name,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      replay.release(reservation);
      await cancelVerified(processed, name, { reason: "after_verify_aborted", error: err });
      log.error(`[receipts] cannot record a paid call to ${logSafe(name, 80)} (${logSafe(err)}); refusing to run it`);
      res
        .status(503)
        .json(rpcError(id, RPC_INTERNAL_ERROR, "gateway cannot record payments right now; the tool was not run and nothing was charged"));
      return;
    }
    replay.commit(reservation);

    const call: PaidCall = {
      id,
      name,
      args,
      policy,
      price: matched,
      table: snapshot,
      context,
      verified: processed,
      authorization,
      paymentId,
      parentId: parentIdOf(req),
      started,
      hold,
    };
    if (policy.settleBeforeExecute) await settleThenExecute(req, res, call);
    else await executeThenSettle(req, res, call);
  }

  // ---------------------------------------------------------------- JSON-RPC

  async function handleMcp(req: Request, res: Response): Promise<void> {
    const body = req.body as unknown;
    if (Array.isArray(body)) {
      res.status(400).json(rpcError(null, RPC_INVALID_REQUEST, "batch requests are not supported"));
      return;
    }
    if (!isRecord(body) || (body as JsonRpcRequest).jsonrpc !== "2.0") {
      res.status(400).json(rpcError(null, RPC_INVALID_REQUEST, "invalid JSON-RPC request"));
      return;
    }
    const message = body as JsonRpcRequest;
    if (message.id !== undefined && !isJsonRpcId(message.id)) {
      res.status(400).json(rpcError(null, RPC_INVALID_REQUEST, "invalid JSON-RPC id"));
      return;
    }
    const id = message.id as JsonRpcId | undefined;

    if (typeof message.method !== "string") {
      if (id !== undefined && ("result" in message || "error" in message)) {
        res.sendStatus(202); // a response from the client: nothing to answer
        return;
      }
      res.status(400).json(rpcError(id ?? null, RPC_INVALID_REQUEST, "invalid JSON-RPC request"));
      return;
    }

    const versionHeader = req.get("mcp-protocol-version");
    if (message.method !== "initialize" && versionHeader !== undefined && !isSupportedProtocolVersion(versionHeader)) {
      res.status(400).json(rpcError(id ?? null, RPC_INVALID_REQUEST, `unsupported MCP-Protocol-Version: ${clip(versionHeader, 40)}`));
      return;
    }

    if (id === undefined) {
      res.sendStatus(202); // notification
      return;
    }
    if (message.params !== undefined && !isRecord(message.params)) {
      res.json(rpcError(id, RPC_INVALID_PARAMS, "params must be an object"));
      return;
    }
    const params = (message.params ?? {}) as Record<string, unknown>;

    switch (message.method) {
      case "initialize":
        res.json(
          rpcResult(id, {
            protocolVersion: negotiateProtocolVersion(params.protocolVersion),
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: `${cfg.name} (via CasCet)`, version: GATEWAY_VERSION },
          }),
        );
        return;
      case "ping":
        res.json(rpcResult(id, {}));
        return;
      case "tools/list":
        if (params.cursor !== undefined) {
          // The gateway returns every tool in one page, so it never issues a cursor.
          res.json(rpcError(id, RPC_INVALID_PARAMS, "invalid cursor"));
          return;
        }
        res.json(rpcResult(id, { tools: table.visibleTools }));
        return;
      case "tools/call":
        await handleToolCall(req, res, id, params);
        return;
      default:
        res.json(rpcError(id, RPC_METHOD_NOT_FOUND, `method not supported by CasCet gateway: ${clip(message.method, 80)}`));
    }
  }

  // ------------------------------------------------------------------- HTTP

  const app = express();
  app.disable("x-powered-by");

  // Shutting down: calls in flight finish, new ones are refused before anything runs.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    if (!closed) return next();
    res.set("connection", "close");
    res.status(503).json(rpcError(null, RPC_INTERNAL_ERROR, "gateway is shutting down; nothing was run or charged"));
  });

  // Browsers: only allowlisted origins, never "*". A request that carries an Origin
  // header that is not allowlisted is refused (MCP Streamable HTTP: DNS rebinding).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.get("origin");
    if (origin === undefined) return next();
    const normalized = normalizeOrigin(origin);
    if (!normalized || !allowedOrigins.has(normalized)) {
      res.status(403).json(rpcError(null, RPC_INVALID_REQUEST, "Forbidden: origin not allowed"));
      return;
    }
    res.vary("Origin");
    res.set({
      "access-control-allow-origin": normalized,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": CORS_ALLOW_HEADERS,
      "access-control-expose-headers": CORS_EXPOSE_HEADERS,
      "access-control-max-age": "600",
    });
    next();
  });
  app.options("*path", (_req, res) => void res.sendStatus(204));
  app.use(express.json({ limit: "4mb" }));

  app.get("/health", (_req, res) => {
    const snapshot = health();
    res.status(snapshot.status === "unavailable" ? 503 : 200).json(snapshot);
  });

  app.get("/pricing", (_req, res) => {
    const snapshot = table;
    const [preferred] = rail.assets;
    res.json({
      server: cfg.name,
      network: cfg.network,
      // The first (preferred) token, which is all that earlier, single-token gateways reported.
      asset: preferred ? { symbol: preferred.symbol, packageHash: preferred.packageHash } : undefined,
      assets: rail.assets.map(asset => ({
        id: asset.id,
        symbol: asset.symbol,
        name: asset.name,
        packageHash: asset.packageHash,
        decimals: asset.decimals,
        authorizationStyle: asset.authorization,
      })),
      tools: [...snapshot.pricedToolNames, ...snapshot.freeToolNames].map(name => {
        const policy = snapshot.policyOf(name);
        if (policy?.kind !== "paid") return { name };
        // `amountRaw` stays in the preferred token, the top-level `asset`, as for single-token gateways:
        // left out when the tool does not accept that token. Every token's amount is in `accepts`.
        const inPreferred = preferred ? priceIn(policy, preferred.packageHash) : undefined;
        return {
          name,
          priceUsd: policy.price.price,
          amountRaw: inPreferred?.amount,
          asset: inPreferred?.asset.id,
          settleBeforeExecute: policy.settleBeforeExecute,
          accepts: policy.accepts.map(({ asset, amount }) => ({
            asset: asset.id,
            symbol: asset.symbol,
            packageHash: asset.packageHash,
            amountRaw: amount,
            authorizationStyle: asset.authorization,
          })),
        };
      }),
    });
  });

  app.get("/receipts", (_req, res) => void res.json({ receipts: store.list() }));

  // x402 Bazaar-compatible discovery so agents can find these paid tools.
  const discoveryHandler = (req: Request, res: Response): void => {
    const baseUrl = `${req.protocol}://${req.get("host") ?? `localhost:${cfg.port}`}`;
    res.json(buildDiscovery(cfg, rail, table, baseUrl, new Date().toISOString()));
  };
  app.get("/.well-known/x402.json", discoveryHandler);
  app.get("/discovery/resources", discoveryHandler);

  app.post("/mcp", (req, res) => {
    const handled = handleMcp(req, res).catch(err => {
      log.error(`[gateway] unhandled error on /mcp: ${logSafe(err)}`);
      if (!res.headersSent) res.status(500).json(rpcError(null, RPC_INTERNAL_ERROR, "gateway error"));
    });
    inFlight.add(handled);
    void handled.finally(() => inFlight.delete(handled));
  });
  // Stateless JSON endpoint: no SSE stream (GET) and no sessions to delete (DELETE).
  app.all("/mcp", (_req, res) => {
    res.status(405).set("allow", "POST, OPTIONS").json(rpcError(null, RPC_INVALID_REQUEST, "method not allowed: use POST"));
  });

  app.use((_req, res) => void res.status(404).json({ error: "not found" }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const type = isRecord(err) ? err.type : undefined;
    const status = isRecord(err) && typeof err.status === "number" ? err.status : 500;
    if (type === "entity.parse.failed") {
      res.status(400).json(rpcError(null, RPC_PARSE_ERROR, "parse error: invalid JSON"));
    } else if (type === "entity.too.large") {
      res.status(413).json(rpcError(null, RPC_INVALID_REQUEST, "request body too large"));
    } else if (status >= 400 && status < 500) {
      res.status(status).json(rpcError(null, RPC_INVALID_REQUEST, "invalid request"));
    } else {
      log.error(`[http] unhandled error: ${logSafe(err)}`);
      res.status(500).json(rpcError(null, RPC_INTERNAL_ERROR, "gateway error"));
    }
  });

  const server = http.createServer(app);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(cfg.port, cfg.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (err) {
    anchorer?.stop();
    await upstream.close();
    throw err;
  }
  listening = true;

  const address = server.address() as AddressInfo;
  const urlHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  const url = `http://${urlHost}:${address.port}/mcp`;
  log.info(`⛩️  CasCet gateway "${logSafe(cfg.name, 80)}" listening on ${url}`);
  log.info(
    `    priced: ${logSafe(table.pricedToolNames.join(", ") || "none")}` +
      ` | free: ${logSafe(table.freeToolNames.join(", ") || "none")}` +
      ` | hidden (not priced, not in freeTools): ${table.hiddenToolNames.length}`,
  );
  if (!isLoopbackAddress(address.address)) {
    log.warn(`    listening on a non-loopback interface (${logSafe(cfg.host)}): every free tool is reachable by anyone who can reach this port`);
  }
  for (const asset of rail.assets) {
    const settler = facilitatorFor(cfg, asset);
    log.info(
      `    accepts ${logSafe(asset.symbol, 40)} (${logSafe(asset.id, 64)}, ${asset.authorization}) hash-${asset.packageHash}` +
        ` via facilitator "${logSafe(asset.facilitator, 64)}" ${logSafe(facilitatorOrigin(settler.url), 120)}`,
    );
  }
  for (const group of assetsSharingASymbol(rail.assets)) {
    log.warn(
      `    assets ${logSafe(group.map(asset => `"${asset.id}"`).join(", "), 200)} share the symbol ${logSafe(group[0]?.symbol, 40)}: ` +
        "receipts and the payment graph label amounts by symbol, so give each asset its own",
    );
  }
  log.info(`    on-chain settlement check: ${preemption ? "on" : "off (set settlement.nodeUrl to enable)"}`);
  const hosted = rail.assets.filter(asset => isHostedFacilitatorUrl(facilitatorFor(cfg, asset).url)).map(asset => asset.id);
  if (rail.preflightAssets.length > 0) {
    log.info(
      `    on-chain preflight of hosted-facilitator payments (nonce, balance with the payer's payments in flight, token ABI and name): ` +
        `on for ${logSafe(hosted.join(", "), 200)}`,
    );
    if (keptInFlight > 0) {
      log.info(`    payments in flight from before this start (settlement outcome unknown): ${keptInFlight}, counted until they expire`);
    }
  } else if (hosted.length > 0) {
    log.warn(
      `    on-chain preflight of hosted-facilitator payments: off for ${logSafe(hosted.join(", "), 200)} (set settlement.nodeUrl to enable); ` +
        "the hosted facilitator's own nonce pre-check does not work, so a spent authorization reaches its settle",
    );
  }
  announceOnline();

  /**
   * Stop accepting calls, let the ones in flight finish (a paid call may be settling;
   * cutting it would leave a settled payment without a receipt), then close the upstream.
   * Waits at most `drainTimeoutMs`. Idempotent.
   */
  function close(): Promise<void> {
    closing ??= (async () => {
      closed = true;
      pushEvent({ type: "server-offline", server: cfg.name });
      anchorer?.stop();
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeIdleConnections();
      if (inFlight.size > 0) {
        log.info(`[gateway] waiting for ${inFlight.size} call(s) in flight (at most ${Math.ceil(drainTimeoutMs / 1_000)} s)`);
        const drained = await settleWithin(Promise.allSettled([...inFlight]), drainTimeoutMs);
        if (!drained) log.warn(`[gateway] ${inFlight.size} call(s) still in flight after ${drainTimeoutMs} ms; closing their connections`);
      }
      server.closeAllConnections();
      await stopped;
      await upstream.close();
    })();
    return closing;
  }

  return { port: address.port, host: address.address, url, health, close };
}

/** Whether `promise` settled within `ms`. */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref();
  });
  return Promise.race([promise.then(() => true), timeout]).finally(() => clearTimeout(timer));
}

function sendUpstreamError(res: Response, id: JsonRpcId, err: unknown, suffix: string, data?: unknown): void {
  res.json(upstreamError(id, err, suffix, data));
}

function upstreamError(id: JsonRpcId, err: unknown, suffix: string, data?: unknown): JsonRpcErrorBody {
  if (err instanceof UpstreamUnavailableError) {
    return rpcError(id, RPC_INTERNAL_ERROR, `upstream MCP server is unavailable${suffix}`, data);
  }
  if (err instanceof McpError) {
    if (err.code === ErrorCode.RequestTimeout) return rpcError(id, RPC_INTERNAL_ERROR, `upstream tool timed out${suffix}`, data);
    const code = err.code >= -32700 && err.code <= -32600 ? err.code : RPC_INTERNAL_ERROR;
    return rpcError(id, code, `upstream tool failed${suffix}: ${clip(err.message, 300)}`, data);
  }
  return rpcError(id, RPC_INTERNAL_ERROR, `upstream tool failed${suffix}: ${clip(errorMessage(err), 300)}`, data);
}

function parentIdOf(req: Request): string | undefined {
  const value = req.get(HEADER_CASCET_PARENT_ID);
  if (value === undefined) return undefined;
  if (UUID.test(value)) return value.toLowerCase();
  log.warn(`[gateway] ignoring malformed ${HEADER_CASCET_PARENT_ID} header: ${logSafe(value, 80)}`);
  return undefined;
}

/** Refuse replays of authorizations recorded before a restart. */
function seedReplayGuard(replay: ReplayGuard, store: ReceiptStore, maxTimeoutSeconds: number): void {
  // Write-ahead records: written by the gateway itself, before execution, with the exact validBefore.
  for (const record of store.authorizations()) {
    replay.markUsed(replayKey(normalizeAccountAddress(record.payer), record.nonce), (record.validBefore + MAX_CLOCK_SKEW_SECONDS) * 1_000);
  }
  // Receipts, including those written before write-ahead records existed.
  const horizonMs = (maxTimeoutSeconds + MAX_CLOCK_SKEW_SECONDS) * 1_000;
  for (const receipt of store.list()) {
    if (!receipt.nonce || !receipt.payer) continue;
    const created = Date.parse(receipt.createdAt);
    if (Number.isFinite(created)) replay.markUsed(replayKey(normalizeAccountAddress(receipt.payer), receipt.nonce), created + horizonMs);
  }
}

/**
 * After a restart, keep counting in flight the preflighted payments whose settlement outcome was unknown: their
 * transfers may still execute until their authorizations expire (see in-flight.ts). Their receipts give the payer,
 * token and amount, their write-ahead records the validBefore. Returns how many count.
 */
function seedInFlight(rail: PaymentRail, store: ReceiptStore): number {
  const preflighted = new Set(rail.preflightAssets.map(asset => asset.packageHash));
  if (preflighted.size === 0) return 0;
  const validBefore = new Map(store.authorizations().map(record => [record.paymentId, record.validBefore]));
  let kept = 0;
  for (const receipt of store.list()) {
    const until = validBefore.get(receipt.id);
    if (receipt.status !== "unknown" || until === undefined || receipt.network !== rail.network) continue;
    const { asset, payer, amountRaw } = receipt;
    if (typeof asset !== "string" || !preflighted.has(normalizePackageHash(asset)) || typeof payer !== "string") continue;
    if (typeof amountRaw !== "string" || !/^\d{1,78}$/.test(amountRaw)) continue;
    if (rail.inFlight.keep({ network: rail.network, asset, payer, amount: BigInt(amountRaw), validBefore: until }) === "kept") kept++;
  }
  return kept;
}

function paymentRequiredOf(headers: Record<string, string>): PaymentRequired | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === HEADER_PAYMENT_REQUIRED.toLowerCase());
  if (!entry) return undefined;
  try {
    return decodePaymentRequiredHeader(entry[1]);
  } catch {
    return undefined;
  }
}

function withoutContentType(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== "content-type"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackAddress(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address === "::ffff:127.0.0.1";
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

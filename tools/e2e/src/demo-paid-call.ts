import type { CascetConfig } from "@cascet/core";
import { longestPaidCallMs, settlementNodeUrl, type AnchoringHealth } from "@cascet/gateway";
import type { FetchLike, PaidMcpHttpClientOptions, PayingFetch, PayingFetchOptions } from "@cascet/client";
import { ANCHOR_WAIT_MS, waitForAnchor, type AnchorWaitDeps } from "./demo-anchor.js";

/**
 * The paid MCP call of the real-settlement demos. Both give the buyer a
 * deadline beyond the gateway's longest paid call ({@link paidCallTimeoutMs}).
 * demo-real-mainnet (run-real-mainnet.ts) runs its whole call through
 * {@link runMainnetDemoCall}, with the gateway, the buyer's client and the
 * clock injected so tests drive it without a chain or a key.
 */

/**
 * Margin on top of the gateway's longest paid call (longestPaidCallMs): a buyer
 * that gives up before the gateway answers may be charged without receiving
 * the result.
 */
export const PAID_CALL_MARGIN_MS = 15_000;

/** How long the demo's buyer waits for one paid call to the gateway `config` starts. */
export function paidCallTimeoutMs(config: CascetConfig): number {
  return longestPaidCallMs(config, settlementNodeUrl(config) !== undefined) + PAID_CALL_MARGIN_MS;
}

/** A receipt as the gateway lists it (GET /receipts). */
export interface DemoReceipt {
  id: string;
  tool: string;
  status: string;
  txHash?: string;
  anchoredTxHash?: string;
  note?: string;
}

/**
 * This run's receipt: the paid call's own (by payment id) or, when the call
 * failed without one, the newest receipt for `tool` that was not there before
 * the call. Gateway receipts persist across runs: never an old one (L12).
 */
export function runReceipt(
  receipts: readonly DemoReceipt[],
  call: { paymentId?: string | undefined; tool: string; earlier: ReadonlySet<string> },
): DemoReceipt | undefined {
  if (call.paymentId) return receipts.find(r => r.id === call.paymentId);
  return receipts.filter(r => r.tool === call.tool && !call.earlier.has(r.id)).at(-1);
}

/** The started gateway, as the demo uses it. */
export interface DemoGateway {
  health: () => { anchoring: AnchoringHealth | { state: "disabled" } };
  close: () => Promise<void>;
}

/** The buyer's MCP client (PaidMcpHttpClient). */
export interface DemoMcpClient {
  initialize: () => Promise<void>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<{ result: Record<string, unknown>; paymentId?: string | undefined }>;
}

export interface MainnetDemoCall {
  /** The gateway's configuration (it listens on `config.port`). */
  config: CascetConfig;
  /** The buyer's PEM. */
  buyerKeyPath: string;
  /** payTo: the only payee the buyer pays. */
  seller: string;
  /** The token (`hash-…`): the only asset the buyer pays in. */
  asset: string;
  tool: string;
  /** Block explorer for the transaction links, e.g. https://cspr.live. */
  explorer: string;
}

export interface MainnetDemoDeps {
  startGateway: (config: CascetConfig) => Promise<DemoGateway>;
  /** @cascet/client's createPayingFetch. */
  createPayingFetch: (opts: PayingFetchOptions) => Promise<Pick<PayingFetch, "fetch">>;
  /** `new PaidMcpHttpClient(mcpUrl, fetch, options)`. */
  newClient: (mcpUrl: string, fetch: FetchLike, options: PaidMcpHttpClientOptions) => DemoMcpClient;
  /** GET <base>/receipts of the gateway. */
  listReceipts: (base: string) => Promise<DemoReceipt[]>;
  /** The self-hosted facilitator, closed after the gateway. */
  facilitator?: { close: () => Promise<void> };
  /** Clock and limits of the anchor wait (tests). */
  anchorWait?: Pick<AnchorWaitDeps, "now" | "sleep" | "timeoutMs" | "pollMs">;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  error?: (line: string) => void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * demo-real-mainnet's paid call: start the gateway, pay for one call of
 * `tool` with a deadline beyond the gateway's longest paid call, report this
 * run's settlement transaction (also when the call failed), wait for the
 * receipt's anchor (when anchoring is on) and report it, then close the
 * gateway (which lets a running settle finish and record its receipt) and the
 * facilitator, whatever happened. Returns the exit code: 0 once the receipt
 * is settled.
 */
export async function runMainnetDemoCall(call: MainnetDemoCall, deps: MainnetDemoDeps): Promise<number> {
  const log = deps.log ?? (line => console.log(line));
  const warn = deps.warn ?? (line => console.warn(line));
  const error = deps.error ?? (line => console.error(line));
  const base = `http://localhost:${call.config.port}`;
  const timeoutMs = paidCallTimeoutMs(call.config);
  let gateway: DemoGateway | undefined;
  try {
    gateway = await deps.startGateway(call.config);
    const running = gateway;
    log("\n──────── REAL x402 payment on Casper MAINNET ────────\n");

    const paying = await deps.createPayingFetch({
      privateKeyPath: call.buyerKeyPath,
      networks: ["casper:casper"], // the client pays on testnet only unless mainnet is listed
      allowedPayTo: [call.seller],
      allowedAssets: [call.asset],
      timeoutMs,
      onPayment: info => log(`[agent] 💸 authorizing ${info.amountRaw} raw token units → ${info.payTo.slice(0, 12)}…`),
    });
    const client = deps.newClient(`${base}/mcp`, paying.fetch, { timeoutMs });
    await client.initialize();

    const earlier = new Set((await deps.listReceipts(base)).map(r => r.id));
    let paymentId: string | undefined;
    try {
      const outcome = await client.callTool(call.tool, {});
      paymentId = outcome.paymentId;
      const text = (outcome.result["content"] as Array<{ type: string; text?: string }> | undefined)?.find(c => c.type === "text")?.text;
      log(`\n[agent] paid + received (payment ${paymentId}):\n${text}\n`);
    } catch (err) {
      error(`\n[agent] the paid call failed: ${message(err)}\n`);
    }

    const receiptById = async (id: string) => (await deps.listReceipts(base)).find(r => r.id === id);
    const receipt = runReceipt(await deps.listReceipts(base), { paymentId, tool: call.tool, earlier });
    const settled = receipt?.status === "settled" ? receipt : undefined;
    log("──────── real MAINNET settlement ────────");
    log(`settlement tx: ${receipt?.txHash ?? "(none)"}`);
    if (receipt?.txHash) log(`  ${call.explorer}/transaction/${receipt.txHash}`);
    if (!settled) {
      error(`receipt status: ${receipt?.status ?? "(none)"}${receipt?.note ? ` (${receipt.note})` : ""}`);
      error("MAINNET FAIL: no settled receipt — check the facilitator, the token and the balances");
      return 1;
    }

    // The gateway anchors the settled receipt in the background: wait for its
    // outcome instead of a fixed delay, so the run reports what happened.
    const anchoringOn = running.health().anchoring.state !== "disabled";
    if (anchoringOn) log(`\n[demo] waiting for the receipt's anchor (up to ${(deps.anchorWait?.timeoutMs ?? ANCHOR_WAIT_MS) / 1000} s)…`);
    const anchor = await waitForAnchor(settled.id, { health: () => running.health().anchoring, receiptById, ...deps.anchorWait });
    if (anchor.hash) log(`anchor tx: ${anchor.hash}\n  ${call.explorer}/transaction/${anchor.hash}`);
    if (anchoringOn && anchor.note !== "anchored") warn(`[demo] ${anchor.note}`);
    log(`\n✅ REAL x402 settlement succeeded on Casper MAINNET\n`);
    return 0;
  } finally {
    await gateway?.close();
    await deps.facilitator?.close();
  }
}

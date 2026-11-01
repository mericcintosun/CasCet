import { resolve } from "node:path";
import {
  cascetConfigSchema,
  DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE,
  normalizePackageHash,
  usdPriceToTokenUnits,
  type CascetConfig,
} from "@cascet/core";
import { createCasperRpc, startGateway, TokenProbe, type RunningGateway } from "@cascet/gateway";
import { createPayingFetch, PaidMcpHttpClient } from "@cascet/client";
import { formatAmount, formatCspr } from "./amounts.js";
import {
  assertAssetAllowed,
  demoSeller,
  fetchHostedSupported,
  fundingHint,
  HOSTED_FACILITATOR_URL,
  hostedFeePayer,
  hostedFeePayerProblem,
  resolveDemoMode,
  selfHostedEnv,
  type DemoMode,
} from "./demo-matrix.js";
import { NETWORKS, readFacilitatorEnv, type FacilitatorEnvConfig } from "./facilitator-env.js";
import { checkRecorderSeparation } from "./facilitator-roles.js";
import {
  formatCostTable,
  formatGasSuggestions,
  gasSuggestions,
  kindLabel,
  readTransactionReport,
  type TransactionReport,
} from "./gas-report.js";
import { accountHashOfKeyFile } from "./key-file.js";
import { startRealFacilitator, type RealFacilitatorHandle } from "./real-facilitator.js";
import { readCsprBalance } from "./testnet-tx.js";

/**
 * REAL x402 settlement on Casper Testnet — no mock facilitator.
 *
 * One paid MCP call, in one of two tokens, settled by one of two facilitators
 * (demo-matrix.ts):
 *
 *   CASCET_ASSET=legacy (default)  CasCet X402 Token (hash-cb65a928…, legacy-amount: its
 *                                  transfer_with_authorization takes `amount`)
 *   CASCET_ASSET=wcspr             official Wrapped CSPR (hash-3d80df21…, cep3009-value: takes `value`)
 *   CASCET_FACILITATOR=self        (default) the SELF-HOSTED facilitator (src/real-facilitator.ts),
 *                                  fee-sponsored by CASCET_FACILITATOR_KEY (testnet default: the deployer key)
 *   CASCET_FACILITATOR=hosted      the hosted CSPR.cloud facilitator (x402-facilitator.cspr.cloud);
 *                                  needs CSPR_CLOUD_TOKEN, which the gateway sends RAW in the
 *                                  Authorization header (no "Bearer ")
 *
 * `--asset` / `--facilitator` override the variables (`demo-real-wcspr` passes --asset wcspr).
 * Refused combinations: legacy + hosted (the hosted facilitator sends `value`, the legacy token
 * reverts with User error 64658), and wcspr + self until the self-hosted facilitator settles
 * cep3009-value tokens (SELF_HOSTED_SETTLE_STYLES). A hosted run first checks (read-only) that the
 * hosted testnet fee payer can pay a settle: on 2026-11-01 it held 2.145 CSPR, below the 2.5 CSPR a
 * settle needs, so hosted testnet settles fail until MAKE refills it.
 *
 * Before paying it checks (read-only) the token's ABI, name and chain and the buyer's balance.
 * After the settle it waits for the receipt's anchor and reads the settle and anchor transactions
 * back (read-only RPC): consumed gas, refund and net cost per transaction, and a gas limit
 * suggested from the measurement (ceil(1.3 × consumed)).
 *
 * Keys come from the environment (same variables as the standalone facilitator, see
 * src/facilitator-env.ts); on testnet they default to the deployer key so the demo runs as before:
 *   CASCET_FACILITATOR_KEY      fee-payer PEM (self-hosted only)
 *   CASCET_RECORDER_KEY         ReceiptRegistry recorder PEM (anchoring)
 *   CASCET_SELLER_ACCOUNT_HASH  payTo
 *   CASCET_FACILITATOR_TOKEN    optional shared token (also sent by the gateway; self-hosted only)
 * The buyer is tools/e2e/keys/agent.pem (fund it: fund-token, and wrap-wcspr for WCSPR).
 *
 * Run: pnpm --filter @cascet/e2e demo-real          (CasCet X402 Token, self-hosted)
 *      CASCET_FACILITATOR=hosted CSPR_CLOUD_TOKEN=… pnpm --filter @cascet/e2e demo-real-wcspr
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const KEYS = resolve(import.meta.dirname, "../keys");
const TESTNET = NETWORKS["casper:casper-test"];
const NODE_URL = TESTNET.rpcUrl;
const TOOL = "get_cspr_market_data";
const PRICE = "$0.01";
/** The gateway confirms an anchor for up to 120 s (anchoring.confirmTimeoutMs). */
const ANCHOR_WAIT_MS = 150_000;
/**
 * A run-then-settle call is answered after up to facilitatorMs + upstreamMs +
 * settleMs (165 s with the gateway's defaults); a buyer that gives up earlier
 * (the client default is 30 s) may be charged without receiving the result.
 */
const PAID_CALL_TIMEOUT_MS = 180_000;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface ReceiptJson {
  id: string;
  tool: string;
  status: string;
  txHash?: string;
  anchoredTxHash?: string;
  note?: string;
}

async function listReceipts(): Promise<ReceiptJson[]> {
  const body = (await (await fetch("http://localhost:4402/receipts")).json()) as { receipts: ReceiptJson[] };
  return body.receipts;
}

async function receiptById(id: string): Promise<ReceiptJson | undefined> {
  return (await listReceipts()).find(r => r.id === id);
}

const TX_HASH = /^[0-9a-f]{64}$/i;

/** Read-only: the hosted facilitator names a testnet fee payer that can pay for a settle. */
async function hostedPreflight(rpc: ReturnType<typeof createCasperRpc>): Promise<void> {
  let supported: unknown;
  try {
    supported = await fetchHostedSupported(HOSTED_FACILITATOR_URL);
  } catch (err) {
    console.warn(`[demo] warning: cannot read the hosted facilitator's /supported (${message(err)}); fee-payer check skipped`);
    return;
  }
  const feePayer = hostedFeePayer(supported, "casper:casper-test");
  if (!feePayer) throw new Error("the hosted facilitator lists no fee payer for casper:casper-test in /supported");
  let balance: bigint;
  try {
    balance = await readCsprBalance(rpc, feePayer);
  } catch (err) {
    console.warn(`[demo] warning: cannot read the hosted fee payer's balance (${message(err)}); fee-payer check skipped`);
    return;
  }
  const problem = hostedFeePayerProblem(feePayer, balance);
  if (problem) throw new Error(problem);
  console.log(`[demo] hosted fee payer account-hash-${feePayer.slice(0, 8)}… holds ${formatCspr(balance, 3)} CSPR`);
}

/** Wait until the receipt is anchored (or anchoring gave up); a failed anchor's hash comes from the anchorer's last error. */
async function waitForAnchor(gateway: RunningGateway, paymentId: string): Promise<{ hash?: string; note: string }> {
  const deadline = Date.now() + ANCHOR_WAIT_MS;
  for (;;) {
    const anchoring = gateway.health().anchoring; // read before the receipt: the hash is set before the anchor leaves flight
    const receipt = await receiptById(paymentId);
    if (receipt?.anchoredTxHash) return { hash: receipt.anchoredTxHash, note: "anchored" };
    if (anchoring.state === "disabled") return { note: "anchoring is off" };
    if (anchoring.queued === 0 && anchoring.inFlight === 0) {
      const failed = anchoring.lastError?.match(/\b[0-9a-f]{64}\b/)?.[0];
      return { ...(failed ? { hash: failed } : {}), note: `the anchor did not execute: ${anchoring.lastError ?? "skipped"}` };
    }
    if (Date.now() >= deadline) return { note: `still anchoring after ${ANCHOR_WAIT_MS / 1000} s` };
    await sleep(2_000);
  }
}

async function main(): Promise<number> {
  const mode: DemoMode = resolveDemoMode(process.env, process.argv.slice(2));
  const asset = mode.asset;
  const token = normalizePackageHash(asset.config.packageHash);
  const style = asset.config.authorization;
  const hosted = mode.facilitator === "hosted";
  console.log(
    `[demo] paying in ${asset.config.name} (${style}), settled by the ${hosted ? "hosted CSPR.cloud" : "self-hosted"} facilitator`,
  );

  const rpc = createCasperRpc(NODE_URL);
  const probe = new TokenProbe(rpc);
  const recorderEnv = process.env.CASCET_RECORDER_KEY?.trim();
  const RECORDER_KEY = recorderEnv ? resolve(recorderEnv) : resolve(ROOT, "contracts/keys/deployer_secret_key.pem");

  // --- who settles, and to whom ---
  let fac: FacilitatorEnvConfig | undefined;
  let seller: string;
  if (!hosted) {
    fac = readFacilitatorEnv(selfHostedEnv(process.env, asset), ROOT, "casper:casper-test");
    for (const warning of fac.warnings) console.warn(`[demo] warning: ${warning}`);
    assertAssetAllowed(fac.allowedAssets, asset);
    // payTo MUST be a serialized account-hash Key: "00" (account tag) + 32-byte
    // account hash — NOT a public key. The x402 authorization signs `to` as this
    // 33-byte value and the facilitator settles the transfer to that account hash.
    seller = fac.allowedPayTo[0]!;
    // Same role rules as mainnet, as warnings: the testnet demo may run on one key.
    for (const warning of checkRecorderSeparation({
      network: "casper:casper-test",
      recorderAccountHash: accountHashOfKeyFile(RECORDER_KEY, "ed25519", "recorder"),
      feePayerAccountHash: accountHashOfKeyFile(fac.keyPath, fac.keyAlgo, "fee-payer"),
      ownerAccountHashes: fac.ownerAccountHashes,
      sellerAccountHashes: fac.allowedPayTo,
    }).warnings) {
      console.warn(`[demo] warning: ${warning}`);
    }
  } else {
    seller = demoSeller(process.env);
    await hostedPreflight(rpc);
  }

  // --- read-only checks before anyone signs: the token is what the demo expects, the buyer can pay ---
  const [onChainStyle, onChainName, onChainNetwork] = await Promise.all([
    probe.authorizationStyle(token),
    probe.tokenName(token),
    probe.chainName(token),
  ]);
  if (onChainStyle !== style) throw new Error(`${asset.config.name}'s transfer_with_authorization is ${onChainStyle} on-chain, not ${style}`);
  if (onChainName !== asset.config.name) throw new Error(`the token's on-chain name is ${JSON.stringify(onChainName)}, not "${asset.config.name}"`);
  if (onChainNetwork !== undefined && onChainNetwork !== "casper:casper-test") {
    throw new Error(`the token signs authorizations for ${onChainNetwork}, not casper:casper-test`);
  }
  const buyer = accountHashOfKeyFile(resolve(KEYS, "agent.pem"), "ed25519", "buyer");
  const priceUnits = usdPriceToTokenUnits(PRICE, asset.config);
  const buyerBalance = await probe.balanceOf(token, buyer);
  if (buyerBalance < priceUnits) {
    throw new Error(
      `the buyer (account-hash-${buyer}) holds ${formatAmount(buyerBalance, asset.config.decimals)} ${asset.config.symbol}, ` +
        `less than the ${formatAmount(priceUnits, asset.config.decimals)} one call costs; ${fundingHint(asset, buyer)}`,
    );
  }

  // --- the facilitator: self-hosted (fee-sponsored by CASCET_FACILITATOR_KEY, allowlisted) or hosted ---
  let facilitator: RealFacilitatorHandle | undefined;
  if (fac) {
    facilitator = await startRealFacilitator({
      port: fac.port,
      network: "casper:casper-test",
      keyPath: fac.keyPath,
      keyAlgo: fac.keyAlgo,
      rpcUrl: fac.rpcUrl,
      ...(fac.authToken ? { authToken: fac.authToken } : {}),
      allowedPayTo: fac.allowedPayTo,
      allowedAssets: fac.allowedAssets,
      ownerAccountHashes: fac.ownerAccountHashes,
      paymentMotes: fac.paymentMotes,
      dailyGasCapMotes: fac.dailyGasCapMotes,
      settleWaitMs: fac.settleWaitMs,
      preflight: fac.preflight,
      preflightDeadlineMs: fac.preflightDeadlineMs,
      tokenVersion: fac.tokenVersion,
      ...(fac.tokenName ? { tokenName: fac.tokenName } : {}),
    });
  }

  const dataConfig: CascetConfig = cascetConfigSchema.parse({
    name: "casper-defi-data",
    upstream: {
      type: "stdio",
      command: "node",
      args: [resolve(ROOT, "servers/casper-defi-data/dist/index.js")],
    },
    network: "casper:casper-test",
    payTo: seller,
    asset: asset.config,
    facilitator: facilitator
      ? { url: facilitator.url, ...(fac?.authToken ? { apiKey: fac.authToken } : {}) }
      : { url: HOSTED_FACILITATOR_URL, apiKey: mode.hostedApiKey, authScheme: "raw" },
    anchoring: {
      contractPackageHash: TESTNET.receiptRegistry,
      keyPath: RECORDER_KEY,
      keyAlgo: "ed25519",
      nodeUrl: NODE_URL,
      chainName: "casper-test",
    },
    pricing: { tools: { [TOOL]: { price: PRICE } } },
    port: 4402,
  });

  const gateway = await startGateway(dataConfig);
  let code = 1;
  try {
    console.log("\n──────── real x402 payment (buyer holds the token on-chain) ────────\n");

    const paying = await createPayingFetch({
      privateKeyPath: resolve(KEYS, "agent.pem"),
      allowedPayTo: [seller],
      allowedAssets: [asset.config.packageHash],
      timeoutMs: PAID_CALL_TIMEOUT_MS,
      onPayment: info =>
        console.log(
          `[agent] 💸 authorizing ${info.amountRaw} raw units of ${info.asset.slice(0, 10)}… ` +
            `(${info.authorizationStyle ?? "style not advertised"}) → ${info.payTo.slice(0, 12)}…`,
        ),
    });
    const client = new PaidMcpHttpClient("http://localhost:4402/mcp", paying.fetch, { timeoutMs: PAID_CALL_TIMEOUT_MS });
    await client.initialize();

    // Gateway receipts persist across runs: remember the earlier ones, so a failed
    // call is matched to this run's receipt and never to an old one (L12).
    const earlier = new Set((await listReceipts()).map(r => r.id));
    let paymentId: string | undefined;
    try {
      const outcome = await client.callTool(TOOL, {});
      paymentId = outcome.paymentId;
      const text = (outcome.result.content as Array<{ type: string; text?: string }>).find(c => c.type === "text")?.text;
      console.log(`\n[agent] paid + received (payment ${paymentId}):\n${text}\n`);
    } catch (err) {
      console.error(`\n[agent] the paid call failed: ${message(err)}\n`);
    }

    // This payment's own receipt (the new one for this tool when the call failed).
    const receipt = paymentId
      ? await receiptById(paymentId)
      : (await listReceipts()).filter(r => r.tool === TOOL && !earlier.has(r.id)).at(-1);
    const settled = receipt?.status === "settled" ? receipt : undefined;
    console.log("──────── real settlement ────────");
    console.log(`settlement tx: ${settled?.txHash ?? receipt?.txHash ?? "(none)"}`);
    if (receipt?.txHash) console.log(`  ${TESTNET.explorer}/transaction/${receipt.txHash}`);
    if (!settled) {
      console.error(`receipt status: ${receipt?.status ?? "(none)"}${receipt?.note ? ` (${receipt.note})` : ""}`);
    }

    // --- measured gas: the settle and the anchor, read back from the chain ---
    const rows: Array<{ label: string; report: TransactionReport }> = [];
    if (receipt?.txHash && TX_HASH.test(receipt.txHash)) {
      rows.push({ label: "settle", report: await readTransactionReport(rpc, receipt.txHash, { deadlineMs: Date.now() + 60_000 }) });
    }
    if (settled) {
      console.log(`\n[demo] waiting for the receipt's anchor (up to ${ANCHOR_WAIT_MS / 1000} s)…`);
      const anchor = await waitForAnchor(gateway, settled.id);
      if (anchor.hash) {
        console.log(`anchor tx: ${anchor.hash}\n  ${TESTNET.explorer}/transaction/${anchor.hash}`);
        rows.push({ label: "anchor", report: await readTransactionReport(rpc, anchor.hash, { deadlineMs: Date.now() + 60_000 }) });
      }
      if (anchor.note !== "anchored") console.warn(`[demo] ${anchor.note}`);
    }
    if (rows.length > 0) {
      console.log("\n──────── measured gas (read-only RPC) ────────");
      for (const row of rows) if (row.report.kind.kind !== "other") row.label = kindLabel(row.report.kind);
      for (const line of formatCostTable(rows)) console.log(line);
      const configured = (kind: TransactionReport["kind"]): bigint | undefined => {
        if (kind.kind === "anchor") return BigInt(dataConfig.anchoring!.gasMotes);
        if (kind.kind === "settle" && fac) return BigInt(fac.paymentMotes);
        return undefined;
      };
      for (const line of formatGasSuggestions(gasSuggestions(rows.map(r => r.report), configured))) console.log(line);
      console.log(
        `default settle limit for ${style}: ${formatCspr(BigInt(DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE[style]), 2)} CSPR ` +
          "(DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE; set it from the max over 3-5 settles: pnpm --filter @cascet/e2e settle-report <hashes>)",
      );
    }

    if (!settled) {
      console.error("\nREAL FAIL: no settled receipt — check the facilitator, the token and the balances");
      return 1;
    }
    console.log(`\n✅ REAL x402 settlement succeeded on Casper Testnet (${asset.config.name}, ${hosted ? "hosted" : "self-hosted"} facilitator)\n`);
    code = 0;
  } finally {
    await gateway.close();
    await facilitator?.close();
  }
  return code;
}

main().then(
  code => process.exit(code),
  (err: unknown) => {
    console.error(`[demo] ${message(err)}`);
    process.exit(1);
  },
);

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cascetConfigSchema, type CascetConfig } from "@cascet/core";
import { startGateway } from "@cascet/gateway";
import { startMockFacilitator } from "./mock-facilitator.js";

/**
 * FREE live-agent demo — real Claude, no API purchase.
 *
 *   Claude Code (`claude -p`, on your Claude Max plan)
 *        │  connects to the paid MCP tools through `cascet connect`
 *        ▼
 *   CasCet gateway (:4402) — priced DeFi/RWA tools over x402
 *        │  every tools/call returns 402; the connect bridge signs + pays it
 *        ▼
 *   settled on Casper (mock facilitator offline, real with CSPR_CLOUD_TOKEN)
 *
 * The LLM reasoning runs on the Claude Agent SDK / `claude -p` credit included
 * with a Claude Max plan (no pay-as-you-go API spend), while the x402 payments,
 * budget enforcement and receipts are real — exactly the `cascet connect` flow
 * the README pitches for Claude Code / Cursor / Claude Desktop.
 *
 * Run:  pnpm --filter @cascet/e2e connect-demo
 *   real settlement:  CSPR_CLOUD_TOKEN=<token> pnpm --filter @cascet/e2e connect-demo
 * Requires the `claude` CLI logged in (Max/Pro). No ANTHROPIC_API_KEY needed.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const KEYS = resolve(import.meta.dirname, "../keys");
const SCRATCH = resolve(import.meta.dirname, "../.cascet");
const CLI = resolve(ROOT, "packages/cli/dist/cli.js");
const FACILITATOR_PORT = 4500;
const GATEWAY_MCP = "http://localhost:4402/mcp";

const CSPR_CLOUD_TOKEN = process.env.CSPR_CLOUD_TOKEN;
const REAL = Boolean(CSPR_CLOUD_TOKEN);

const readPub = (name: string) => readFileSync(resolve(KEYS, `${name}.pub`), "utf8").trim();

const X402_TOKEN = "hash-cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
const SELLER_DATA_ACCOUNT_HASH = "00881cae32337ce2986bbdc8d391f88242af0f3626a14c62bbe050f7bb64f63f36";

const pricing = {
  tools: {
    get_cspr_market_data: { price: "$0.01" },
    get_rwa_price: { price: "$0.02" },
    get_defi_yields: { price: "$0.02" },
  },
};

const dataConfig: CascetConfig = cascetConfigSchema.parse(
  REAL
    ? {
        name: "casper-defi-data",
        upstream: { type: "stdio", command: "node", args: [resolve(ROOT, "servers/casper-defi-data/dist/index.js")] },
        network: "casper:casper-test",
        payTo: SELLER_DATA_ACCOUNT_HASH,
        asset: { packageHash: X402_TOKEN, name: "CasCet X402 Token", symbol: "WCSPR", decimals: 9, version: "1", tokensPerUsd: 50 },
        facilitator: { url: "https://x402-facilitator.cspr.cloud", apiKey: CSPR_CLOUD_TOKEN },
        anchoring: {
          contractPackageHash: "hash-bdf8422b69d7bfb7581e7b2c63fbfb0fc8b23701181289411170bce5cf996f97",
          keyPath: resolve(ROOT, "contracts/keys/deployer_secret_key.pem"),
          keyAlgo: "ed25519",
          nodeUrl: "https://node.testnet.casper.network/rpc",
          chainName: "casper-test",
        },
        pricing,
        port: 4402,
      }
    : {
        name: "casper-defi-data",
        upstream: { type: "stdio", command: "node", args: [resolve(ROOT, "servers/casper-defi-data/dist/index.js")] },
        payTo: readPub("seller-data"),
        asset: { packageHash: "0000000000000000000000000000000000000000000000000000000000000000", name: "Demo Wrapped CSPR", symbol: "WCSPR", decimals: 9, version: "1", tokensPerUsd: 50 },
        facilitator: { url: `http://localhost:${FACILITATOR_PORT}` },
        pricing,
        port: 4402,
      },
);

function banner(): void {
  const rule = "═".repeat(74);
  console.log(`\n${rule}`);
  console.log(" FREE LIVE AGENT — real Claude via `cascet connect`, no API purchase");
  console.log("");
  console.log(" Claude Code (`claude -p`, on your Max plan) drives the run; it discovers");
  console.log(" the priced MCP tools, decides what to buy, and calls them. Each 402 is");
  console.log(` paid by the connect bridge under a fixed budget. Settlement: ${REAL ? "REAL on-chain" : "mock (offline)"}.`);
  console.log(`${rule}\n`);
}

const maxSessionRaw = (25n * 10n ** 9n).toString();

async function main(): Promise<void> {
  banner();
  // Start each run from a clean receipt store so the proof count reflects THIS run.
  try {
    const store = resolve(process.cwd(), ".cascet");
    for (const f of readdirSync(store)) if (f.endsWith(".receipts.jsonl")) rmSync(resolve(store, f));
  } catch {
    /* no prior store */
  }
  const facilitator = REAL ? undefined : startMockFacilitator(FACILITATOR_PORT);
  const gateway = await startGateway(dataConfig);

  // Point Claude Code at the paid tools through the paying `cascet connect` bridge.
  mkdirSync(SCRATCH, { recursive: true });
  const mcpConfigPath = resolve(SCRATCH, "connect-demo.mcp.json");
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        cascet: {
          command: "node",
          args: [CLI, "connect", GATEWAY_MCP],
          env: {
            CASCET_KEY_PATH: resolve(KEYS, "agent.pem"),
            CASCET_KEY_ALGO: "ed25519",
            CASCET_MAX_SESSION: maxSessionRaw,
          },
        },
      },
    }),
  );

  const goal =
    "You have MCP tools from a Casper 'casper-defi-data' server: get_cspr_market_data, " +
    "get_defi_yields, and get_rwa_price. Each is a PAID tool — its price is noted in the " +
    "tool description and every call settles a real x402 micropayment on Casper. " +
    "I hold a CSPR-heavy portfolio (~80% CSPR) and want steadier, inflation-resistant yield " +
    "without losing too much liquidity. Call the tools you judge worth buying for this goal " +
    "(for RWA, gold and treasury), then give a concrete allocation recommendation grounded in " +
    "the data you purchased. Cite the numbers you paid for.";

  console.log("→ handing the goal to Claude Code (real Claude, Max-plan credit)…\n");

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // force the logged-in subscription, not pay-as-you-go API

  const code = await new Promise<number>((res) => {
    const child = spawn(
      "claude",
      [
        "-p",
        goal,
        "--mcp-config",
        mcpConfigPath,
        "--allowedTools",
        "mcp__cascet__get_cspr_market_data",
        "mcp__cascet__get_defi_yields",
        "mcp__cascet__get_rwa_price",
        "--output-format",
        "text",
      ],
      { env, stdio: ["ignore", "inherit", "inherit"] },
    );
    child.on("close", res);
    child.on("error", (e) => {
      console.error("claude spawn failed:", e.message);
      res(1);
    });
  });

  // Proof: the gateway's receipts are the record of what Claude actually paid for.
  await new Promise((r) => setTimeout(r, 500));
  let receipts: Array<{ tool: string; amountRaw: string; status: string; txHash?: string }> = [];
  try {
    receipts = ((await fetch("http://localhost:4402/receipts").then((r) => r.json())) as { receipts: typeof receipts }).receipts;
  } catch {
    /* ignore */
  }
  const settled = receipts.filter((r) => r.status === "settled");

  console.log(`\n${"─".repeat(40)} payment proof ${"─".repeat(40)}`);
  if (settled.length === 0) {
    console.log("❌ no settled receipts — Claude did not buy any paid tools this run.");
  } else {
    for (const r of settled) {
      const link = REAL && r.txHash ? `  https://testnet.cspr.live/transaction/${r.txHash}` : "";
      console.log(`💸 ${r.tool.padEnd(22)} ${r.amountRaw} raw units  [${r.status}]${link}`);
    }
    console.log(`\n✅ CONNECT DEMO PASS — Claude bought ${settled.length} paid tool call(s) via cascet connect${REAL ? " (real on-chain settlement)" : " (mock facilitator)"}.`);
  }

  await gateway.close();
  facilitator?.close?.();
  process.exit(settled.length > 0 && code === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

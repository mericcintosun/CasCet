import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cascetConfigSchema, type CascetConfig } from "@cascet/core";
import { startGateway } from "@cascet/gateway";
import { createPayingFetch, PaidMcpHttpClient } from "@cascet/client";
import { startMockFacilitator } from "./mock-facilitator.js";

/**
 * Full local cascade demo, no chain required:
 *
 *   agent wallet ──pays──▶ portfolio-analyst gateway (:4403)
 *                              │ analyst wallet ──pays──▶ casper-defi-data gateway (:4402)
 *
 * Run: pnpm --filter @cascet/e2e demo   (after gen-keys)
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const KEYS = resolve(import.meta.dirname, "../keys");
const FACILITATOR_PORT = 4500;

const pub = (name: string) => readFileSync(resolve(KEYS, `${name}.pub`), "utf8").trim();

const baseAsset = {
  packageHash: "0000000000000000000000000000000000000000000000000000000000000000",
  name: "Demo Wrapped CSPR",
  symbol: "WCSPR",
  decimals: 9,
  version: "1",
  tokensPerUsd: 50,
};

const dataConfig: CascetConfig = cascetConfigSchema.parse({
  name: "casper-defi-data",
  upstream: {
    type: "stdio",
    command: "node",
    args: [resolve(ROOT, "servers/casper-defi-data/dist/index.js")],
  },
  payTo: pub("seller-data"),
  asset: baseAsset,
  facilitator: { url: `http://localhost:${FACILITATOR_PORT}` },
  pricing: {
    tools: {
      get_cspr_market_data: { price: "$0.01" },
      get_rwa_price: { price: "$0.02" },
      get_defi_yields: { price: "$0.02" },
    },
  },
  port: 4402,
});

const analystConfig: CascetConfig = cascetConfigSchema.parse({
  name: "portfolio-analyst",
  upstream: {
    type: "stdio",
    command: "node",
    args: [resolve(ROOT, "servers/portfolio-analyst/dist/index.js")],
    env: {
      DATA_GATEWAY_URL: "http://localhost:4402/mcp",
      CASCET_KEY_PATH: resolve(KEYS, "analyst.pem"),
    },
  },
  payTo: pub("seller-analyst"),
  asset: baseAsset,
  facilitator: { url: `http://localhost:${FACILITATOR_PORT}` },
  pricing: { tools: { analyze_portfolio: { price: "$0.10" } } },
  port: 4403,
});

const facilitator = startMockFacilitator(FACILITATOR_PORT);
const dataGateway = await startGateway(dataConfig);
const analystGateway = await startGateway(analystConfig);

console.log("\n──────── agent starts buying ────────\n");

const paying = await createPayingFetch({
  privateKeyPath: resolve(KEYS, "agent.pem"),
  onPayment: info => console.log(`[agent] 💸 paying ${info.amountRaw} raw units`),
});
const analyst = new PaidMcpHttpClient("http://localhost:4403/mcp", paying.fetch);
await analyst.initialize();

const tools = await analyst.listTools();
console.log(`[agent] tools on offer: ${tools.map(t => t.name).join(", ")}`);

const { result, paymentId } = await analyst.callTool("analyze_portfolio", {
  holdings: [
    { asset: "CSPR", amountUsd: 7000 },
    { asset: "gold", amountUsd: 2000 },
    { asset: "treasury", amountUsd: 1000 },
  ],
});

const text = (result.content as Array<{ type: string; text?: string }>).find(c => c.type === "text")?.text;
console.log(`\n[agent] analysis received (root payment ${paymentId}):\n${text}\n`);

// ---- Assert the cascade actually linked up -----------------------------------
const dataReceipts = ((await (await fetch("http://localhost:4402/receipts")).json()) as {
  receipts: Array<{ id: string; parentId?: string; tool: string; status: string }>;
}).receipts;
const analystReceipts = ((await (await fetch("http://localhost:4403/receipts")).json()) as {
  receipts: Array<{ id: string; parentId?: string; tool: string; status: string }>;
}).receipts;

const rootReceipt = analystReceipts.find(r => r.tool === "analyze_portfolio" && r.status === "settled");
const children = dataReceipts.filter(r => r.parentId === rootReceipt?.id);

console.log("──────── cascade verification ────────");
console.log(`root:     ${rootReceipt?.id} (analyze_portfolio, ${rootReceipt?.status})`);
for (const child of children) {
  console.log(`  child:  ${child.id} (${child.tool}) parent=${child.parentId}`);
}

if (!rootReceipt) throw new Error("E2E FAIL: no settled root receipt on analyst gateway");
if (children.length < 3) throw new Error(`E2E FAIL: expected ≥3 cascade children, got ${children.length}`);
console.log(`\n✅ E2E PASS — ${children.length} downstream payments correctly linked to root ${rootReceipt.id}\n`);

await analystGateway.close();
await dataGateway.close();
facilitator.close();
process.exit(0);

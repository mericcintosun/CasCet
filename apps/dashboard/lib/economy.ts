import type { PaymentReceipt } from "@cascet/core";
import { toBigIntSafe } from "./utils";

/** Deployed CasCet contracts on Casper Testnet (canonical on-chain state). */
export const CONTRACTS = {
  receiptRegistry: "bdf8422b69d7bfb7581e7b2c63fbfb0fc8b23701181289411170bce5cf996f97",
  revenueSplit: "fa21efb406a8151d15a393bc366e51192a9ea15fd7fe23faffc54f021b32883c",
  demoToken: "b3e9908b6cdbf5c565b686938994e3ac8e6749f41bcbe83615604321a0965d49",
} as const;

export const CSPR_LIVE_CONTRACT = "https://testnet.cspr.live/contract-package/";

export interface ServerStat {
  server: string;
  revenueRaw: bigint;
  calls: number;
  uniquePayers: number;
  tools: number;
}

export interface ToolStat {
  key: string;
  server: string;
  tool: string;
  revenueRaw: bigint;
  calls: number;
}

export interface EconomyStats {
  totalRevenueRaw: bigint;
  settledCalls: number;
  anchoredCount: number;
  uniquePayers: number;
  roots: number;
  cascaded: number;
  maxDepth: number;
  servers: ServerStat[];
  tools: ToolStat[];
  assetSymbol: string;
}

/** Aggregate the on-chain-anchored receipts into an economy-wide view. */
export function computeEconomy(receipts: PaymentReceipt[]): EconomyStats {
  const settled = receipts.filter(r => r.status === "settled");
  const byId = new Map(settled.map(r => [r.id, r]));

  const serverMap = new Map<string, { revenue: bigint; calls: number; payers: Set<string>; tools: Set<string> }>();
  const toolMap = new Map<string, { server: string; tool: string; revenue: bigint; calls: number }>();
  const allPayers = new Set<string>();

  for (const r of settled) {
    const amount = toBigIntSafe(r.amountRaw);
    allPayers.add(r.payer);

    const s = serverMap.get(r.server) ?? { revenue: 0n, calls: 0, payers: new Set(), tools: new Set() };
    s.revenue += amount;
    s.calls += 1;
    s.payers.add(r.payer);
    s.tools.add(r.tool);
    serverMap.set(r.server, s);

    const tk = `${r.server}:${r.tool}`;
    const t = toolMap.get(tk) ?? { server: r.server, tool: r.tool, revenue: 0n, calls: 0 };
    t.revenue += amount;
    t.calls += 1;
    toolMap.set(tk, t);
  }

  // Cascade depth: walk parentId chains.
  const depthOf = (r: PaymentReceipt): number => {
    let depth = 0;
    let cur: PaymentReceipt | undefined = r;
    const seen = new Set<string>();
    while (cur?.parentId && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parentId);
      depth += 1;
    }
    return depth;
  };
  const maxDepth = settled.reduce((m, r) => Math.max(m, depthOf(r)), 0);

  return {
    totalRevenueRaw: settled.reduce((sum, r) => sum + toBigIntSafe(r.amountRaw), 0n),
    settledCalls: settled.length,
    anchoredCount: settled.filter(r => r.anchoredTxHash).length,
    uniquePayers: allPayers.size,
    roots: settled.filter(r => !r.parentId).length,
    cascaded: settled.filter(r => r.parentId).length,
    maxDepth,
    assetSymbol: settled[0]?.assetSymbol ?? "WCSPR",
    servers: [...serverMap.entries()]
      .map(([server, s]) => ({
        server,
        revenueRaw: s.revenue,
        calls: s.calls,
        uniquePayers: s.payers.size,
        tools: s.tools.size,
      }))
      .sort((a, b) => (b.revenueRaw > a.revenueRaw ? 1 : -1)),
    tools: [...toolMap.entries()]
      .map(([key, t]) => ({ key, server: t.server, tool: t.tool, revenueRaw: t.revenue, calls: t.calls }))
      .sort((a, b) => (b.revenueRaw > a.revenueRaw ? 1 : -1)),
  };
}

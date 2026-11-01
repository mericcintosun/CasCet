import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPaymentGraph, type PaymentReceipt } from "@cascet/core";
import { aggregateEdges, cascadeReceiptIds, edgeLabel } from "./graph";

let n = 0;
const r = (over: Partial<PaymentReceipt>): PaymentReceipt => ({
  id: `r${++n}`,
  createdAt: `2026-10-01T00:00:${String(n).padStart(2, "0")}Z`,
  network: "casper:casper-test",
  server: "casper-defi-data",
  tool: "get_rwa_price",
  payer: `00${"aa".repeat(32)}`,
  payTo: `00${"bb".repeat(32)}`,
  amountRaw: "500000000",
  asset: "cc".repeat(32),
  assetSymbol: "WCSPR",
  status: "settled",
  ...over,
});

const fmt = (raw: bigint, symbol: string) => `${Number(raw) / 1e9} ${symbol}`;

test("receipts between the same two nodes collapse into one edge with a count and a total", () => {
  const receipts = [
    ...Array.from({ length: 7 }, () => r({})),
    r({ tool: "get_cspr_market_data", amountRaw: "250000000" }),
  ];
  const edges = aggregateEdges(buildPaymentGraph(receipts).edges);
  assert.equal(edges.length, 1);
  const [e] = edges;
  assert.equal(e!.calls, 8);
  assert.deepEqual(e!.tools, ["get_rwa_price", "get_cspr_market_data"]);
  assert.equal(e!.receiptIds.length, 8);
  assert.deepEqual(e!.totals, [{ symbol: "WCSPR", raw: 3_750_000_000n }]);
  assert.equal(edgeLabel(e!, fmt), "2 tools · 8 calls · 3.75 WCSPR");
});

test("a single-tool single-call edge reads naturally; mixed assets are listed separately", () => {
  const one = aggregateEdges(buildPaymentGraph([r({})]).edges);
  assert.equal(edgeLabel(one[0]!, fmt), "get_rwa_price · 1 call · 0.5 WCSPR");
  const mixed = aggregateEdges(buildPaymentGraph([r({}), r({ assetSymbol: "USDC", amountRaw: "1000000000" })]).edges);
  assert.equal(edgeLabel(mixed[0]!, fmt), "get_rwa_price · 2 calls · 0.5 WCSPR + 1 USDC");
});

test("highlighted edges are ordered last so they paint on top", () => {
  const root = r({ server: "portfolio-analyst", tool: "analyze_portfolio" });
  const child = r({ parentId: root.id });
  const other = r({ payer: `00${"dd".repeat(32)}`, server: "weather" });
  const graph = buildPaymentGraph([child, root, other]);
  const edges = aggregateEdges(graph.edges, new Set([root.id, child.id]));
  assert.equal(edges.length, 3);
  assert.deepEqual(edges.map((e) => e.hot), [false, true, true]);
});

test("the newest cascade is found at any depth, not just one parent level", () => {
  const a = r({});
  const b = r({ parentId: a.id });
  const c = r({ parentId: b.id });
  const d = r({ parentId: c.id });
  const unrelated = r({});
  const ids = cascadeReceiptIds([d, c, b, a, unrelated], d.id);
  assert.deepEqual([...ids].sort(), [a.id, b.id, c.id, d.id].sort());
  assert.equal(cascadeReceiptIds([a], null).size, 0);
  assert.equal(cascadeReceiptIds([a], "missing").size, 0);
});

test("parent cycles and parents outside the view do not hang or crash", () => {
  const x = r({ id: "x", parentId: "y" });
  const y = r({ id: "y", parentId: "x" });
  const orphan = r({ id: "o", parentId: "not-loaded" });
  assert.deepEqual([...cascadeReceiptIds([x, y], "x")].sort(), ["x", "y"]);
  assert.deepEqual([...cascadeReceiptIds([orphan, x], "o")], ["o"]);
});

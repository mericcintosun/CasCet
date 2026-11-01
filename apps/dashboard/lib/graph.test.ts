import { test } from "node:test";
import assert from "node:assert/strict";
import type { PaymentGraph, PaymentReceipt } from "@cascet/core";
import { aggregateEdges, cascadeReceiptIds, edgeLabel } from "./graph";

// Edges in the shape @cascet/core buildPaymentGraph emits: one per settled receipt.
type Edge = PaymentGraph["edges"][number];
let n = 0;
const edge = (over: Partial<Edge> = {}): Edge => ({
  from: "agent:00aa",
  to: "server:casper-defi-data",
  receiptId: `r${++n}`,
  tool: "get_rwa_price",
  amountRaw: "500000000",
  assetSymbol: "WCSPR",
  ...over,
});

const receipt = (over: Partial<PaymentReceipt>): PaymentReceipt => ({
  id: `p${++n}`,
  createdAt: "2026-10-01T00:00:00Z",
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

test("edges between the same two nodes collapse into one with a count and a total", () => {
  const edges = aggregateEdges([...Array.from({ length: 7 }, () => edge()), edge({ tool: "get_cspr_market_data", amountRaw: "250000000" })]);
  assert.equal(edges.length, 1);
  const [e] = edges;
  assert.equal(e!.calls, 8);
  assert.deepEqual(e!.tools, ["get_rwa_price", "get_cspr_market_data"]);
  assert.equal(e!.receiptIds.length, 8);
  assert.deepEqual(e!.totals, [{ symbol: "WCSPR", raw: 3_750_000_000n }]);
  assert.equal(edgeLabel(e!, fmt), "2 tools · 8 calls · 3.75 WCSPR");
});

test("a single-tool single-call edge reads naturally; mixed assets are listed separately", () => {
  assert.equal(edgeLabel(aggregateEdges([edge()])[0]!, fmt), "get_rwa_price · 1 call · 0.5 WCSPR");
  const mixed = aggregateEdges([edge(), edge({ assetSymbol: "USDC", amountRaw: "1000000000" })]);
  assert.equal(edgeLabel(mixed[0]!, fmt), "get_rwa_price · 2 calls · 0.5 WCSPR + 1 USDC");
});

test("malformed amounts count as zero instead of crashing the render", () => {
  const [e] = aggregateEdges([edge({ amountRaw: "x" }), edge({ amountRaw: "-5" }), edge({ amountRaw: "10" })]);
  assert.deepEqual(e!.totals, [{ symbol: "WCSPR", raw: 10n }]);
});

test("highlighted edges are ordered last so they paint on top", () => {
  const root = edge({ to: "server:portfolio-analyst", tool: "analyze_portfolio" });
  const child = edge({ from: "server:portfolio-analyst" });
  const other = edge({ from: "agent:00dd", to: "server:weather" });
  const edges = aggregateEdges([child, root, other], new Set([root.receiptId, child.receiptId]));
  assert.equal(edges.length, 3);
  assert.deepEqual(edges.map((e) => [e.key, e.hot]), [
    ["agent:00dd→server:weather", false],
    ["server:portfolio-analyst→server:casper-defi-data", true],
    ["agent:00aa→server:portfolio-analyst", true],
  ]);
});

test("the newest cascade is found at any depth, not just one parent level", () => {
  const a = receipt({});
  const b = receipt({ parentId: a.id });
  const c = receipt({ parentId: b.id });
  const d = receipt({ parentId: c.id });
  const unrelated = receipt({});
  const ids = cascadeReceiptIds([d, c, b, a, unrelated], d.id);
  assert.deepEqual([...ids].sort(), [a.id, b.id, c.id, d.id].sort());
  assert.equal(cascadeReceiptIds([a], null).size, 0);
  assert.equal(cascadeReceiptIds([a], "missing").size, 0);
});

test("parent cycles and parents outside the view do not hang or crash", () => {
  const x = receipt({ id: "x", parentId: "y" });
  const y = receipt({ id: "y", parentId: "x" });
  const orphan = receipt({ id: "o", parentId: "not-loaded" });
  assert.deepEqual([...cascadeReceiptIds([x, y], "x")].sort(), ["x", "y"]);
  assert.deepEqual([...cascadeReceiptIds([orphan, x], "o")], ["o"]);
});

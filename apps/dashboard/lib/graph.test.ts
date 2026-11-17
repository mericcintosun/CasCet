import { test } from "node:test";
import assert from "node:assert/strict";
import type { PaymentGraph, PaymentReceipt } from "@cascet/core";
import { aggregateEdges, cascadeReceiptIds, edgeLabel, GRAPH_LAYOUT, layoutEdges, layoutNodes, type Box } from "./graph";

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

// ── layout ──────────────────────────────────────────────────────────────────

/** Points along an SVG path made of absolute M / C / L commands (what layoutEdges emits). */
function samplePath(d: string, steps = 40): Array<{ x: number; y: number }> {
  const tokens = d.match(/[MCL]|-?\d+(?:\.\d+)?/g) ?? [];
  const pts: Array<{ x: number; y: number }> = [];
  let i = 0;
  let cur = { x: 0, y: 0 };
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === "M" || cmd === "L") {
      const next = { x: num(), y: num() };
      if (cmd === "L") for (let s = 1; s <= steps; s++) pts.push({ x: cur.x + ((next.x - cur.x) * s) / steps, y: cur.y + ((next.y - cur.y) * s) / steps });
      else pts.push(next);
      cur = next;
    } else if (cmd === "C") {
      const [c1, c2, end] = [{ x: num(), y: num() }, { x: num(), y: num() }, { x: num(), y: num() }];
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const u = 1 - t;
        pts.push({
          x: u * u * u * cur.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x,
          y: u * u * u * cur.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y,
        });
      }
      cur = end;
    } else throw new Error(`unexpected path token ${cmd}`);
  }
  return pts;
}

const nodeBox = (n: { x: number; y: number }): Box => ({
  x0: n.x - GRAPH_LAYOUT.NODE_W / 2,
  x1: n.x + GRAPH_LAYOUT.NODE_W / 2,
  y0: n.y - GRAPH_LAYOUT.NODE_H / 2,
  y1: n.y + GRAPH_LAYOUT.NODE_H / 2,
});
const hit = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const inside = (p: { x: number; y: number }, b: Box) => p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1;
const lines = (e: { tools: string[]; calls: number }): [string, string] => [e.tools.join(","), `${e.calls} calls · 1 WCSPR`];

test("layout: edges that skip a layer run on lanes that clear every node; no label overlaps a node or another label", () => {
  // The live data shape: agent → analyst → data (a cascade), plus agents buying from data directly.
  // agent:00b2 sits in the second row, so its lane has to climb past the analyst.
  const edges = [
    edge({ to: "server:analyst", tool: "analyze_portfolio" }),
    edge({ from: "server:analyst", to: "server:data" }),
    edge({ from: "server:analyst", to: "server:data", tool: "get_defi_yields" }),
    ...Array.from({ length: 7 }, () => edge({ to: "server:data" })),
    edge({ from: "agent:00b2", to: "server:data", tool: "get_cspr_market_data" }),
    edge({ from: "agent:00c3", to: "server:data" }),
  ];
  const nodes = [
    { id: "agent:00aa", kind: "agent" as const, label: "00aa" },
    { id: "server:analyst", kind: "server" as const, label: "analyst" },
    { id: "server:data", kind: "server" as const, label: "data" },
    { id: "agent:00b2", kind: "agent" as const, label: "00b2" },
    { id: "agent:00c3", kind: "agent" as const, label: "00c3" },
  ];
  const layout = layoutNodes({ nodes, edges });
  assert.deepEqual(
    nodes.map((n) => layout.byId.get(n.id)!.depth),
    [0, 1, 2, 0, 0],
  );
  const aggregated = aggregateEdges(edges);
  const geo = layoutEdges(aggregated, layout.byId, lines);
  assert.deepEqual(
    geo.map((g) => g.edge.key),
    aggregated.map((e) => e.key),
    "the input (paint) order is kept",
  );

  // No path runs through a node other than its own two ends.
  for (const g of geo) {
    for (const n of layout.nodes) {
      if (n.id === g.edge.from || n.id === g.edge.to) continue;
      const crossing = samplePath(g.d).find((p) => inside(p, nodeBox(n)));
      assert.equal(crossing, undefined, `${g.edge.key} runs through ${n.id} at ${JSON.stringify(crossing)}`);
    }
  }

  // The three skip edges get three distinct lanes, all above the analyst, and each label sits right on
  // top of its own lane (between it and the next lane up), so it is clear which lane it belongs to.
  const analyst = layout.byId.get("server:analyst")!;
  const skips = geo.filter((g) => g.edge.to === "server:data" && g.edge.from.startsWith("agent:"));
  assert.equal(skips.length, 3);
  assert.equal(new Set(skips.map((g) => g.top)).size, 3);
  for (const g of skips) {
    assert.ok(g.top < analyst.y - GRAPH_LAYOUT.NODE_H / 2, `${g.edge.key} lane at ${g.top}`);
    assert.equal(g.labelDy, 0, `${g.edge.key} label stays on its lane`);
    assert.ok(g.box.y1 <= g.top && g.box.y1 > g.top - 4, `${g.edge.key} label sits just above its lane`);
  }
  // The higher the source row, the higher its lane, so the rises into the lanes never cross.
  const sourceY = (g: (typeof skips)[number]) => layout.byId.get(g.edge.from)!.y;
  const bySource = [...skips].sort((a, b) => sourceY(a) - sourceY(b));
  assert.deepEqual(
    bySource.map((g) => g.top),
    bySource.map((g) => g.top).sort((a, b) => a - b),
  );

  for (const [i, g] of geo.entries()) {
    for (const n of layout.nodes) assert.equal(hit(g.box, nodeBox(n)), false, `label of ${g.edge.key} overlaps ${n.id}`);
    for (const other of geo.slice(i + 1)) assert.equal(hit(g.box, other.box), false, `labels of ${g.edge.key} and ${other.edge.key} overlap`);
  }
});

test("layout: in random payment DAGs no edge ever runs through a node that is not one of its ends", () => {
  // Seeded LCG so a failure is reproducible.
  let seed = 42;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  for (let round = 0; round < 60; round++) {
    const count = 3 + rand(8);
    const ids = Array.from({ length: count }, (_, i) => (i < 2 ? `agent:${i}` : `server:${i}`));
    const edges: Edge[] = [];
    // Only "forward" edges (lower index pays higher index), like real payment chains: no cycles.
    for (let k = 0; k < count * 2; k++) {
      const a = rand(count - 1);
      const b = a + 1 + rand(count - a - 1);
      if (!ids[b]!.startsWith("server:")) continue;
      edges.push(edge({ from: ids[a]!, to: ids[b]!, tool: `t${rand(3)}` }));
    }
    const nodes = ids.map((id) => ({ id, kind: id.startsWith("agent:") ? ("agent" as const) : ("server" as const), label: id }));
    const layout = layoutNodes({ nodes, edges });
    for (const g of layoutEdges(aggregateEdges(edges), layout.byId, lines)) {
      const pts = samplePath(g.d);
      for (const n of layout.nodes) {
        if (n.id === g.edge.from || n.id === g.edge.to) continue;
        const crossing = pts.find((p) => inside(p, nodeBox(n)));
        assert.equal(crossing, undefined, `round ${round}: ${g.edge.key} runs through ${n.id}`);
      }
    }
  }
});

test("layout: the highlighted edge's label is placed first, so it keeps its spot on the edge", () => {
  // Two crossing edges whose midpoints (and so their preferred label spots) coincide.
  const nodes = [
    { id: "agent:00aa", kind: "agent" as const, label: "00aa" },
    { id: "agent:00bb", kind: "agent" as const, label: "00bb" },
    { id: "server:x", kind: "server" as const, label: "x" },
    { id: "server:y", kind: "server" as const, label: "y" },
  ];
  const a = edge({ from: "agent:00aa", to: "server:y", tool: "first" });
  const b = edge({ from: "agent:00bb", to: "server:x", tool: "second" });
  const layout = layoutNodes({ nodes, edges: [a, b] });
  const spot = (hot?: Set<string>) =>
    Object.fromEntries(layoutEdges(aggregateEdges([a, b], hot), layout.byId, lines).map((g) => [g.edge.tools[0], g.labelDy]));

  const plain = spot();
  assert.equal(plain.first, 0);
  assert.notEqual(plain.second, 0, "the labels compete for one spot");

  const highlighted = spot(new Set([b.receiptId]));
  assert.equal(highlighted.second, 0, "the highlighted edge keeps the spot on its edge");
  assert.notEqual(highlighted.first, 0);
});

test("layout: an edge to a node outside the graph is skipped, not drawn to the origin", () => {
  const layout = layoutNodes({ nodes: [{ id: "agent:00aa", kind: "agent", label: "00aa" }], edges: [] });
  assert.deepEqual(layoutEdges(aggregateEdges([edge({ to: "server:gone" })]), layout.byId, lines), []);
});

test("parent cycles and parents outside the view do not hang or crash", () => {
  const x = receipt({ id: "x", parentId: "y" });
  const y = receipt({ id: "y", parentId: "x" });
  const orphan = receipt({ id: "o", parentId: "not-loaded" });
  assert.deepEqual([...cascadeReceiptIds([x, y], "x")].sort(), ["x", "y"]);
  assert.deepEqual([...cascadeReceiptIds([orphan, x], "o")], ["o"]);
});

/**
 * A settled (or attempted) x402 payment for one MCP tool call.
 *
 * `parentId` is what makes CasCet's cascading payments possible: when tool A
 * internally buys from tool B, B's receipt carries A's payment id, so the
 * whole chain reconstructs into a payment graph without any central
 * coordinator.
 */
export interface PaymentReceipt {
  /** CasCet payment id (uuid v4), minted by the gateway that settled the call. */
  id: string;
  /** Payment id of the upstream call that funded this one, if part of a cascade. */
  parentId?: string;
  createdAt: string;
  /** CAIP-2 network, e.g. "casper:casper-test". */
  network: string;
  /** Gateway/server display name. */
  server: string;
  /** MCP tool that was called. */
  tool: string;
  /** Payer public key (buyer agent). */
  payer: string;
  /** Payee public key or contract account. */
  payTo: string;
  /** Raw CEP-18 token units transferred. */
  amountRaw: string;
  /** CEP-18 package hash. */
  asset: string;
  assetSymbol: string;
  /** USD money string the price was configured as, e.g. "$0.05". */
  priceUsd?: string;
  /** Settlement transaction (deploy) hash on Casper, when available. */
  txHash?: string;
  status: "settled" | "failed";
  /** End-to-end gateway latency for the paid call, in milliseconds. */
  latencyMs?: number;
  /** Set when the receipt hash has been anchored in the on-chain ReceiptRegistry. */
  anchoredTxHash?: string;
}

/** Node/edge projection of a set of receipts, used by the dashboard payment graph. */
export interface PaymentGraph {
  nodes: Array<{ id: string; kind: "agent" | "server"; label: string }>;
  edges: Array<{
    from: string;
    to: string;
    receiptId: string;
    tool: string;
    amountRaw: string;
    assetSymbol: string;
    txHash?: string;
  }>;
}

/** Build a payment graph from receipts (agents and servers become nodes, payments become edges). */
export function buildPaymentGraph(receipts: PaymentReceipt[]): PaymentGraph {
  const nodes = new Map<string, { id: string; kind: "agent" | "server"; label: string }>();
  const edges: PaymentGraph["edges"] = [];
  const byId = new Map(receipts.map(r => [r.id, r]));

  for (const r of receipts) {
    if (r.status !== "settled") continue;
    const parent = r.parentId ? byId.get(r.parentId) : undefined;
    // Payer node: either the root agent, or the upstream server that cascaded.
    const payerNodeId = parent ? `server:${parent.server}` : `agent:${r.payer}`;
    if (parent) {
      nodes.set(payerNodeId, { id: payerNodeId, kind: "server", label: parent.server });
    } else {
      nodes.set(payerNodeId, { id: payerNodeId, kind: "agent", label: shortKey(r.payer) });
    }
    const serverNodeId = `server:${r.server}`;
    nodes.set(serverNodeId, { id: serverNodeId, kind: "server", label: r.server });
    edges.push({
      from: payerNodeId,
      to: serverNodeId,
      receiptId: r.id,
      tool: r.tool,
      amountRaw: r.amountRaw,
      assetSymbol: r.assetSymbol,
      txHash: r.txHash,
    });
  }
  return { nodes: [...nodes.values()], edges };
}

export function shortKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : key;
}

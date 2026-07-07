# Paid MCP over x402 — a cascade-aware extension

**Status:** Draft proposal · **Author:** CasCet (Casper Agentic Buildathon 2026) · **Version:** 0.1

This document proposes a small, backwards-compatible convention for turning
[Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers into
**paid** services that autonomous agents can discover, price, and buy from —
and, crucially, that can **compose**: a paid tool that itself buys from other
paid tools, with every hop attributable on-chain.

It is written against Casper's native [x402](https://www.casper.network/ai)
facilitator, but the conventions are transport- and chain-agnostic. CasCet
implements every part of this document today; the goal here is to describe the
convention precisely enough that other MCP servers and agent runtimes can
interoperate without depending on CasCet's code.

## Why

MCP standardized *how agents call tools*. It says nothing about *paying for
them*, so almost every MCP server is free. x402 standardized *paying for an HTTP
request*, but treats each paid endpoint as an isolated vending machine.

Real agent work is neither. A "portfolio analysis" tool internally needs a
"price feed" tool and an "RWA data" tool — each a paid service in its own right.
Today nobody settles those **payment chains**, and no convention lets an agent
see a tool's price *before* it commits to calling it. This proposal fills both
gaps with three layers:

1. **Price advertisement** — a tool states its price in `tools/list`.
2. **Payment** — a `tools/call` is settled with standard x402.
3. **Cascade attribution** — nested paid calls are linked parent→child so a
   whole call tree is one auditable, budget-bounded economic unit.

## Terminology

- **Gateway** — an HTTP endpoint that fronts an MCP server and enforces payment.
- **Buyer** — an agent (or another gateway) that calls a paid tool.
- **Payment id** — a gateway-minted UUID identifying one settled `tools/call`.
- **Cascade** — a tree of paid calls rooted at a buyer's top-level request.

## Layer 1 — Price advertisement (`tools/list`)

A paid gateway MUST annotate each payable tool in its `tools/list` result with a
`_meta.cascet` object. `_meta` is MCP's standard extension slot, so unaware
clients ignore it and keep working.

```jsonc
{
  "name": "get_rwa_price",
  "description": "Price of a tokenized real-world asset (gold / treasuries).",
  "inputSchema": { "type": "object", "properties": { "asset": { "enum": ["gold", "treasury"] } } },
  "_meta": {
    "cascet": {
      "priceUsd": "$0.02",   // human-readable list price; omitted ⇒ free
      "network": "casper:casper-test"  // CAIP-2 chain the payment settles on
    }
  }
}
```

- `priceUsd` is a display price. The **authoritative** amount (asset units) is in
  the x402 challenge (Layer 2) and the Bazaar catalog (Layer 4).
- A tool with no `_meta.cascet.priceUsd` is free.
- Prices are per successful call. A tool that fails upstream MUST NOT be charged.

This one field is what makes agents *economically autonomous*: they can rank
tools by price and stay within a budget **before** spending anything.

## Layer 2 — Payment (`tools/call`)

`tools/call` on a payable tool follows the standard x402 handshake, unchanged:

1. Buyer sends `tools/call`. Gateway replies `402` with a `PAYMENT-REQUIRED`
   challenge (scheme `exact`, an `amount` in CEP-18 asset units, `payTo`,
   `network`).
2. Buyer signs an [EIP-3009-style](https://eips.ethereum.org/EIPS/eip-3009)
   `transfer_with_authorization` (via `casper-eip-712`) and retries with
   `PAYMENT-SIGNATURE`.
3. Gateway settles through the x402 facilitator, runs the upstream tool, and
   returns the MCP result.

On success the gateway MUST return the response header:

```
x-cascet-payment-id: <uuid>
```

`payTo` MUST be the payee's serialized **account-hash Key** (`00` + 32-byte
hash), not a public key — the authorization signs `to` as this 33-byte value and
the on-chain digest is computed over it. (Passing a public key verifies
structurally but fails settlement; this is the single most common integration
bug.)

## Layer 3 — Cascade attribution

When a paid tool, while serving a call, buys from a downstream paid tool, the
downstream buyer (the gateway acting as a client) MUST forward:

```
x-cascet-parent-id: <payment id of the inbound call it is serving>
```

The downstream gateway records that `parentId` on the child receipt. The result
is a tree: one root payment id, N children each pointing at their parent. Any
observer can reconstruct the full economic graph of a single agent request —
who got paid, for what, and on whose behalf.

```
agent ──pay──▶ analyze_portfolio            (root: id=R)
                   ├─ pay──▶ get_cspr_market_data   (parentId=R)
                   ├─ pay──▶ get_rwa_price           (parentId=R)
                   └─ pay──▶ get_defi_yields         (parentId=R)
```

### Optional: budget-bounded cascades (on-chain enforcement)

Header-based attribution is trust-minimized but off-chain. For hard guarantees,
a cascade MAY be opened against an on-chain **budget controller** (CasCet's
`CascadeController`): the buyer deposits **one budget that caps the entire
tree**, the controller pays each hop out of it and *rejects* any hop that would
exceed the budget, and a configurable share of each child hop's earnings flows
back up to its parent hop's payee (recursive attribution). This makes "an agent
cannot overspend across a whole call tree" true *by construction*, not by
trusting the gateway.

## Layer 4 — Discovery (x402 Bazaar)

A gateway SHOULD expose a [Bazaar](https://www.x402.org)-compatible catalog at
both `/.well-known/x402.json` and `/discovery/resources`, so an agent can find
paid MCP tools the same way it finds paid HTTP APIs. Each catalog item carries
the authoritative `accepts` block (scheme, network, amount, asset, `payTo`) plus
`metadata.protocol: "mcp"`, the `mcpEndpoint`, and the `tool` name.

## Conformance

An implementation is **conformant** if it:

- advertises `_meta.cascet.priceUsd` on every payable tool in `tools/list`; and
- settles `tools/call` via the standard x402 `exact` scheme; and
- returns `x-cascet-payment-id` on settled calls; and
- forwards `x-cascet-parent-id` when it buys downstream while serving a call.

Layers 3 (budget enforcement) and 4 (Bazaar discovery) are RECOMMENDED but not
required for basic interoperability.

## Reference implementation

CasCet (this repository) implements all four layers:

- Header constants: [`packages/core/src/constants.ts`](../packages/core/src/constants.ts)
- Price advertisement + payment + parent-linking: [`packages/gateway/src/server.ts`](../packages/gateway/src/server.ts)
- Bazaar discovery: [`packages/gateway/src/discovery.ts`](../packages/gateway/src/discovery.ts)
- On-chain budget controller: [`contracts/src/cascade_controller.rs`](../contracts/src/cascade_controller.rs)
- Autonomous buyer (prices, budgets, and buys tools via this convention):
  [`packages/agent/src/agent.ts`](../packages/agent/src/agent.ts)

## Open questions

- **Dynamic pricing.** `priceUsd` is a list price; per-request quotes (size- or
  load-based) currently surface only in the 402 challenge. A `pricing` hint
  object in `_meta.cascet` could advertise the pricing *model*.
- **Refunds / partial results.** This draft charges per successful call only;
  streaming or partial-result tools may want metered settlement (cf. per-second
  channels).
- **Cross-chain settlement.** `network` is CAIP-2 today; a tool priced on one
  chain but paid on another would need a settlement-routing hint.

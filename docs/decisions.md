# CasCet — Decision Log

> Short-form architecture & product decisions. Newest at the bottom.
> Project: Casper Agentic Buildathon 2026 (Qualification → Final Round).

---

## D-001 · Product: paid-MCP gateway, not another x402 API wrapper

**Date:** 2026-07-07 · **Status:** accepted

**Decision:** CasCet is a monetization layer for MCP servers on Casper: wrap any MCP
server, price its tools per call, collect x402 (HTTP 402) micropayments in CEP-18
tokens, and give sellers a revenue dashboard with on-chain receipts.

**Why:**
- ~150 competing BUIDLs were reviewed. "x402 for HTTP APIs" is saturated
  (AgentGate, AgentPay ×3, Castai…); the *seller side of MCP* is untouched —
  MidOS covers only the buyer side (agent wallet).
- Agents consume tools through MCP in practice, not raw HTTP. Monetizing the MCP
  layer is where the real agent economy lives.
- Demand is proven globally (MCPay, xpay.sh, Cloudflare Monetization Gateway;
  x402 ≈ $50M settled volume by Apr 2026). We are **not** claiming invention of
  the category — see D-003 for the honest positioning.

**Rejected alternatives:** agent allowance wallet (Caspilot/Cinder/Aegis crowd it),
per-second metering (Sluice shipped it live), pay-per-inference marketplace (Sella).

## D-002 · Flagship differentiator: cascading (multi-hop) payments

**Date:** 2026-07-07 · **Status:** accepted

**Decision:** CasCet supports payment chains: a paid tool that internally consumes
other paid tools composes the downstream x402 payments automatically. Revenue
splits are enforced by an Odra smart contract on Casper Testnet; the full payment
graph is visible live in the dashboard.

**Why:**
- Every existing product (incl. MCPay) is point-to-point. Multi-hop composition
  with on-chain split enforcement is described in ecosystem blogs as a vision but
  not shipped anywhere we could find (verified 2026-07-07).
- Casper's instant deterministic finality (Zug) is a genuine technical fit: a
  3-hop chain over probabilistic-finality chains would stall; on Casper each hop
  settles in seconds with certainty.
- Judging criteria reward exactly this combo: working smart contracts (own Odra
  contract is a scored line item), innovation, agentic AI use, ecosystem impact.

## D-003 · Positioning: "first on Casper + first shipped multi-hop", never "world-first paid MCP"

**Date:** 2026-07-07 · **Status:** accepted

**Decision:** All public copy (README, demo video, pitch) uses this claim shape:
*"Paid MCP is a proven pattern; Casper launched x402 in June 2026 and has no
monetization layer yet. CasCet brings it first — and ships the first composable
multi-hop payment chains with on-chain revenue splits."*

**Why:** MCPay et al. are public and well known; an unqualified "we invented paid
MCP" claim would cost credibility with any informed judge. The qualified claim is
true, verifiable, and still strong.

## D-004 · DeFi/RWA alignment via the flagship demo server

**Date:** 2026-07-07 · **Status:** accepted

**Decision:** CasCet ships with a first-party paid MCP server selling Casper
DeFi/RWA data (CSPR market data, staking yields, RWA price feeds). It is both the
demo vehicle and the proof that the gateway serves the buildathon's stated focus
("especially DeFi & RWA contexts"). The cascade demo runs through it: a paid
analysis tool buys from the paid data tools underneath.

## D-005 · Stack

**Date:** 2026-07-07 · **Status:** accepted

- **Monorepo:** pnpm workspaces. TypeScript everywhere JS runs; Rust for contracts.
- **Packages:** `gateway` (seller proxy), `client` (buyer-side signer/wallet),
  `cli` (`npx @cascet/cli wrap`), `servers/casper-defi-data` (flagship paid MCP),
  `apps/dashboard` (Next.js), `contracts/` (Odra: RevenueSplit + ReceiptRegistry).
- **Payments:** `@make-software/casper-x402` + hosted facilitator
  (`x402-facilitator.cspr.cloud`, testnet) — we build *on* the official rails, we
  don't reimplement verification/settlement.
- **Network:** Casper Testnet (`casper:casper-test`), CEP-18 payment token,
  casper-eip-712 typed-data signatures.
- **Originality rule:** buildathon requires all code newly written for the event —
  external code enters only as declared package dependencies, never copied in.

# CasCet — Final Round Plan (Jul 21 → 26, 2026)

Casper Agentic Buildathon 2026 · qualified for the final round · deadline **Jul 26**.
Solo (Meriç). This is the working plan for the last 5 days. Newest status at the
bottom of each workstream.

## Where we start (already shipped in qualification)

7 contracts live on Casper Testnet · real x402 settlement (no mock) · the
`CascadeController` primitive (budget tree + recursive attribution) · an autonomous
LLM buyer (`@cascet/agent`, simulated reasoning by default) · live dashboard +
cascade playground + x402 explorer · a proposed x402-MCP spec · CI/CodeQL/Dependabot
+ community-health files · live socials (X + Discord).

## Locked decisions (Jul 21)

- **Network:** stay on **testnet** for the final round; mainnet is deferred (needs
  real CSPR + its own gate).
- **Deployer balance:** ~2,493 CSPR on testnet — sufficient for all planned on-chain
  work (gas-light: `release()` / anchors ~5 CSPR each; no new deploys required).
- **W4 control plane:** ship the **safe config-generator wizard**, not a hosted
  runtime gateway (too risky in 5 days). Copy stays honest: hosted runtime = roadmap.
- **W5 Discord:** Meriç owns it (automated via `tools/discord`); out of the agent's
  scope.
- **W1 real agent:** gated on Meriç adding **$5 Anthropic API credit** (API billing
  is separate from the Claude Code Max/Pro plan). His call.
- **Workflow:** commit/push/deploy freely once verified green (no per-step ask);
  `npm publish` still gets an explicit name/go confirmation (irreversible public act).

## Workstreams (ranked by leverage)

| # | Item | Criteria hit | Effort | Blocker |
|---|---|---|---|---|
| W1 | Real Claude agent (flip simulation → live) | agentic AI | low* | $5 API credit (Meriç) |
| W2 | `npx cascet` published to npm | technical execution + long-term | med | `npm login` (Meriç) |
| W3 | RevenueSplit withdraw UI + CSPR.click wallet | working contracts + UX | med | — (approved) |
| W4 | Control-plane wizard (config generator) | real-world + long-term | med | — (approved) |
| W6 | Demo video refresh | UX / communication | med | W1/W3 done |
| W7 | On-chain-backed explorer (ReceiptRegistry indexer) | ecosystem impact | med | — (stretch) |
| W8 | BUIDL page + submission update, final QA | all | low | continuous |

\* W1 code is proven (`CASCET_AGENT_LIVE=1`); only the credit is missing.

(W5 = Discord is Meriç's, tracked in `docs/discord-mcp-handoff.md` + `tools/discord`.)

## Day-by-day

- **Day 1 · Jul 21 (done/in progress):** fixed 3 doc/UI inconsistencies (test count
  13/13, 7 contracts on landing, socials wired live) + deployed. Start W2 packaging.
- **Day 2 · Jul 22:** finish W2 (publish + verify `npx cascet@latest`); run + record
  W1 if credit is added.
- **Day 3 · Jul 23:** W3 — withdraw UI + CSPR.click wallet connect; verify `release`
  on testnet; deploy.
- **Day 4 · Jul 24:** W4 — control-plane wizard page (config generator + commands +
  live preview); deploy.
- **Day 5 · Jul 25:** W6 — demo video refresh; W8 — BUIDL page + submission update,
  full QA (`pnpm build/typecheck`, `cargo odra test`, e2e all green), final deploy.
  Stretch: W7.
- **Day 6 · Jul 26 (deadline, buffer):** DoraHacks BUIDL + video + socials final;
  contingency for anything that slipped.

## Definition of done (per item)

Build/test green → commit → push → (if UI/site) deploy → verify live. Contract
changes run `cargo odra test`; frontend runs `typecheck` + `next build`; end-to-end
flows run `pnpm --filter @cascet/e2e demo`.

## Verification snapshot (Jul 21)

`pnpm build` ✓ · `pnpm typecheck` 9/9 ✓ · `cargo odra test` **13/13** ✓ ·
dashboard prod build 10/10 ✓ · live site https://cascet.vercel.app 200 ✓.

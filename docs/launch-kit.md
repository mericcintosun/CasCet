# CasCet — launch & social kit

Everything Meriç needs to put CasCet's socials "in place" (a scored Buildathon
criterion). Create the accounts with the handles below, paste the copy, wire the
final URLs into `apps/dashboard/app/page.tsx` (the `SOCIALS` object) and the
README badges.

## Proposed handles

Pick the first that's free; keep the handle identical across platforms for brand
consistency.

| Platform | Handle (1st choice) | Fallbacks | URL to wire in |
|---|---|---|---|
| X (Twitter) | `@cascet_xyz` | `@cascet_dev`, `@getcascet`, `@cascetHQ` | `https://x.com/<handle>` |
| Telegram | `t.me/cascet` | `t.me/cascet_xyz`, `t.me/cascetHQ` | channel or group invite |
| Discord | `discord.gg/cascet` | any invite code | permanent invite link |
| GitHub | `mericcintosun/CasCet` | — | already live |

> After creating them, replace the placeholders in `SOCIALS` (site footer + CTA
> already render them) and the README. The site currently points at the 1st-choice
> handles above.

## Brand basics (already in `apps/dashboard/public/`)

- **Logo / avatar:** `logo.png` (1024×1024) — use as the profile picture on all platforms.
- **Banner / OG:** `og.png` (1200×630) — use as the X header and link-preview image.
- **Accent:** acid-lime `#C6F94E` · **Secondary:** teal `#2DE0C0` · **BG:** near-black `#0B0D12`.
- **Voice:** technical, precise, a little irreverent. Lowercase-friendly. Mono for code/numbers.

## X (Twitter)

**Bio (160 chars):**
> Stripe for MCP on Casper. Charge AI agents per tool call over x402 — and settle the multi-hop payment chains nobody else does. Payments that cascade. ⛓️

**Location:** `Casper Testnet` · **Link:** the deployed site URL.

**Pinned launch thread:**

1/ AI agents reach the world through MCP tools. Thousands of them. Almost all free — because nobody could charge an autonomous agent per call.

We built CasCet: the monetization layer for MCP on Casper. 🧵

2/ x402 (HTTP 402) fixed paying for one request. But every x402 tool is a point-to-point vending machine.

Real agent work composes: a "portfolio analysis" tool internally buys a price feed and an RWA feed — each a paid service. Nobody was settling those payment *chains*.

3/ CasCet does three things:
• wrap any MCP server → priced per tool over x402
• connect any agent → pays under a budget
• cascade → multi-hop payments, linked parent→child, settled on Casper

4/ The headline is a new primitive: budget-bounded cascades.

An agent opens a cascade with ONE deposit that caps the whole call tree. Our CascadeController contract pays each hop out of it and rejects any hop that would overspend — enforcement by construction, on-chain.

5/ Plus recursive attribution: a share of a child hop's earnings flows *up* to the parent's payee. The payment graph IS the revenue-sharing graph.

Verified end-to-end on testnet — including an over-budget hop rejected on-chain.

6/ And it's autonomous: Claude reads the paid tools' prices, decides what to buy for a DeFi/RWA goal, pays x402 per call under budget, and cites the data it bought.

7/ 7 contracts live on Casper Testnet. Real x402 settlement, no mock. Live dashboard + an interactive cascade playground.

Built for the Casper Agentic Buildathon 2026.

Code 👉 github.com/mericcintosun/CasCet
Try it 👉 <site url>

**A few standalone posts to schedule:**
- "an over-budget payment, rejected *on-chain* by the contract, not by trusting a gateway 👇" + the playground `BudgetExceeded` clip.
- "watch an AI agent price paid tools, buy only what it needs, and pay per call under a budget:" + the agent demo clip.
- "the cascade playground is live — drag the sliders, watch recursive attribution flow up the tree:" + link.

## Telegram (channel/group)

**Name:** CasCet
**Description:**
> CasCet — the monetization layer for MCP on Casper. Per-tool x402 micropayments with composable, budget-bounded agent-to-agent payment chains. Payments that cascade.
> GitHub: github.com/mericcintosun/CasCet

**Pinned message:** the site URL + the one-line pitch + "questions welcome."

## Discord

**Server name:** CasCet
**Suggested channels:** `#announcements`, `#general`, `#dev`, `#showcase`.
**Welcome / #announcements first message:**
> Welcome to CasCet — Stripe for MCP on Casper, with cascading agent-to-agent payments settled on-chain. Repo: github.com/mericcintosun/CasCet · Site: <url>. Say hi in #general.

## Wiring the real URLs (after accounts exist)

1. `apps/dashboard/app/page.tsx` → update the `SOCIALS` object (footer + CTA use it).
2. `README.md` → the socials line under the title.
3. `docs/submission.md` → list the live social links for the judges.

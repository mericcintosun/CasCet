# Discord — server setup (automated) + MCP handoff reference

**Purpose:** configure the CasCet Discord server (channels, roles, welcome,
onboarding, announcements) so it looks professional and populated — socials are a
scored Buildathon criterion, so a real server matters, not just an invite link.

> **Status — automated.** The full configuration now ships as a one-command,
> idempotent script in [`tools/discord`](../tools/discord). Create a bot, drop the
> token + server ID in `tools/discord/.env`, and run
> `pnpm --filter @cascet/discord-setup setup`. It builds everything below and can
> be re-run safely. The Discord-MCP path (bottom of this doc) is kept as an
> alternative; you do not need it — the script gets the same result with no extra
> moving parts.

## Current state (already done)

- **Discord server exists.** Name: **CasCet**. Public invite:
  **<https://discord.gg/fcjevk47k>** (live).
- The invite is already **wired into the product** and docs — keep these in sync
  if the invite ever changes:
  - `apps/dashboard/app/page.tsx` → the `SOCIALS` object (rendered in the landing
    footer + final CTA).
  - `README.md` → the socials line under the title, and the "Socials & launch"
    line in the Roadmap section.
  - `docs/launch-kit.md` → the handles table + Discord copy.
- **Live socials:** X `@cascet_xyz` (<https://x.com/cascet_xyz>), Discord (above),
  GitHub `mericcintosun/CasCet`. **Telegram is not planned** — do not add one.

## The finalized design (what the script builds)

Run `tools/discord` (see its [README](../tools/discord/README.md)) — it applies
all of this idempotently. Kept here as the canonical spec so anyone can rebuild it
by hand if needed.

**Roles** (top → bottom): **Core Team** (acid-lime, admin, hoisted) · **Contributor**
(teal, hoisted) · **Builder** (lime, hoisted) · self-assign topic roles **x402** /
**MCP** / **Casper / Odra** / **DeFi / RWA** (picked in onboarding).

**Channels** (`#announcements`, `#roadmap`, `#welcome`, `#git-feed` are read-only
for @everyone):

- **INFORMATION** — `#welcome` (rules + links) · `#announcements` (news) · `#roadmap`
- **COMMUNITY** — `#general` · `#introductions` · `#showcase` · `#off-topic`
- **BUILD** — `#dev` · `#x402-and-mcp` · `#contracts` · `#support` · `#feedback`
- **GITHUB** — `#git-feed` (webhook target for commits/PRs/releases)
- **VOICE** — `Community` · `Pair Programming`

**Content, applied automatically:**

1. **Server icon** from `apps/dashboard/public/logo.png`.
2. **Pinned welcome + rules** embed in `#welcome`.
3. **Pinned launch announcement** in `#announcements`:
   > Welcome to CasCet — Stripe for MCP on Casper, with cascading agent-to-agent
   > payments settled on-chain. Repo: github.com/mericcintosun/CasCet · Site:
   > https://cascet.vercel.app. Say hi in #general.
4. **Pinned roadmap** embed in `#roadmap`; **pitch pin** in `#general`.
5. **Welcome screen** + **two onboarding prompts** ("What brings you to CasCet?" →
   Builder/Contributor role; "What are you into?" → topic roles).
6. **Scheduled event** "CasCet Demo Day" (external, links to the site).
7. **`#git-feed` webhook** — the script prints the URL; paste it into GitHub →
   Settings → Webhooks with `/github` appended.

**Brand:** accent acid-lime `#C6F94E`, teal `#2DE0C0`, near-black `#0B0D12`
(see `launch-kit.md` → "Brand basics"). Banner (`apps/dashboard/public/og.png`)
needs Level-2 Boosts, so upload it manually once boosted.

Keep everything consistent with `docs/launch-kit.md` (canonical copy, bio, pinned
text). If the invite link changes, update `apps/dashboard/app/page.tsx`
(`SOCIALS`), `README.md`, and `docs/launch-kit.md`, then re-run
`pnpm --filter @cascet/dashboard build`.

## Connecting a Discord MCP server

You need a **Discord bot token** (Discord Developer Portal → New Application →
Bot → copy token) and the bot invited to the CasCet server with the right
permissions (Manage Channels, Manage Roles, Send Messages, Manage Messages, etc.).
Then point Claude at a Discord MCP server over STDIO or HTTP.

### Reference — Discord MCP capabilities

Discord MCP servers let an MCP client (Claude Desktop, Claude Code, Cursor, VS
Code) drive Discord: read/send/edit/delete messages, create & configure channels,
manage roles, moderate, run events, handle reactions/threads, and full server
administration via slash commands and DMs.

**Available implementations:**

1. **hanweg/mcp-discord** — list servers + server info, get channels, send/read
   messages, add reactions, moderate messages, create channels, manage roles.
2. **SaseQ/discord-mcp** — Discord API (JDA) integration, Claude Desktop
   compatible.
3. **glittercowboy/discord-mcp** — 128 operations (messages, moderation,
   channels, roles, events) for comprehensive community management.
4. **Mastra AI Discord Bot** — slash-command assistance, DMs, threads, message
   chunking for long responses.

**Deployment:** `npx discord-mcp-server`, `docker run discord-mcp-server`, or
local (`git clone && npm install && npm start`). Transports: STDIO or HTTP.

**Core capabilities (relevant here):**

- **Messages:** send text/embeds, upload attachments, edit, delete, pin/unpin,
  react, quote.
- **Channels:** create text/voice/forum, set permissions, slow mode, topics,
  archive/unarchive.
- **Roles:** create, assign/remove, set permissions/colors, hierarchy.
- **Moderation:** ban/kick/timeout, delete + bulk-delete messages, audit logs.
- **Events:** create/modify/delete scheduled events, manage RSVPs.
- **Threads:** create from a message, manage participants, archive, permissions.
- **Embeds:** title/description, custom colors, fields, images/thumbnails,
  footer, timestamp, author.
- **Webhooks:** external notifications, per-message avatar/username overrides.

**Auth & limits:** bot-token auth (OAuth2 for user-scoped actions), permission
verification, global rate limit ~50 req/s with per-route bucket limiting and
automatic backoff. Messages cap at 2000 chars — long output is chunked at
newlines (or threaded). Must comply with Discord ToS, Community Guidelines, and
the bot verification process.

**Compatible MCP clients:** Claude Desktop, Claude Code, Cursor, VS Code + Copilot,
Continue, custom MCP implementations.

**Pricing:** free — Discord API access is free within rate limits (Nitro / Server
Boosting are optional paid extras).

**Natural-language examples:** "Create a channel called #dev", "Post the welcome
message in #announcements", "Create a Builder role", "Pin the site link in
#general", "Schedule a demo-day event for Jul 26".

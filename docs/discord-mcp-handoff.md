# Discord MCP — handoff for the next agent

**Purpose:** hand the CasCet Discord server to the next agent so it can be
configured (channels, roles, welcome + announcement content) through a **Discord
MCP server** connected to Claude. Socials are a scored Buildathon criterion, so a
real, populated server matters — not just an invite link.

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

## What the next agent should do

Connect a Discord MCP server and configure the CasCet server. Concretely:

1. **Create channels** (from `docs/launch-kit.md`): `#announcements`, `#general`,
   `#dev`, `#showcase`. Set `#announcements` to read-only for @everyone.
2. **Post the welcome / first announcement** in `#announcements` (copy in
   `launch-kit.md` → "Discord"):
   > Welcome to CasCet — Stripe for MCP on Casper, with cascading agent-to-agent
   > payments settled on-chain. Repo: github.com/mericcintosun/CasCet · Site:
   > https://cascet.vercel.app. Say hi in #general.
3. **Set the server description / brand.** Avatar = `apps/dashboard/public/logo.png`,
   banner = `apps/dashboard/public/og.png`; accent acid-lime `#C6F94E`, teal
   `#2DE0C0`, near-black `#0B0D12` (see `launch-kit.md` → "Brand basics").
4. **(Optional) Roles:** a `Builder`/`Contributor` role and a bot/automation role
   if the MCP integration needs elevated permissions.
5. **(Optional) Pin** the site URL + one-line pitch in `#general`.

Keep everything consistent with `docs/launch-kit.md` (it holds the canonical copy,
bio, and pinned-thread text). If the invite link changes, update the three
wiring locations listed above and re-run `pnpm --filter @cascet/dashboard build`.

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

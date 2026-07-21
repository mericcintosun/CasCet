# CasCet Discord — one-command server setup

Turns the CasCet Discord server into a finished, professional community: roles,
categories + channels (with topics and read-only permissions), a welcome screen,
onboarding prompts, pinned welcome/rules/announcement/roadmap embeds, a
`#git-feed` webhook, and a "CasCet Demo Day" scheduled event.

The script is **idempotent** — run it as many times as you want. It finds every
role/channel/message/event by name and only creates what's missing.

> Why a script and not a Discord MCP server? Same result, no extra moving parts —
> `discord.js` + a bot token is all it needs, and it re-runs cleanly. If you
> prefer an MCP-driven flow, the capability reference is in
> [`docs/discord-mcp-handoff.md`](../../docs/discord-mcp-handoff.md).

## 1. Create a bot (2 min)

1. <https://discord.com/developers/applications> → **New Application** → name it `CasCet`.
2. **Bot** (left nav) → **Reset Token** → copy it. This is `DISCORD_BOT_TOKEN`.
   - No privileged intents are required — leave them off.
3. Copy the **Application ID** (General Information → Application ID).

## 2. Invite the bot to the server

Open this URL, replacing `APPLICATION_ID`, and pick the **CasCet** server.
Administrator keeps the invite simple (the bot is yours):

```
https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&scope=bot&permissions=8
```

Granular alternative (no Administrator): `permissions=9395252272` covers Manage
Server, Roles, Channels, Webhooks, Events, Send/Manage Messages, View Channels.

## 3. Get the server ID

Discord → **User Settings → Advanced → Developer Mode ON**. Right-click the
CasCet server icon → **Copy Server ID**. This is `GUILD_ID`.

## 4. Run it

```bash
cp tools/discord/.env.sample tools/discord/.env
# edit .env: paste DISCORD_BOT_TOKEN and GUILD_ID

pnpm install                                   # once, to pull discord.js
pnpm --filter @cascet/discord-setup setup:dry  # preview — writes nothing
pnpm --filter @cascet/discord-setup setup      # apply
```

`.env` is gitignored — the token never leaves your machine.

## What it builds

- **Roles:** Core Team (acid-lime, admin), Contributor (teal), Builder, plus
  self-assign topic roles `x402` / `MCP` / `Casper / Odra` / `DeFi / RWA`.
- **Channels:**
  - **INFORMATION** (read-only): `#welcome` · `#announcements` (news) · `#roadmap`
  - **COMMUNITY:** `#general` · `#introductions` · `#showcase` · `#off-topic`
  - **BUILD:** `#dev` · `#x402-and-mcp` · `#contracts` · `#support` · `#feedback`
  - **GITHUB** (read-only): `#git-feed` (+ a webhook URL you paste into GitHub)
  - **VOICE:** `Community` · `Pair Programming`
- **Pinned embeds:** welcome + rules (`#welcome`), launch announcement
  (`#announcements`), roadmap (`#roadmap`), a pitch pin (`#general`).
- **Community features:** enables Community, sets the welcome screen, and adds two
  onboarding prompts ("What brings you to CasCet?" → role; "What are you into?" →
  topic roles). If Discord blocks auto-enabling Community, the script tells you to
  flip it once in Server Settings and re-run.
- **Event:** "CasCet Demo Day" (external, links to the site). Override the date
  with `DEMO_DAY_ISO` in `.env`.

## After running

- **GitHub feed:** the script prints a webhook URL for `#git-feed`. In GitHub →
  repo **Settings → Webhooks → Add webhook**, paste it with `/github` appended,
  content type `application/json`, choose pushes + PRs + releases.
- **Server banner:** needs Level 2 Boosts (can't be set by API without them).
  Upload `apps/dashboard/public/og.png` in Server Settings once boosted.
- If the invite link ever changes, update `apps/dashboard/app/page.tsx`
  (`SOCIALS`), `README.md`, and `docs/launch-kit.md`, then rebuild the dashboard.

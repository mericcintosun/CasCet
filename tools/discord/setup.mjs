/**
 * CasCet Discord — one-command server setup.
 *
 * Idempotent: run it as many times as you like. It looks up every role,
 * category, channel, pinned message and event by name and only creates what's
 * missing, so re-running never duplicates anything.
 *
 * Usage:
 *   cp .env.sample .env   # fill DISCORD_BOT_TOKEN + GUILD_ID
 *   pnpm --filter @cascet/discord-setup setup
 *   # or a no-write preview:
 *   pnpm --filter @cascet/discord-setup setup:dry
 *
 * The bot must already be in the server with Administrator (or: Manage Server,
 * Manage Roles, Manage Channels, Manage Webhooks, Manage Events, Send Messages,
 * Manage Messages, View Channels). See README.md for the invite link.
 */
import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildOnboardingPromptType,
  GuildOnboardingMode,
  GuildVerificationLevel,
  GuildDefaultMessageNotifications,
  GuildExplicitContentFilter,
} from 'discord.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DRY = process.env.DRY_RUN === '1';

// ---------------------------------------------------------------------------
// Brand + links (kept in sync with docs/launch-kit.md and the product footer).
// ---------------------------------------------------------------------------
const BRAND = {
  lime: 0xc6f94e, // acid-lime accent
  teal: 0x2de0c0, // cascade / flow
  builder: 0x9be36b,
  ink: 0x0b0d12,
  muted: 0x8b93a7,
};
const LINKS = {
  site: 'https://cascet.vercel.app',
  repo: 'https://github.com/mericcintosun/CasCet',
  x: 'https://x.com/cascet_xyz',
  spec: 'https://github.com/mericcintosun/CasCet/blob/main/docs/x402-mcp-spec.md',
};
const PITCH =
  'Stripe for MCP on Casper — per-tool x402 micropayments with cascading, ' +
  'budget-bounded agent-to-agent payment chains, settled on-chain.';

// ---------------------------------------------------------------------------
// Roles (created top-first so hierarchy reads Core Team > Contributor > Builder
// > topic roles > @everyone). `hoist` shows the role as its own sidebar group.
// ---------------------------------------------------------------------------
const ROLES = [
  { key: 'core', name: 'Core Team', color: BRAND.lime, hoist: true, mentionable: false, admin: true },
  { key: 'contributor', name: 'Contributor', color: BRAND.teal, hoist: true, mentionable: true },
  { key: 'builder', name: 'Builder', color: BRAND.builder, hoist: true, mentionable: true },
  // self-assign topic roles (picked in onboarding), no sidebar group
  { key: 'topic_x402', name: 'x402', color: BRAND.muted, hoist: false, mentionable: true },
  { key: 'topic_mcp', name: 'MCP', color: BRAND.muted, hoist: false, mentionable: true },
  { key: 'topic_casper', name: 'Casper / Odra', color: BRAND.muted, hoist: false, mentionable: true },
  { key: 'topic_defi', name: 'DeFi / RWA', color: BRAND.muted, hoist: false, mentionable: true },
];

// ---------------------------------------------------------------------------
// Channel tree. `ro: true` = read-only for @everyone (Core Team can still post).
// `type` defaults to text; 'voice' and 'news' supported. Topics show under names.
// ---------------------------------------------------------------------------
const TREE = [
  {
    category: 'INFORMATION',
    ro: true,
    channels: [
      { name: 'welcome', topic: 'Start here. What CasCet is, the rules, and the links that matter.', ro: true },
      { name: 'announcements', topic: 'Official CasCet updates — ships, releases, milestones.', ro: true },
      { name: 'roadmap', topic: 'Where CasCet is headed. Updated each phase.', ro: true },
    ],
  },
  {
    category: 'COMMUNITY',
    channels: [
      { name: 'general', topic: 'Main channel. Talk CasCet, x402, MCP and agent payments.' },
      { name: 'introductions', topic: 'New here? Say hi 👋 — who you are and what you build.' },
      { name: 'showcase', topic: 'Built something with CasCet or x402? Show it off.' },
      { name: 'off-topic', topic: 'Everything that is not CasCet.' },
    ],
  },
  {
    category: 'BUILD',
    channels: [
      { name: 'dev', topic: 'Integrating the gateway, running the demos, contributing. Technical chat.' },
      { name: 'x402-and-mcp', topic: 'The paid-MCP-over-x402 spec. Pricing, settlement, cascade attribution.' },
      { name: 'contracts', topic: 'Casper, Odra, the on-chain layer — ReceiptRegistry / CascadeController / …' },
      { name: 'support', topic: 'Stuck? Ask here. Include repro steps, versions and logs.' },
      { name: 'feedback', topic: 'Feature requests and bugs. For tracked work, open a GitHub issue.' },
    ],
  },
  {
    category: 'GITHUB',
    ro: true,
    channels: [
      { name: 'git-feed', topic: 'Commits, PRs and releases. Wire the printed webhook to GitHub.', ro: true, webhook: 'CasCet · GitHub' },
    ],
  },
  {
    category: 'VOICE',
    channels: [
      { name: 'Community', type: 'voice' },
      { name: 'Pair Programming', type: 'voice' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Pinned content. One embed per channel, marked by footer so re-runs skip it.
// ---------------------------------------------------------------------------
const rulesEmbed = {
  color: BRAND.lime,
  title: 'Welcome to CasCet',
  description:
    `${PITCH}\n\n` +
    'We are building **payments that cascade** — the monetization layer for MCP ' +
    'on Casper, plus the first composable multi-hop agent-to-agent payment chains.',
  fields: [
    {
      name: 'Guidelines',
      value:
        '**1.** Be decent. No harassment, hate or spam.\n' +
        '**2.** Keep it on-topic per channel; take tangents to <#off-topic>.\n' +
        '**3.** No shilling, airdrops or unsolicited DMs. CasCet is testnet — we will never DM you for keys or funds.\n' +
        '**4.** Search before asking; share repro steps + logs in <#support>.\n' +
        '**5.** English in the shared channels so everyone can follow.',
    },
    {
      name: 'Start here',
      value:
        `• Introduce yourself in <#introductions>\n` +
        `• Pick your interests in **Channels & Roles** (onboarding)\n` +
        `• Read the spec: [x402-MCP](${LINKS.spec})`,
    },
    {
      name: 'Links',
      value: `[Site](${LINKS.site}) · [GitHub](${LINKS.repo}) · [X / @cascet_xyz](${LINKS.x})`,
    },
  ],
  footer: { text: 'cascet-setup:rules' },
};

const announcementEmbed = {
  color: BRAND.teal,
  title: 'CasCet is live 🚀',
  description:
    `${PITCH}\n\n` +
    'x402 fixed paying for one request. But every x402 tool is a point-to-point ' +
    'vending machine. Real agent work **composes** — a portfolio tool buys a price ' +
    'feed and an RWA feed, each itself a paid service. CasCet settles those chains.',
  fields: [
    {
      name: 'What is shipped',
      value:
        '• 7 contracts live on Casper Testnet\n' +
        '• Real x402 settlement — no mock\n' +
        '• `CascadeController`: one deposit caps a whole call tree, over-budget hops rejected on-chain, recursive revenue attribution up the tree\n' +
        '• An autonomous LLM buyer + a live dashboard and cascade playground',
    },
    { name: 'Try it', value: `[Live site](${LINKS.site}) · [Repo](${LINKS.repo})` },
  ],
  footer: { text: 'cascet-setup:announcement' },
};

const roadmapEmbed = {
  color: BRAND.lime,
  title: 'CasCet roadmap',
  description: 'A real project, not a hackathon throwaway. Where we are and where we are going.',
  fields: [
    { name: '✅ Shipped · Qualification (Jul 2026)', value: '7 Odra contracts on testnet · real x402 settlement · the CascadeController primitive · an autonomous LLM buyer · live dashboard + cascade playground + the x402-MCP spec.' },
    { name: '🛠 Final round (Jul 13–26)', value: 'Hosted control plane (register a server → paid endpoint + dashboard in one step) · `npx cascet` on npm · a RevenueSplit withdraw UI · take the spec to the x402 / MCP ecosystem.' },
    { name: '📡 Q4 2026 — mainnet & monetization', value: 'Mainnet launch · a protocol take-rate on settled volume · per-second / streaming price schemes · stable JS/Rust/Python SDKs + a public metrics API.' },
    { name: '🌐 2027 — the agent-economy layer', value: 'Pricing-discovery API + a Bazaar marketplace of paid MCP tools · on-chain reputation · cross-chain settlement.' },
  ],
  footer: { text: 'cascet-setup:roadmap' },
};

const generalEmbed = {
  color: BRAND.teal,
  title: 'gm — welcome to CasCet',
  description:
    `${PITCH}\n\n` +
    `Say hi in <#introductions>, show your work in <#showcase>, and ask anything in <#support>.\n\n` +
    `[Site](${LINKS.site}) · [GitHub](${LINKS.repo}) · [X](${LINKS.x})`,
  footer: { text: 'cascet-setup:general-pin' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const log = (...a) => console.log(...a);
const step = (m) => log(`\n\x1b[1m${m}\x1b[0m`);
const ok = (m) => log(`  \x1b[32m✓\x1b[0m ${m}`);
const skip = (m) => log(`  \x1b[90m•\x1b[0m ${m} (already there)`);
const warn = (m) => log(`  \x1b[33m!\x1b[0m ${m}`);

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`\x1b[31mMissing ${name}.\x1b[0m Copy .env.sample to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

const TOKEN = requireEnv('DISCORD_BOT_TOKEN');
const GUILD_ID = requireEnv('GUILD_ID');
const DEMO_DAY_ISO = process.env.DEMO_DAY_ISO || '2026-07-26T16:00:00.000Z';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function main() {
  await client.login(TOKEN);
  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.channels.fetch();
  await guild.roles.fetch();

  const me = await guild.members.fetchMe();
  step(`CasCet Discord setup — ${guild.name}`);
  log(`  bot: ${client.user.tag}   admin: ${me.permissions.has(PermissionFlagsBits.Administrator) ? 'yes' : 'no'}   ${DRY ? '\x1b[33m[DRY RUN]\x1b[0m' : ''}`);
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels) || !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    warn('Bot is missing Manage Channels / Manage Roles — re-invite it with Administrator (see README).');
  }

  const everyone = guild.roles.everyone;

  // 1) Server icon --------------------------------------------------------
  step('Server identity');
  try {
    if (!guild.icon) {
      const icon = await readFile(join(HERE, '..', '..', 'apps', 'dashboard', 'public', 'logo.png'));
      if (!DRY) await guild.setIcon(icon, 'CasCet brand');
      ok('set server icon from apps/dashboard/public/logo.png');
    } else {
      skip('server icon');
    }
  } catch (e) {
    warn(`could not set icon: ${e.message}`);
  }

  // 2) Roles --------------------------------------------------------------
  step('Roles');
  const role = {};
  for (const r of ROLES) {
    let existing = guild.roles.cache.find((x) => x.name === r.name);
    if (existing) {
      role[r.key] = existing;
      skip(`role ${r.name}`);
      continue;
    }
    if (DRY) { ok(`would create role ${r.name}`); role[r.key] = { id: `dry:${r.key}` }; continue; }
    existing = await guild.roles.create({
      name: r.name,
      color: r.color,
      hoist: r.hoist,
      mentionable: r.mentionable,
      permissions: r.admin ? [PermissionFlagsBits.Administrator] : [],
      reason: 'CasCet setup',
    });
    role[r.key] = existing;
    ok(`created role ${r.name}`);
  }

  // 3) Categories + channels ---------------------------------------------
  step('Channels');
  const chan = {}; // name -> channel
  for (const group of TREE) {
    let cat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === group.category);
    if (!cat) {
      if (DRY) { ok(`would create category ${group.category}`); }
      else { cat = await guild.channels.create({ name: group.category, type: ChannelType.GuildCategory, reason: 'CasCet setup' }); ok(`created category ${group.category}`); }
    } else {
      skip(`category ${group.category}`);
    }

    for (const ch of group.channels) {
      const readOnly = ch.ro ?? group.ro ?? false;
      // 'news' channels are created as text first, then converted to announcement
      // channels after Community is enabled (announcement type is community-gated).
      const type = ch.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;

      let existing = guild.channels.cache.find((c) => c.name === ch.name && c.type !== ChannelType.GuildCategory);
      const overwrites = readOnly
        ? [
            { id: everyone.id, deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads] },
            ...(role.core?.id && !String(role.core.id).startsWith('dry:') ? [{ id: role.core.id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] }] : []),
          ]
        : [];

      if (existing) {
        chan[ch.name] = existing;
        if (!DRY) {
          try {
            await existing.edit({ topic: ch.topic, parent: cat?.id, permissionOverwrites: overwrites.length ? overwrites : undefined });
          } catch {}
        }
        skip(`#${ch.name}`);
        continue;
      }
      if (DRY) { ok(`would create #${ch.name}${readOnly ? ' (read-only)' : ''}`); continue; }
      existing = await guild.channels.create({
        name: ch.name,
        type,
        parent: cat?.id,
        topic: type === ChannelType.GuildVoice ? undefined : ch.topic,
        permissionOverwrites: overwrites.length ? overwrites : undefined,
        reason: 'CasCet setup',
      });
      chan[ch.name] = existing;
      ok(`created #${ch.name}${readOnly ? ' (read-only)' : ''}`);

      if (ch.webhook) {
        try {
          const hooks = await existing.fetchWebhooks();
          if (!hooks.find((h) => h.name === ch.webhook)) {
            const wh = await existing.createWebhook({ name: ch.webhook, reason: 'GitHub feed' });
            ok(`webhook for #${ch.name} → append \x1b[4m/github\x1b[0m to this URL in GitHub → Settings → Webhooks:\n      ${wh.url}`);
          }
        } catch (e) { warn(`webhook for #${ch.name}: ${e.message}`); }
      }
    }
  }

  // 4) Pinned content -----------------------------------------------------
  step('Welcome, rules, announcement, roadmap');
  await postOnce(chan['welcome'], rulesEmbed);
  await postOnce(chan['announcements'], announcementEmbed);
  await postOnce(chan['roadmap'], roadmapEmbed);
  await postOnce(chan['general'], generalEmbed);

  // 5) Community + welcome screen + onboarding ----------------------------
  step('Community features');
  let communityEnabled = guild.features.includes('COMMUNITY');
  if (communityEnabled) {
    skip('Community');
  } else if (DRY) {
    ok('would enable Community (needed for welcome screen + onboarding)');
  } else {
    try {
      await guild.edit({
        features: [...guild.features, 'COMMUNITY'],
        rulesChannel: chan['welcome']?.id,
        publicUpdatesChannel: chan['announcements']?.id,
        verificationLevel: GuildVerificationLevel.Low,
        defaultMessageNotifications: GuildDefaultMessageNotifications.OnlyMentions,
        explicitContentFilter: GuildExplicitContentFilter.AllMembers,
        reason: 'CasCet setup',
      });
      communityEnabled = true;
      ok('enabled Community');
    } catch (e) {
      warn(`could not auto-enable Community: ${e.message}`);
      warn('Enable it once in Server Settings → Enable Community (rules=#welcome, updates=#announcements), then re-run.');
    }
  }

  // Convert 'news' channels to announcement channels (needs Community).
  if (communityEnabled && !DRY) {
    const newsNames = TREE.flatMap((g) => g.channels).filter((c) => c.type === 'news').map((c) => c.name);
    for (const name of newsNames) {
      const c = chan[name];
      if (c && c.type === ChannelType.GuildText) {
        try { await c.edit({ type: ChannelType.GuildAnnouncement, reason: 'CasCet setup' }); ok(`#${name} → announcement channel`); }
        catch (e) { warn(`convert #${name}: ${e.message}`); }
      } else if (c) {
        skip(`#${name} announcement type`);
      }
    }
  }

  if (communityEnabled || DRY) {
    try {
      if (!DRY) {
        await guild.editWelcomeScreen({
          enabled: true,
          description: 'Payments that cascade. The monetization layer for MCP on Casper.',
          welcomeChannels: [
            { channel: chan['welcome']?.id, description: 'Rules and the links that matter', emoji: '👋' },
            { channel: chan['general']?.id, description: 'Say hi and talk shop', emoji: '💬' },
            { channel: chan['dev']?.id, description: 'Build on CasCet / x402', emoji: '🛠️' },
            { channel: chan['showcase']?.id, description: 'Show what you built', emoji: '✨' },
          ].filter((c) => c.channel),
        });
      }
      ok('welcome screen');
    } catch (e) { warn(`welcome screen: ${e.message}`); }

    try {
      if (!DRY) await setupOnboarding(guild, chan, role);
      ok('onboarding prompts (What brings you here / Topics)');
    } catch (e) {
      warn(`onboarding: ${e.message}`);
      warn('If this failed, set it up once in Server Settings → Onboarding, then re-run.');
    }
  }

  // 6) Demo Day event -----------------------------------------------------
  step('Scheduled event');
  try {
    const events = await guild.scheduledEvents.fetch();
    if (![...events.values()].some((e) => e.name === 'CasCet Demo Day')) {
      const start = new Date(DEMO_DAY_ISO);
      const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
      if (start.getTime() > Date.now()) {
        if (!DRY) {
          await guild.scheduledEvents.create({
            name: 'CasCet Demo Day',
            scheduledStartTime: start,
            scheduledEndTime: end,
            privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
            entityType: GuildScheduledEventEntityType.External,
            entityMetadata: { location: LINKS.site },
            description: 'CasCet demo + walkthrough for the Casper Agentic Buildathon 2026. Payments that cascade.',
          });
        }
        ok(`created "CasCet Demo Day" for ${start.toUTCString()}`);
      } else {
        warn(`DEMO_DAY_ISO (${DEMO_DAY_ISO}) is in the past — skipping the event. Set a future DEMO_DAY_ISO to add it.`);
      }
    } else {
      skip('event "CasCet Demo Day"');
    }
  } catch (e) { warn(`event: ${e.message}`); }

  step('Done ✅');
  log(`  ${DRY ? 'Dry run complete — nothing was written.' : 'CasCet server configured.'}  ${LINKS.site}`);
  await client.destroy();
}

/** Send + pin one embed, but only if an equally-footered pin is not already there. */
async function postOnce(channel, embed) {
  if (!channel) { warn(`skip post — channel missing`); return; }
  const marker = embed.footer?.text;
  if (DRY) { ok(`would post + pin “${embed.title}” in #${channel.name}`); return; }
  try {
    const pins = await channel.messages.fetchPinned();
    if ([...pins.values()].some((m) => m.embeds?.[0]?.footer?.text === marker)) { skip(`“${embed.title}” in #${channel.name}`); return; }
    const msg = await channel.send({ embeds: [embed] });
    await msg.pin('CasCet setup');
    ok(`posted + pinned “${embed.title}” in #${channel.name}`);
  } catch (e) { warn(`post “${embed.title}”: ${e.message}`); }
}

/** Two onboarding prompts: a status role, then multi-select topic roles. */
async function setupOnboarding(guild, chan, role) {
  const has = (r) => role[r]?.id && !String(role[r].id).startsWith('dry:');
  const prompts = [
    {
      title: 'What brings you to CasCet?',
      singleSelect: true,
      required: true,
      inOnboarding: true,
      type: GuildOnboardingPromptType.MultipleChoice,
      options: [
        { title: 'Building on x402 / MCP', description: 'You ship agent tooling', emoji: { name: '🛠️' }, roles: has('builder') ? [role.builder.id] : [], channels: [chan['dev']?.id, chan['x402-and-mcp']?.id].filter(Boolean) },
        { title: 'Contributing to CasCet', description: 'PRs, issues, the spec', emoji: { name: '⚡' }, roles: has('contributor') ? [role.contributor.id] : [], channels: [chan['dev']?.id, chan['contracts']?.id].filter(Boolean) },
        { title: 'Just exploring', description: 'Here to watch and learn', emoji: { name: '🌱' }, roles: [], channels: [chan['general']?.id, chan['showcase']?.id].filter(Boolean) },
      ],
    },
    {
      title: 'What are you into?',
      singleSelect: false,
      required: false,
      inOnboarding: true,
      type: GuildOnboardingPromptType.MultipleChoice,
      options: [
        { title: 'x402', emoji: { name: '💸' }, roles: has('topic_x402') ? [role.topic_x402.id] : [], channels: [chan['x402-and-mcp']?.id].filter(Boolean) },
        { title: 'MCP', emoji: { name: '🔌' }, roles: has('topic_mcp') ? [role.topic_mcp.id] : [], channels: [chan['x402-and-mcp']?.id].filter(Boolean) },
        { title: 'Casper / Odra', emoji: { name: '⛓️' }, roles: has('topic_casper') ? [role.topic_casper.id] : [], channels: [chan['contracts']?.id].filter(Boolean) },
        { title: 'DeFi / RWA', emoji: { name: '📈' }, roles: has('topic_defi') ? [role.topic_defi.id] : [], channels: [chan['general']?.id].filter(Boolean) },
      ],
    },
  ];

  await guild.editOnboarding({
    enabled: true,
    mode: GuildOnboardingMode.OnboardingDefault,
    defaultChannels: [chan['welcome']?.id, chan['announcements']?.id, chan['general']?.id, chan['introductions']?.id].filter(Boolean),
    prompts,
    reason: 'CasCet setup',
  });
}

main().catch((e) => {
  console.error('\x1b[31mSetup failed:\x1b[0m', e);
  process.exit(1);
});

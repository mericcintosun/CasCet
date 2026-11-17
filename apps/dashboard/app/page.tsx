import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Coins,
  GitBranch,
  Github,
  Lock,
  MessageSquare,
  Network,
  Receipt,
  ShieldCheck,
  Sparkles,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Logo, LogoMark } from "@/components/logo";
import { MarketingHeader } from "@/components/landing/marketing-header";
import { CinematicIntro } from "@/components/landing/cinematic-intro";
import { Steps } from "@/components/landing/steps";
import { GetStarted } from "@/components/landing/get-started";
import { Reveal } from "@/components/landing/reveal";
import { CascadeFlow } from "@/components/landing/cascade-flow";
import { XIcon } from "@/components/social-icons";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { alternates: { canonical: "/" } };

const GH = "https://github.com/mericcintosun/CasCet";
const SOCIALS = {
  x: "https://x.com/cascet_xyz",
  // Questions, bugs and ideas go to GitHub issues.
  issues: `${GH}/issues`,
  github: GH,
};
const CONTRACT = (hash: string) => `https://cspr.live/contract-package/${hash}`;

// Live on Casper MAINNET (chain "casper"). Full testnet set is in docs/onchain.md. Lock status read from
// mainnet global state (query_global_state, 2026-11-02): Cep18X402 is Unlocked, the other five are Locked.
const CONTRACTS = [
  { name: "CascadeController", note: "budget-bounded cascade tree + recursive attribution", hash: "c7e56988214c62dc5eda20b14894a7514f7388560850b6db3094758363a62189" },
  { name: "ReceiptRegistry", note: "on-chain settled-call receipts with cascade parent links", hash: "f86bef35062e92d06b8171cf4131fdf557463589aca9112a348e5eb24159eb93" },
  { name: "PaymentChannel", note: "prepaid channels, off-chain signed vouchers", hash: "db2dc42b76f354e7716cafea8619ae6bc85fe50bc3e73979c2360dbba1458c57" },
  { name: "RevenueSplit", note: "on-chain CEP-18 revenue splitter", hash: "269afcceb147db41f68f5721df7b3957e5efeefb3bedbb9deba324c3a45d09c5" },
  { name: "DemoToken", note: "CasCet CEP-18 payment token (WCSPR-style)", hash: "3da88daf3f276d915ea4f6734e0d4b3d4781358734c369b95de028a2c094fe74" },
  { name: "Cep18X402", note: "payment token with transfer_with_authorization; its package is unlocked, so the owner key can upgrade it", hash: "8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41" },
];

const STATS = [
  { k: "mainnet", v: "contracts + x402 settlement live" },
  { k: "x402", v: "real settlement, no mock" },
  { k: "N-hop", v: "cascading payments" },
  { k: "1", v: "autonomous LLM buyer" },
];

export default function LandingPage() {
  return (
    <div className="relative min-h-screen">
      <MarketingHeader />
      <CinematicIntro />
      <Hero />
      <HowItWorks />
      <GetStartedSection />
      <CascadePrimitive />
      <Features />
      <X402Flow />
      <AgentSection />
      <Contracts />
      <Roadmap />
      <Faq />
      <FinalCta />
      <Footer />
    </div>
  );
}

/* ── Hero ──────────────────────────────────────────────────────────────── */
function Hero() {
  return (
    <section className="grain relative overflow-hidden">
      <div className="aurora absolute inset-0" />
      <div className="absolute inset-0">
        <Image
          src="/hero.png"
          alt=""
          fill
          sizes="100vw"
          className="object-cover object-right opacity-80 dark:opacity-90"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-background via-background/85 to-background/20" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-background to-transparent" />
      </div>

      <div className="relative mx-auto flex min-h-[90vh] max-w-6xl flex-col justify-center px-6 py-24">
        <div className="max-w-2xl">
          <Badge variant="outline" className="mb-6 gap-1.5 border-primary/30 bg-primary/5 py-1 pl-1.5 pr-3 text-foreground">
            <span className="flex h-5 w-5 items-center justify-center rounded text-primary">
              <LogoMark />
            </span>
            <span className="font-mono text-[11px]">Casper Agentic Buildathon 2026</span>
          </Badge>

          <h1 className="text-balance text-5xl font-semibold leading-[1.02] tracking-tight sm:text-6xl lg:text-7xl">
            Payments that <span className="text-gradient">cascade</span>.
          </h1>

          <p className="mt-6 max-w-xl text-pretty text-lg leading-relaxed text-muted-foreground">
            CasCet is the monetization layer for MCP on Casper, the <span className="text-foreground">Stripe for MCP servers</span>.
            Charge AI agents per tool call over x402, and settle the <span className="text-foreground">multi-hop payment chains</span> no
            one else does, on-chain and in seconds.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button asChild size="lg" className="gap-2">
              <Link href="/dashboard">
                Launch the live dashboard <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="gap-2">
              <Link href="#cascade">
                See the primitive <GitBranch className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="ghost" className="gap-2 text-muted-foreground">
              <Link href={GH} target="_blank">
                <Github className="h-4 w-4" /> GitHub
              </Link>
            </Button>
          </div>

          <dl className="mt-14 grid max-w-lg grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-4">
            {STATS.map(s => (
              <div key={s.v}>
                <dt className="font-mono text-2xl font-semibold text-primary">{s.k}</dt>
                <dd className="mt-1 text-xs leading-tight text-muted-foreground">{s.v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
            Internal security review; external audit planned.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ── How it works (interactive stepper) ────────────────────────────────── */
function HowItWorks() {
  return (
    <Section id="how" eyebrow="How it works" title="From free tool to paid, composable service">
      <Reveal>
        <Steps />
      </Reveal>
    </Section>
  );
}

/* ── Get started (interactive, copy-paste per persona) ─────────────────── */
function GetStartedSection() {
  return (
    <section id="start" className="border-y border-border bg-card/30">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <Reveal className="mb-10 max-w-2xl">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Get started</p>
          <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">Three ways in</h2>
          <p className="mt-3 text-pretty leading-relaxed text-muted-foreground">
            Pick your role. Every command is copy-paste ready.
          </p>
        </Reveal>
        <Reveal>
          <GetStarted />
        </Reveal>
      </div>
    </section>
  );
}

/* ── The cascade primitive ─────────────────────────────────────────────── */
function CascadePrimitive() {
  return (
    <section id="cascade" className="relative border-y border-border bg-card/30">
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-6 py-24 lg:grid-cols-2">
        <Reveal className="min-w-0">
          <Badge variant="outline" className="mb-5 border-primary/30 font-mono text-[11px] text-primary">
            the primitive
          </Badge>
          <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Budget-bounded cascades with recursive attribution
          </h2>
          <p className="mt-5 text-pretty leading-relaxed text-muted-foreground">
            The headline isn&apos;t &ldquo;agents pay per call&rdquo;. It&apos;s a machine-to-machine primitive that only
            makes sense once payments compose into trees. The <span className="font-mono text-foreground">CascadeController</span>{" "}
            contract turns a cascade into a programmable supply chain.
          </p>
          <ul className="mt-7 space-y-5">
            <Feat icon={Wallet} title="On-chain budget tree">
              In the CascadeController, an agent opens a cascade with{" "}
              <span className="text-foreground">one deposit that caps the whole call tree</span>. The contract pays each hop out
              of it and refuses any hop that would exceed the budget, by construction rather than by trusting a gateway. The live
              gateway flow does not route payments through it yet; there, budgets are enforced by the buyer&apos;s bridge.
            </Feat>
            <Feat icon={Network} title="Recursive attribution">
              A configurable share of a child hop&apos;s earnings flows <span className="text-foreground">up</span> to the parent
              hop&apos;s payee, so the composing service earns margin on what it resells. The payment graph <em>is</em> the
              revenue-sharing graph.
            </Feat>
          </ul>
          <p className="mt-7 rounded-lg border border-border bg-background/60 p-4 font-mono text-xs leading-relaxed text-muted-foreground">
            <a
              href="https://cspr.live/transaction/999396c44ad6af738000e20928faff4c49978d63571ceaaa8ba9010602d68b9a"
              target="_blank"
              rel="noreferrer"
              className="text-success hover:underline"
            >
              ✓ proven on Casper mainnet:
            </a>{" "}
            open(100) → root pays analyst 40 → child pays data 20 with 20% attribution (data +16, analyst +4 up the tree) →
            an over-budget hop is <span className="text-destructive">rejected on-chain</span> (BudgetExceeded) → close refunds
            the unspent 40. Every step is a real transaction on cspr.live. Next: wiring the controller into the gateway&apos;s
            live payment flow.
          </p>
          <Button asChild variant="outline" size="sm" className="mt-6 gap-2">
            <Link href="/playground">
              Try it in the playground <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </Reveal>

        <Reveal delay={120} className="min-w-0">
          <div className="glow-primary rounded-2xl border border-border bg-background/70 p-6">
            <div className="mb-4 flex items-center justify-between">
              <span className="font-mono text-xs text-muted-foreground">cascade.trace</span>
              <span className="flex items-center gap-1.5 font-mono text-[11px] text-primary">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" /> settling
              </span>
            </div>
            <CascadeFlow />
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ── Features (editorial hover list, no boxes) ─────────────────────────── */
function Features() {
  const feats = [
    { icon: ShieldCheck, t: "Real x402 settlement, no mock", d: <>Agents pay from an on-chain balance of a real <span className="font-mono text-foreground">transfer_with_authorization</span> CEP-18 token; a self-hosted x402 facilitator verifies and settles it; receipts anchor on-chain. Every hop is a real Casper transaction.</> },
    { icon: Receipt, t: "Receipts, on-chain", d: <>Every settled call is anchored with its cascade parent id, so the whole payment graph reconstructs from chain data alone, no central coordinator.</> },
    { icon: Lock, t: "Upgradable registry (testnet)", d: <>On testnet the ReceiptRegistry was upgraded v1.1 to v1.2 in place and all anchored state survived. On mainnet the CascadeController, ReceiptRegistry, PaymentChannel, RevenueSplit and DemoToken packages are locked (not upgradable); the Cep18X402 payment token package is unlocked, so its owner key can upgrade it.</> },
    { icon: Coins, t: "Revenue splits", d: <>The RevenueSplit contract splits the tokens it holds between co-authors by fixed weights, on-chain and pull-based: each payee withdraws their own share. x402 settles to account hashes today, so earnings reach the splitter by a transfer.</> },
    { icon: GitBranch, t: "Wrap any MCP server", d: <>CasCet monetizes the unmodified official <span className="font-mono text-foreground">server-everything</span>, not just first-party tools.</> },
  ];
  return (
    <Section eyebrow="Built end-to-end" title="Not a demo, a working machine-money stack">
      <div className="border-t border-border">
        {feats.map((f, i) => (
          <Reveal key={i} delay={(i % 2) * 60}>
            {/* stacked on phones: long mono words (transfer_with_authorization) can't squeeze into a second column */}
            <div className="group relative grid grid-cols-1 items-start gap-3 border-b border-border py-7 pl-5 pr-4 transition-colors hover:bg-card/40 sm:grid-cols-[220px_minmax(0,1fr)] sm:gap-10 sm:pl-6">
              <span className="absolute left-0 top-0 h-full w-[3px] origin-top scale-y-0 bg-primary transition-transform duration-300 group-hover:scale-y-100" />
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20 transition-transform duration-300 group-hover:-translate-y-0.5">
                  <f.icon className="h-[18px] w-[18px]" />
                </span>
                <h3 className="text-base font-semibold leading-tight">{f.t}</h3>
              </div>
              <p className="min-w-0 text-pretty break-words text-sm leading-relaxed text-muted-foreground">{f.d}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}

/* ── x402 flow code block ──────────────────────────────────────────────── */
function X402Flow() {
  return (
    <section className="border-y border-border bg-card/30">
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-6 py-24 lg:grid-cols-2">
        <Reveal className="min-w-0">
          <Badge variant="outline" className="mb-5 border-primary/30 font-mono text-[11px] text-primary">
            show the call, not the dashboard
          </Badge>
          <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">One tool call, paid over HTTP 402</h2>
          <p className="mt-5 text-pretty leading-relaxed text-muted-foreground">
            MCP speaks JSON-RPC over one endpoint, so the gateway maps each priced tool to an x402 route. The agent&apos;s wallet
            signs a CEP-18 authorization and retries, and the gateway <span className="text-foreground">only charges if the tool
            succeeds</span>. A failed call is never billed.
          </p>
          <div className="mt-6 flex flex-wrap gap-4 font-mono text-xs text-muted-foreground">
            <span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-warning" /> 402 challenge</span>
            <span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-primary" /> sign + pay</span>
            <span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-success" /> settled</span>
          </div>
        </Reveal>
        <Reveal delay={120} className="min-w-0">
          <CodeCard />
        </Reveal>
      </div>
    </section>
  );
}

function CodeCard() {
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-[hsl(228_16%_7%)] font-mono text-[13px] leading-relaxed shadow-xl">
      <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-destructive/70" />
        <span className="h-3 w-3 rounded-full bg-warning/70" />
        <span className="h-3 w-3 rounded-full bg-success/70" />
        <span className="ml-2 text-xs text-white/60">agent → paid MCP tool</span>
      </div>
      <pre className="overflow-x-auto p-5 text-white/80">
        <code>
          <span className="text-white/60"># 1. agent calls a priced tool</span>
          {"\n"}POST /mcp <span className="text-[#8be9fd]">tools/call</span> get_rwa_price{"\n"}
          {"\n"}
          <span className="text-amber-300">← 402 Payment Required</span>{"\n"}
          <span className="text-white/60">  price: $0.02 · asset: CEP-18 · network: casper-test</span>
          {"\n\n"}
          <span className="text-white/60"># 2. wallet signs transfer_with_authorization, retries</span>
          {"\n"}POST /mcp <span className="text-[#8be9fd]">PAYMENT-SIGNATURE</span> 0x…{"\n"}
          {"\n"}
          <span className="text-[#C6F94E]">→ 200 OK</span>{"  "}
          <span className="text-white/60">x-cascet-payment-id: 21e0be7a…</span>
          {"\n"}
          {"  "}{"{"} &quot;asset&quot;: &quot;gold&quot;, &quot;priceUsd&quot;: <span className="text-[#C6F94E]">4095.83</span> {"}"}
          {"\n\n"}
          <span className="text-emerald-400">✓ settled on Casper</span> <span className="text-white/60">· receipt anchored on-chain</span>
        </code>
      </pre>
    </div>
  );
}

/* ── Autonomous agent ──────────────────────────────────────────────────── */
function AgentSection() {
  const steps = ["discovers the paid tools + their x402 prices", "decides which to buy for a DeFi/RWA goal", "pays per call within a spending cap its bridge enforces", "cites the data it purchased in a recommendation"];
  return (
    <Section id="agent" eyebrow="The autonomous buyer" title="An LLM that prices, budgets, and buys tools on its own">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <Reveal className="min-w-0">
          <div className="card-lift h-full rounded-2xl border border-border bg-card p-6 sm:p-8">
            <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
              <Sparkles className="h-5 w-5" />
            </div>
            <p className="text-pretty leading-relaxed text-muted-foreground">
              The seller side turns MCP tools into paid services. The <span className="text-foreground">buyer</span> makes that
              economy self-driving: given a DeFi/RWA goal, <span className="text-foreground">Claude</span> reads the tools&apos;
              prices straight from <span className="font-mono text-foreground">tools/list</span> and:
            </p>
            <ol className="mt-6 space-y-3">
              {steps.map((s, i) => (
                <li key={i} className="flex items-start gap-3 text-sm">
                  <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <span className="text-muted-foreground">{s}</span>
                </li>
              ))}
            </ol>
            <p className="mt-6 rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">How it runs:</span> the free live demo drives real Claude on your
              Max/Pro plan via <span className="font-mono text-foreground">cascet connect</span> (no paid API key). Tool discovery,
              x402 pricing and payments are real; the bridge checks the budget before it signs, and every payment settles on-chain.
            </p>
          </div>
        </Reveal>
        <Reveal delay={120} className="min-w-0">
          <div className="h-full overflow-hidden rounded-2xl border border-white/10 bg-[hsl(228_16%_7%)] p-6 font-mono text-[12.5px] leading-relaxed">
            <div className="mb-4 text-xs text-white/60">$ cascet agent</div>
            <div className="space-y-2 text-white/80">
              <p className="text-[#C6F94E]">🧠 buy get_cspr_market_data ($0.01)</p>
              <p className="pl-4 text-white/60">💸 x402 · ✅ paid</p>
              <p className="text-[#C6F94E]">🧠 buy get_defi_yields ($0.02)</p>
              <p className="pl-4 text-white/60">💸 x402 · ✅ paid</p>
              <p className="text-[#C6F94E]">🧠 buy get_rwa_price gold + treasury</p>
              <p className="pl-4 text-white/60">💸 x402 ×2 · ✅ paid</p>
              <p className="mt-3 border-t border-white/10 pt-3 text-white/70">
                → keep ~55% stCSPR liquid staking (9.9% APY, liquid), rotate ~30% into tokenized treasuries, ~15% gold hedge.
              </p>
              <p className="text-emerald-400">✓ 4 tools bought under budget · grounded in real data</p>
            </div>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}

/* ── Contracts ─────────────────────────────────────────────────────────── */
function Contracts() {
  return (
    <Section id="contracts" eyebrow="On-chain layer" title="Six contracts, live on Casper mainnet">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CONTRACTS.map((c, i) => (
          <Reveal key={c.name} delay={(i % 3) * 70}>
            <Link
              href={CONTRACT(c.hash)}
              target="_blank"
              className="card-lift group flex h-full flex-col rounded-xl border border-border bg-card p-5"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm font-semibold">{c.name}</span>
                <ArrowUpRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-primary" />
              </div>
              <p className="mt-2 flex-1 text-xs leading-relaxed text-muted-foreground">{c.note}</p>
              <span className="mt-3 truncate font-mono text-[10px] text-muted-foreground">{c.hash.slice(0, 20)}…</span>
            </Link>
          </Reveal>
        ))}
      </div>
      <p className="mt-6 text-center font-mono text-xs text-muted-foreground">
        real x402 settlement on mainnet ·{" "}
        <Link
          href="https://cspr.live/transaction/2c66141c324216f4966f2d565c64c55cb37047cfc86b9863717d08d1b60a3bd1"
          target="_blank"
          className="text-primary hover:underline"
        >
          2c66141c…
        </Link>{" "}
        · cascade primitive proven on mainnet ·{" "}
        <Link
          href="https://cspr.live/transaction/999396c44ad6af738000e20928faff4c49978d63571ceaaa8ba9010602d68b9a"
          target="_blank"
          className="text-primary hover:underline"
        >
          999396c4…
        </Link>
      </p>
    </Section>
  );
}

/* ── FAQ ───────────────────────────────────────────────────────────────── */
function Faq() {
  const items = [
    {
      q: "What exactly is x402?",
      a: "The HTTP 402 \"Payment Required\" status turned into a real protocol: a server answers a request with a payment challenge, the client signs an on-chain authorization and retries, and the server settles it. CasCet applies it per MCP tool call, in CEP-18 on Casper.",
    },
    {
      q: "Why does \"cascading\" matter?",
      a: "Real agent tools compose. A portfolio analyzer internally buys a price feed and an RWA feed, each a paid service. CasCet links every hop of that payment chain to its parent and can cap and split the whole tree on-chain. Point-to-point x402 can't express that.",
    },
    {
      q: "Is this actually on-chain, or a mock?",
      a: "On-chain. The full contract set is deployed on Casper mainnet (and testnet), real x402 settlement is verified end-to-end through a self-hosted x402 facilitator with no mock anywhere in the path, and the CascadeController primitive itself ran a full budget-capped cascade on mainnet: open, root and child hops with attribution up the tree, an over-budget hop rejected on-chain, and a refund on close. Every one of those transactions opens on cspr.live. The live dashboard and explorer on this site read the testnet ReceiptRegistry and are labelled as testnet data.",
    },
    {
      q: "Has CasCet been audited?",
      a: "Not yet. CasCet went through an internal security review before mainnet; an external audit is planned. Until it has happened, treat the mainnet deployment as early software: keep the balances you route through it small, and set seller allowlists and spending caps on every buyer.",
    },
    {
      q: "What does the autonomous agent do?",
      a: "Claude reads the paid tools' prices, decides which to buy for a DeFi/RWA goal, pays x402 per call under a fixed budget, and cites the purchased data in a recommendation. The free live demo runs real Claude on your Max/Pro plan via cascet connect, and every purchase settles real on-chain.",
    },
    {
      q: "Why Casper?",
      a: "Zug instant deterministic finality means a multi-hop chain settles in seconds with certainty (probabilistic finality would stall it), native on-chain revenue splits, upgradable contracts, and predictable fees so agents can budget.",
    },
  ];
  return (
    <section className="mx-auto max-w-3xl px-6 py-24 text-center">
      <Reveal className="mb-10">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">FAQ</p>
        <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">Questions, answered</h2>
      </Reveal>
      <Reveal>
        <Accordion type="single" collapsible className="text-left">
          {items.map((it, i) => (
            <AccordionItem key={i} value={`q${i}`}>
              <AccordionTrigger>{it.q}</AccordionTrigger>
              <AccordionContent>{it.a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </Reveal>
    </section>
  );
}

/* ── Roadmap / long-term plan (de-boxed timeline) ──────────────────────── */
function Roadmap() {
  const phases = [
    {
      tag: "shipped",
      when: "Qualification · Jul 2026",
      title: "The primitive, proven on-chain",
      points: [
        "5 Odra contracts; real x402 settlement, no mock.",
        "CascadeController: budget-bounded cascades + recursive attribution.",
        "Autonomous LLM buyer, live dashboard, cascade playground, and a proposed x402-MCP spec.",
        "CLI + libraries published on npm (@cascet/cli, core, client, gateway).",
      ],
    },
    {
      tag: "shipped",
      when: "Final round · Jul 2026",
      title: "Live on Casper mainnet, end-to-end",
      points: [
        "Full contract set live on Casper mainnet; real x402 settled from both the TypeScript and Python clients.",
        "The CascadeController primitive proven on mainnet: budget cap, attribution up the tree, over-budget revert, and refund.",
        "Internal pre-mainnet security review; its findings were fixed and the contracts redeployed. External audit planned.",
        "On-chain-backed dashboard + explorer (rebuilt from the testnet ReceiptRegistry), a /build config wizard, and a Casper Wallet withdraw page for RevenueSplit payees (testnet).",
      ],
    },
    {
      tag: "next",
      when: "Q4 2026",
      title: "Monetization & control plane",
      points: [
        "@cascet/* 0.1.1: the fixes from the 2026-10-20 internal review; cascet connect requires allowlists and caps.",
        "An external security audit of the contracts and the payment path.",
        "A protocol take-rate on settled volume: the business model.",
        "Hosted CasCet control plane: register a server, get a paid endpoint + dashboard in one step.",
        "Per-second / streaming price schemes and a public metrics API.",
      ],
    },
    {
      tag: "vision",
      when: "2027 →",
      title: "The trust layer for the agent economy",
      points: [
        "An agent-facing pricing-discovery API and a Bazaar marketplace of paid MCP tools.",
        "On-chain reputation for tools and agents; cross-chain settlement.",
        "CasCet as default rails for machine-to-machine commerce.",
      ],
    },
  ];
  const tagStyle: Record<string, string> = {
    shipped: "border-success/40 bg-success/10 text-success",
    next: "border-primary/40 bg-primary/10 text-primary",
    planned: "border-border bg-secondary text-muted-foreground",
    vision: "border-flow/40 bg-flow/10 text-flow",
  };
  return (
    <Section id="roadmap" eyebrow="Where this goes" title="A real project with a long-term plan">
      <div className="relative">
        <div className="absolute bottom-2 left-[7px] top-2 w-px bg-border sm:left-[9px]" />
        <div className="space-y-2">
          {phases.map((p, i) => (
            <Reveal key={i} delay={(i % 2) * 60}>
              <div className="group relative grid grid-cols-[auto_minmax(0,1fr)] gap-5 rounded-lg py-6 pl-1 pr-4 transition-colors hover:bg-card/40 sm:gap-8">
                <span
                  className={cn(
                    "relative z-10 mt-1.5 h-4 w-4 shrink-0 rounded-full border-2 transition-all sm:h-5 sm:w-5",
                    p.tag === "shipped"
                      ? "border-success bg-success shadow-[0_0_16px_-2px_hsl(var(--success)/0.6)]"
                      : p.tag === "next"
                        ? "border-primary bg-primary shadow-[0_0_16px_-2px_hsl(var(--primary)/0.6)]"
                        : "border-border bg-background group-hover:border-primary/50",
                  )}
                />
                <div>
                  <div className="flex flex-wrap items-center gap-3">
                    <span className={cn("rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide", tagStyle[p.tag])}>
                      {p.tag}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">{p.when}</span>
                  </div>
                  <h3 className="mt-2.5 text-lg font-semibold tracking-tight">{p.title}</h3>
                  <ul className="mt-2 space-y-1.5">
                    {p.points.map((pt, j) => (
                      <li key={j} className="flex gap-2.5 text-sm leading-relaxed text-muted-foreground">
                        <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary/60" />
                        {pt}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </Section>
  );
}

/* ── Final CTA ─────────────────────────────────────────────────────────── */
function FinalCta() {
  return (
    <section className="relative overflow-hidden border-t border-border">
      <div className="aurora absolute inset-0 opacity-70" />
      <div className="relative mx-auto max-w-3xl px-6 py-28 text-center">
        <Reveal>
          <div className="mx-auto mb-6 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
            <LogoMark className="h-6 w-6" />
          </div>
          <h2 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
            The trust layer for the <span className="text-gradient">agent economy</span>
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-pretty leading-relaxed text-muted-foreground">
            Machine-to-machine commerce needs payments that compose. CasCet ships that primitive first, on Casper.
          </p>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <Button asChild size="lg" className="gap-2">
              <Link href="/dashboard">
                Explore the live dashboard <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="gap-2">
              <Link href={GH} target="_blank">
                <Github className="h-4 w-4" /> Read the code
              </Link>
            </Button>
          </div>
          <div className="mt-8 flex items-center justify-center gap-2">
            <span className="mr-1 font-mono text-xs text-muted-foreground">Follow the build</span>
            {[
              { href: SOCIALS.x, label: "X", Icon: XIcon },
              { href: SOCIALS.issues, label: "GitHub issues", Icon: MessageSquare },
            ].map(s => (
              <Link
                key={s.label}
                href={s.href}
                target="_blank"
                aria-label={s.label}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
              >
                <s.Icon />
              </Link>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ── Footer ────────────────────────────────────────────────────────────── */
function Footer() {
  const socials = [
    { href: SOCIALS.x, label: "X", Icon: XIcon },
    { href: SOCIALS.issues, label: "GitHub issues", Icon: MessageSquare },
    { href: SOCIALS.github, label: "GitHub", Icon: Github },
  ];
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-xs">
            <Logo subtitle="Payments that cascade" />
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
              The monetization layer for MCP on Casper. Follow the build.
            </p>
            <div className="mt-5 flex items-center gap-2">
              {socials.map(s => (
                <Link
                  key={s.label}
                  href={s.href}
                  target="_blank"
                  aria-label={s.label}
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
                >
                  <s.Icon />
                </Link>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-12 gap-y-2 text-sm sm:grid-cols-3">
            <FooterCol title="Product" links={[["Dashboard", "/dashboard"], ["Playground", "/playground"], ["Explorer", "/explorer"]]} />
            <FooterCol title="Learn" links={[["How it works", "#how"], ["The primitive", "#cascade"], ["Roadmap", "#roadmap"]]} />
            <FooterCol
              title="Build"
              links={[
                ["Seller config", "/build"],
                ["Buyer setup", "/connect"],
                ["GitHub", SOCIALS.github],
                ["Issues & questions", SOCIALS.issues],
                ["x402 spec", `${GH}/blob/main/docs/x402-mcp-spec.md`],
              ]}
            />
          </div>
        </div>
        <div className="mt-10 flex flex-col items-center justify-between gap-3 border-t border-border pt-6 sm:flex-row">
          <p className="font-mono text-xs text-muted-foreground">Casper Agentic Buildathon 2026 · Apache-2.0</p>
          <p className="font-mono text-xs text-muted-foreground">Built on Casper</p>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <div className="mb-2.5 font-mono text-xs uppercase tracking-wide text-muted-foreground">{title}</div>
      <ul className="space-y-2">
        {links.map(([label, href]) => (
          <li key={label}>
            <Link
              href={href}
              target={href.startsWith("http") ? "_blank" : undefined}
              rel={href.startsWith("http") ? "noreferrer" : undefined}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── Shared bits ───────────────────────────────────────────────────────── */
function Section({ id, eyebrow, title, children }: { id?: string; eyebrow: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mx-auto max-w-6xl px-6 py-24">
      <Reveal className="mb-12 max-w-2xl">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">{eyebrow}</p>
        <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h2>
      </Reveal>
      {children}
    </section>
  );
}

function Feat({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <div>
        <h3 className="font-semibold">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{children}</p>
      </div>
    </li>
  );
}


"use client";

import * as React from "react";
import { AlertTriangle, RotateCcw, TrendingUp } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

const DEFAULTS = { budget: 0.5, rootPrice: 0.1, childPrice: 0.02, children: 3, attribution: 20 };

export default function PlaygroundPage() {
  const [budget, setBudget] = React.useState(DEFAULTS.budget);
  const [rootPrice, setRootPrice] = React.useState(DEFAULTS.rootPrice);
  const [childPrice, setChildPrice] = React.useState(DEFAULTS.childPrice);
  const [children, setChildren] = React.useState(DEFAULTS.children);
  const [attribution, setAttribution] = React.useState(DEFAULTS.attribution);

  const childrenTotal = children * childPrice;
  const attrAmount = childrenTotal * (attribution / 100);
  const grossSpend = rootPrice + childrenTotal;
  const exceeded = grossSpend > budget + 1e-9;
  const remaining = Math.max(0, budget - grossSpend);
  const rootEarnings = rootPrice + attrAmount;
  const childEarning = childPrice * (1 - attribution / 100);
  const spendPct = Math.min(100, (grossSpend / budget) * 100);

  const reset = () => {
    setBudget(DEFAULTS.budget);
    setRootPrice(DEFAULTS.rootPrice);
    setChildPrice(DEFAULTS.childPrice);
    setChildren(DEFAULTS.children);
    setAttribution(DEFAULTS.attribution);
  };

  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <Badge variant="outline" className="mb-3 border-primary/30 font-mono text-[11px] text-primary">
              interactive
            </Badge>
            <h1 className="text-3xl font-semibold tracking-tight">Cascade playground</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Model a budget-bounded cascade the way <span className="font-mono text-foreground">CascadeController</span> enforces
              it on-chain. Move the sliders and watch payouts, recursive attribution up the tree, and the on-chain{" "}
              <span className="text-foreground">budget rejection</span> react live.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={reset} className="gap-1.5">
            <RotateCcw className="h-3.5 w-3.5" /> Reset
          </Button>
        </div>

        <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
          {/* Controls */}
          <Card className="h-fit">
            <CardHeader>
              <CardTitle className="text-base">Parameters</CardTitle>
              <CardDescription>The agent opens the cascade with one budget.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <Control label="Cascade budget" value={usd(budget)} min={0.05} max={2} step={0.05} v={budget} set={setBudget} accent />
              <Separator />
              <Control label="Root tool price" value={usd(rootPrice)} min={0.02} max={0.4} step={0.01} v={rootPrice} set={setRootPrice} />
              <Control label="Downstream tool price" value={usd(childPrice)} min={0.01} max={0.15} step={0.01} v={childPrice} set={setChildPrice} />
              <Control label="Downstream hops" value={`${children}`} min={1} max={6} step={1} v={children} set={setChildren} />
              <Control label="Attribution to parent" value={`${attribution}%`} min={0} max={40} step={5} v={attribution} set={setAttribution} />
            </CardContent>
          </Card>

          {/* Visualization + ledger */}
          <div className="space-y-6">
            <Card className={cn("transition-colors", exceeded && "border-destructive/50")}>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle className="text-base">Payment tree</CardTitle>
                  <CardDescription>Agent → root tool → {children} downstream tool{children > 1 ? "s" : ""}.</CardDescription>
                </div>
                <Badge variant={exceeded ? "destructive" : "success"} className="gap-1.5">
                  {exceeded ? <AlertTriangle className="h-3 w-3" /> : <TrendingUp className="h-3 w-3" />}
                  {exceeded ? "budget exceeded" : "within budget"}
                </Badge>
              </CardHeader>
              <CardContent>
                <CascadeTree
                  n={children}
                  rootPrice={rootPrice}
                  childPrice={childPrice}
                  attrPct={attribution}
                  exceeded={exceeded}
                />
              </CardContent>
            </Card>

            {/* Budget bar */}
            <Card>
              <CardContent className="pt-6">
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Spent of budget</span>
                  <span className="font-mono tabular-nums">
                    {usd(grossSpend)} <span className="text-muted-foreground">/ {usd(budget)}</span>
                  </span>
                </div>
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-secondary">
                  <div
                    className={cn("h-full rounded-full transition-all", exceeded ? "bg-destructive" : "bg-primary")}
                    style={{ width: `${spendPct}%` }}
                  />
                </div>
                {exceeded ? (
                  <p className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 font-mono text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      User error 5 · <span className="font-semibold">BudgetExceeded</span>. The contract rejects the hop that
                      would overspend. The gateway can&apos;t settle it; the agent must adapt.
                    </span>
                  </p>
                ) : (
                  <p className="mt-3 font-mono text-xs text-muted-foreground">
                    close() refunds the unspent{" "}
                    <span className="text-success">{usd(remaining)}</span> to the agent.
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Ledger */}
            <div className="grid gap-4 sm:grid-cols-3">
              <Stat label="Root payee earns" value={usd(rootEarnings)} sub={`price ${usd(rootPrice)} + ${usd(attrAmount)} attribution`} />
              <Stat label="Each downstream earns" value={usd(childEarning)} sub={`${usd(childPrice)} − ${attribution}% up-flow`} />
              <Stat label="Gross settled" value={usd(grossSpend)} sub={`${children + 1} on-chain hops`} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function Control({
  label,
  value,
  min,
  max,
  step,
  v,
  set,
  accent,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  step: number;
  v: number;
  set: (n: number) => void;
  accent?: boolean;
}) {
  return (
    <div>
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        <span className={cn("font-mono text-sm tabular-nums", accent ? "text-primary" : "text-muted-foreground")}>{value}</span>
      </div>
      <Slider min={min} max={max} step={step} value={[v]} onValueChange={([n]) => set(n ?? min)} />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-primary">{value}</div>
      <div className="mt-1 font-mono text-[11px] text-muted-foreground/70">{sub}</div>
    </div>
  );
}

/** Dynamic cascade tree that redraws for N children with live payouts + up-flow attribution. */
function CascadeTree({
  n,
  rootPrice,
  childPrice,
  attrPct,
  exceeded,
}: {
  n: number;
  rootPrice: number;
  childPrice: number;
  attrPct: number;
  exceeded: boolean;
}) {
  const W = 640;
  const H = 300;
  const agent = { x: 40, y: H / 2 };
  const root = { x: 210, y: H / 2 };
  const childX = 470;
  const gap = n > 1 ? Math.min(78, (H - 60) / (n - 1)) : 0;
  const startY = H / 2 - (gap * (n - 1)) / 2;
  const kids = Array.from({ length: n }, (_, i) => ({ x: childX, y: startY + gap * i }));
  const stroke = exceeded ? "hsl(var(--destructive))" : "hsl(var(--primary))";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
      <defs>
        <filter id="pgGlow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* agent → root */}
      <path d={`M ${agent.x + 66} ${agent.y} L ${root.x - 4} ${root.y}`} fill="none" stroke="hsl(var(--border))" strokeWidth="2" />
      <path d={`M ${agent.x + 66} ${agent.y} L ${root.x - 4} ${root.y}`} fill="none" stroke={stroke} strokeWidth="2" strokeDasharray="5 12" strokeLinecap="round" className="animate-flow-dash" />

      {/* root → children (+ attribution up-flow) */}
      {kids.map((k, i) => {
        const d = `M ${root.x + 96} ${root.y} C ${root.x + 150} ${root.y}, ${childX - 54} ${k.y}, ${childX - 4} ${k.y}`;
        return (
          <g key={i}>
            <path d={d} fill="none" stroke="hsl(var(--border))" strokeWidth="2" />
            <path d={d} fill="none" stroke={stroke} strokeWidth="2" strokeDasharray="5 12" strokeLinecap="round" className="animate-flow-dash" style={{ animationDelay: `${i * 0.25}s` }} />
            {attrPct > 0 && (
              <path d={d} fill="none" stroke="hsl(var(--flow))" strokeWidth="1.5" strokeDasharray="2 10" strokeLinecap="round" className="animate-flow-dash" style={{ animationDirection: "reverse", animationDelay: `${i * 0.25}s`, opacity: 0.75 }} />
            )}
          </g>
        );
      })}

      {/* agent node */}
      <g>
        <rect x={agent.x} y={agent.y - 18} width={66} height={36} rx="9" fill="hsl(var(--card))" stroke="hsl(var(--flow))" strokeWidth="1.5" />
        <text x={agent.x + 33} y={agent.y + 4} textAnchor="middle" className="fill-foreground" fontSize="11" fontWeight="600" fontFamily="var(--font-geist-mono)">agent</text>
      </g>

      {/* root node */}
      <g>
        <rect x={root.x} y={root.y - 24} width={96} height={48} rx="10" fill="hsl(var(--card))" stroke={stroke} strokeWidth="1.5" />
        <circle cx={root.x + 14} cy={root.y - 8} r="3" fill={stroke} filter="url(#pgGlow)" />
        <text x={root.x + 24} y={root.y - 4} className="fill-foreground" fontSize="10.5" fontWeight="600" fontFamily="var(--font-geist-mono)">root</text>
        <text x={root.x + 48} y={root.y + 14} textAnchor="middle" fill={exceeded ? "hsl(var(--destructive))" : "hsl(var(--primary))"} fontSize="11" fontWeight="600" fontFamily="var(--font-geist-mono)">{usd(rootPrice)}</text>
      </g>

      {/* child nodes */}
      {kids.map((k, i) => (
        <g key={i}>
          <rect x={k.x} y={k.y - 16} width={130} height={32} rx="9" fill="hsl(var(--card))" stroke="hsl(var(--border))" strokeWidth="1.5" />
          <circle cx={k.x + 12} cy={k.y} r="2.5" fill={stroke} />
          <text x={k.x + 22} y={k.y + 4} className="fill-muted-foreground" fontSize="10" fontFamily="var(--font-geist-mono)">tool_{i + 1}</text>
          <text x={k.x + 118} y={k.y + 4} textAnchor="end" fill="hsl(var(--primary))" fontSize="10" fontWeight="600" fontFamily="var(--font-geist-mono)">{usd(childPrice)}</text>
        </g>
      ))}

      {attrPct > 0 && (
        <text x={childX - 30} y={20} textAnchor="middle" fill="hsl(var(--flow))" fontSize="10" fontFamily="var(--font-geist-mono)">
          ← {attrPct}% attribution up
        </text>
      )}
    </svg>
  );
}

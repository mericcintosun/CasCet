"use client";

import * as React from "react";
import { Boxes, GitBranch, LayoutDashboard, Plug, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Step = { key: string; icon: LucideIcon; title: string; body: string; cmd: string };

const STEPS: Step[] = [
  { key: "wrap", icon: Boxes, title: "Wrap", cmd: "cascet wrap", body: "Put a paywall in front of any MCP server. Price each tool; agents pay per call in CEP-18 over x402. Your tool code stays untouched." },
  { key: "connect", icon: Plug, title: "Connect", cmd: "cascet connect", body: "A stdio bridge lets any MCP host — Claude, Cursor — call paid servers, answering every 402 challenge automatically under a spending budget." },
  { key: "cascade", icon: GitBranch, title: "Cascade", cmd: "→ on-chain", body: "When a paid tool buys from other paid tools, CasCet links every hop to its parent and enforces the budget and revenue splits on-chain." },
  { key: "see", icon: LayoutDashboard, title: "See it", cmd: "/dashboard", body: "A live dashboard streams revenue, receipts with cspr.live settlement links, and the cascading payment graph in real time." },
];

export function Steps() {
  const [active, setActive] = React.useState(0);
  const step = STEPS[active]!;
  const Icon = step.icon;

  return (
    <div>
      {/* clickable rail */}
      <div className="relative flex flex-col gap-2 sm:flex-row sm:gap-0">
        <div className="absolute left-0 right-0 top-1/2 hidden h-px -translate-y-1/2 bg-border sm:block" />
        <div
          className="absolute left-0 top-1/2 hidden h-px -translate-y-1/2 bg-primary transition-all duration-500 sm:block"
          style={{ width: `${(active / (STEPS.length - 1)) * 100}%` }}
        />
        {STEPS.map((s, i) => {
          const on = i <= active;
          const cur = i === active;
          return (
            <button
              key={s.key}
              onClick={() => setActive(i)}
              className="group relative z-10 flex flex-1 items-center gap-3 bg-background/0 py-1 text-left sm:flex-col sm:items-center sm:gap-3 sm:bg-background sm:px-2"
            >
              <span
                className={cn(
                  "flex h-11 w-11 items-center justify-center rounded-full border transition-all duration-300",
                  cur
                    ? "scale-110 border-primary bg-primary text-primary-foreground shadow-[0_0_24px_-4px_hsl(var(--primary)/0.6)]"
                    : on
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border bg-card text-muted-foreground group-hover:border-primary/40 group-hover:text-foreground",
                )}
              >
                <s.icon className="h-5 w-5" />
              </span>
              <span className={cn("text-sm font-medium transition-colors", cur ? "text-foreground" : "text-muted-foreground group-hover:text-foreground")}>
                {s.title}
              </span>
            </button>
          );
        })}
      </div>

      {/* detail — animates on change via keyed fade */}
      <div key={active} className="mt-12 grid animate-fade-in items-center gap-8 md:grid-cols-[auto_1fr]">
        <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
          <Icon className="h-9 w-9" />
        </div>
        <div>
          <div className="flex items-center gap-3">
            <h3 className="text-2xl font-semibold tracking-tight">{step.title}</h3>
            <code className="rounded bg-secondary px-2 py-0.5 font-mono text-xs text-primary">{step.cmd}</code>
          </div>
          <p className="mt-3 max-w-xl text-pretty leading-relaxed text-muted-foreground">{step.body}</p>
        </div>
      </div>
    </div>
  );
}

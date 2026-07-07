import { cn } from "@/lib/utils";

/**
 * The signature hero visual: an agent pays a root tool, which cascades payments to three
 * downstream paid tools. Pure SVG with animated flow lines (no WebGL): the payment graph is
 * CasCet's brand asset.
 */
export function CascadeFlow({ className }: { className?: string }) {
  const root = { x: 232, y: 150, w: 154, h: 74 };
  const children = [
    { label: "get_cspr_market_data", price: "$0.01", y: 44 },
    { label: "get_rwa_price", price: "$0.02", y: 154 },
    { label: "get_defi_yields", price: "$0.02", y: 264 },
  ];
  const rootCx = root.x + root.w;
  const rootCy = root.y + root.h / 2;

  return (
    <svg viewBox="0 0 620 352" className={cn("h-full w-full", className)} role="img" aria-label="Cascading payment graph">
      <defs>
        <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="3.5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <linearGradient id="flowGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="hsl(var(--primary))" />
          <stop offset="100%" stopColor="hsl(var(--flow))" />
        </linearGradient>
      </defs>

      {/* agent → root */}
      <FlowLine d="M 148 176 L 232 187" />
      {/* root → children */}
      {children.map((c, i) => (
        <FlowLine key={i} d={`M ${rootCx} ${rootCy} C ${rootCx + 46} ${rootCy}, ${470 - 46} ${c.y + 26}, 470 ${c.y + 26}`} delay={i * 0.35} />
      ))}

      {/* agent node */}
      <Node x={16} y={152} w={132} h={50} accent title="AI agent" sub="pays x402" />
      {/* root node (the composing tool) */}
      <g>
        <rect x={root.x} y={root.y} width={root.w} height={root.h} rx="12" fill="hsl(var(--card))" stroke="hsl(var(--primary))" strokeWidth="1.5" />
        <circle cx={root.x + 16} cy={root.y + 18} r="3.5" fill="hsl(var(--primary))" filter="url(#glow)" />
        <text x={root.x + 28} y={root.y + 22} className="fill-foreground" fontSize="12.5" fontWeight="600" fontFamily="var(--font-geist-mono)">analyze_portfolio</text>
        <text x={root.x + 14} y={root.y + 44} className="fill-muted-foreground" fontSize="10.5" fontFamily="var(--font-geist-mono)">buys 3 tools ↓</text>
        <text x={root.x + root.w - 14} y={root.y + 44} textAnchor="end" fill="hsl(var(--primary))" fontSize="11" fontWeight="600" fontFamily="var(--font-geist-mono)">$0.10</text>
      </g>

      {/* child nodes */}
      {children.map((c, i) => (
        <Node key={i} x={470} y={c.y} w={140} h={52} title={c.label} price={c.price} />
      ))}
    </svg>
  );
}

function FlowLine({ d, delay = 0 }: { d: string; delay?: number }) {
  return (
    <>
      <path d={d} fill="none" stroke="hsl(var(--border))" strokeWidth="2" />
      <path
        d={d}
        fill="none"
        stroke="url(#flowGrad)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="6 14"
        className="animate-flow-dash"
        style={{ animationDelay: `${delay}s` }}
      />
    </>
  );
}

function Node({
  x,
  y,
  w,
  h,
  title,
  sub,
  price,
  accent,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  price?: string;
  accent?: boolean;
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx="11" fill="hsl(var(--card))" stroke={accent ? "hsl(var(--flow))" : "hsl(var(--border))"} strokeWidth="1.5" />
      <circle cx={x + 14} cy={y + 17} r="3" fill={accent ? "hsl(var(--flow))" : "hsl(var(--primary))"} filter="url(#glow)" />
      <text x={x + 26} y={y + 21} className="fill-foreground" fontSize="11.5" fontWeight="600" fontFamily="var(--font-geist-mono)">{title.length > 16 ? title.slice(0, 15) + "…" : title}</text>
      {sub && <text x={x + 14} y={y + 40} className="fill-muted-foreground" fontSize="10" fontFamily="var(--font-geist-mono)">{sub}</text>}
      {price && <text x={x + w - 14} y={y + 40} textAnchor="end" fill="hsl(var(--primary))" fontSize="10.5" fontWeight="600" fontFamily="var(--font-geist-mono)">{price}</text>}
    </g>
  );
}

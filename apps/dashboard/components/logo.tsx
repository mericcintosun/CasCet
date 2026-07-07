import { cn } from "@/lib/utils";

/** CasCet mark: a cascading payment tree (one node branching into three). */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={cn("h-full w-full", className)} aria-hidden>
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M16 8V13" />
        <path d="M16 13C16 16 9 16 9 20" />
        <path d="M16 13C16 16 23 16 23 20" />
      </g>
      <g fill="currentColor">
        <circle cx="16" cy="6" r="3" />
        <circle cx="9" cy="24" r="3" />
        <circle cx="16" cy="24" r="3" />
        <circle cx="23" cy="24" r="3" />
      </g>
    </svg>
  );
}

/** Full lockup: mark + wordmark. */
export function Logo({ className, subtitle }: { className?: string; subtitle?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 p-1.5 text-primary ring-1 ring-primary/25">
        <LogoMark />
      </span>
      <span className="leading-none">
        <span className="block text-[15px] font-semibold tracking-tight">CasCet</span>
        {subtitle && <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">{subtitle}</span>}
      </span>
    </span>
  );
}

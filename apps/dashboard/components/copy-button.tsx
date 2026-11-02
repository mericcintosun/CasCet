"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Copies `text` to the clipboard and flips to a check for a moment. `disabled`
 * blocks copying output that must not leave the page yet (`disabledReason`
 * says why, as the tooltip and in the accessible name).
 */
export function CopyButton({
  text,
  className,
  disabled = false,
  disabledReason,
}: {
  text: string;
  className?: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    if (disabled) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      aria-label={
        disabled ? `Copy unavailable${disabledReason ? `: ${disabledReason}` : ""}` : copied ? "Copied" : "Copy to clipboard"
      }
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/40 text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border/70 disabled:hover:text-muted-foreground",
        className,
      )}
    >
      {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
    </button>
  );
}

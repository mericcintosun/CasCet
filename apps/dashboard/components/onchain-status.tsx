"use client";

import { Activity, CircleAlert, Loader2, RotateCw, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { OnchainStatus } from "@/lib/onchain";

const BADGE: Record<OnchainStatus, { variant: "secondary" | "success" | "warning" | "destructive"; label: string; title: string }> = {
  loading: { variant: "secondary", label: "connecting…", title: "Reading the testnet ReceiptRegistry" },
  live: { variant: "success", label: "live", title: "The last read of the testnet ReceiptRegistry succeeded" },
  degraded: { variant: "warning", label: "stale", title: "The last refresh failed; showing the previous read" },
  error: { variant: "destructive", label: "offline", title: "The on-chain receipts could not be read" },
};

/** Header badge for the on-chain receipt feed: never "live" unless the last read succeeded. */
export function OnchainStatusBadge({ status }: { status: OnchainStatus }) {
  const b = BADGE[status];
  const Icon = status === "loading" ? Loader2 : status === "live" ? Activity : status === "degraded" ? TriangleAlert : CircleAlert;
  return (
    <Badge variant={b.variant} className="gap-1.5 whitespace-nowrap" title={b.title} aria-live="polite">
      <Icon className={status === "loading" ? "h-3 w-3 animate-spin" : "h-3 w-3"} aria-hidden />
      {b.label}
    </Badge>
  );
}

const timeOf = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * The error/degraded banner. In "error" there is no data at all, so the page
 * must not render zeros as if the economy were empty; in "degraded" the last
 * good read stays on screen, labelled as such.
 */
export function OnchainProblem({
  status,
  error,
  updatedAt,
  onRetry,
}: {
  status: OnchainStatus;
  error: string | null;
  updatedAt: number | null;
  onRetry: () => void;
}) {
  if (status === "error") {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertTitle>Could not read the on-chain receipts</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>
            The testnet ReceiptRegistry feed is unavailable{error ? `: ${error}` : ""}. Nothing below is shown until a
            read succeeds, so an outage is never mistaken for an empty economy.
          </p>
          <Button size="sm" variant="outline" onClick={onRetry} className="gap-1.5">
            <RotateCw className="h-3.5 w-3.5" /> Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (status === "degraded") {
    return (
      <Alert variant="warning" role="status">
        <TriangleAlert />
        <AlertTitle>Showing the last successful read{updatedAt ? ` (${timeOf(updatedAt)})` : ""}</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>The latest refresh failed{error ? `: ${error}` : ""}.</span>
          <Button size="sm" variant="outline" onClick={onRetry} className="gap-1.5">
            <RotateCw className="h-3.5 w-3.5" /> Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return null;
}

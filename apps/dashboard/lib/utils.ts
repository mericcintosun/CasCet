import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Parse raw token units to bigint without ever throwing — a malformed value
 * (from any data source) degrades to 0n instead of crashing the render.
 */
export function toBigIntSafe(raw: string | bigint | undefined | null): bigint {
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return BigInt(raw);
  return 0n;
}

/** Format raw CEP-18 token units into a human token amount string. */
export function formatTokens(raw: string | bigint, decimals = 9, symbol = "WCSPR"): string {
  const value = toBigIntSafe(raw);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 4);
  return `${whole.toString()}${fracStr ? `.${fracStr}` : ""} ${symbol}`;
}

/** Shorten a hex key/hash for display. */
export function shortHex(hex: string, head = 6, tail = 4): string {
  if (!hex || hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

export function timeAgo(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const secs = Math.max(0, Math.floor((now - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 86_400 * 60) return `${Math.floor(secs / 86_400)}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

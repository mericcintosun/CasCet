import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CascetEvent, PaymentReceipt } from "@cascet/core";
import { log, logSafe } from "./log.js";

/**
 * Append-only JSONL receipt store with an in-memory index.
 *
 * A receipt can be written more than once (for example when its on-chain
 * anchor lands after the payment settled); the log keeps every version and the
 * last line for an id wins when the file is loaded again.
 */
export class ReceiptStore {
  private readonly receipts = new Map<string, PaymentReceipt>();

  constructor(private readonly filePath: string) {
    if (existsSync(filePath)) {
      for (const line of readFileSync(filePath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const receipt = JSON.parse(line) as PaymentReceipt;
          if (receipt && typeof receipt.id === "string") this.receipts.set(receipt.id, receipt);
        } catch {
          // skip a corrupt line
        }
      }
    } else {
      mkdirSync(dirname(filePath), { recursive: true });
    }
  }

  add(receipt: PaymentReceipt): void {
    this.receipts.set(receipt.id, receipt);
    appendFileSync(this.filePath, `${JSON.stringify(receipt)}\n`);
  }

  /** Persist a new version of a receipt that was already added. */
  update(receipt: PaymentReceipt): void {
    this.add(receipt);
  }

  list(): PaymentReceipt[] {
    return [...this.receipts.values()];
  }
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Whether a URL hostname names this machine. */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase()) || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/** Headers of an ingest push: the bearer token only over https or to this machine. */
export function ingestHeaders(url: URL, token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token && (url.protocol === "https:" || isLoopbackHostname(url.hostname))) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Fire-and-forget event push to the dashboard ingest endpoint. The ingest
 * bearer token (CASCET_INGEST_TOKEN) is only sent over https or to this
 * machine, never in clear text across a network.
 */
export function makeEventPusher(
  eventsUrl?: string,
  token: string | undefined = process.env.CASCET_INGEST_TOKEN,
): (event: CascetEvent) => void {
  if (!eventsUrl) return () => {};
  const url = new URL(eventsUrl);
  const headers = ingestHeaders(url, token);
  if (token && !headers.authorization) {
    log.warn(`[events] not sending CASCET_INGEST_TOKEN to ${logSafe(url.origin)} over plain http; use https for a remote dashboard`);
  }
  return event => {
    fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {
      // dashboard being down must never break payments
    });
  };
}

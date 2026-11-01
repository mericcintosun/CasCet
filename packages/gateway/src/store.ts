import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CascetEvent, PaymentReceipt } from "@cascet/core";
import { log, logSafe } from "./log.js";

/**
 * Write-ahead record of a paid call that is about to run. It is appended after
 * the facilitator verified the authorization and before the tool runs or the
 * payment settles, so a restarted gateway still refuses that authorization
 * even if the process died before the call's receipt was written.
 */
export interface AuthorizationRecord {
  kind: "authorization";
  /** Payer account: "00" + account hash, as the gateway parsed it from the authorization. */
  payer: string;
  /** Authorization nonce, 64 lowercase hex. */
  nonce: string;
  /** Unix seconds; after this the token refuses the authorization anyway. */
  validBefore: number;
  /** Payment id of the call (its receipt carries the same id). */
  paymentId: string;
  tool: string;
  createdAt: string;
}

/** Loaded authorization records older than this past their validBefore are dropped. */
const AUTHORIZATION_RETENTION_SECONDS = 3_600;

function isAuthorizationRecord(value: unknown): value is AuthorizationRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r.kind === "authorization" &&
    typeof r.payer === "string" &&
    typeof r.nonce === "string" &&
    typeof r.validBefore === "number" &&
    Number.isFinite(r.validBefore)
  );
}

/**
 * Append-only JSONL receipt store with an in-memory index.
 *
 * A receipt can be written more than once (for example when its on-chain
 * anchor lands after the payment settled); the log keeps every version and the
 * last line for an id wins when the file is loaded again. The same log holds
 * the write-ahead authorization records (lines with `kind: "authorization"`
 * and no `id`, which older loaders skip).
 */
export class ReceiptStore {
  private readonly receipts = new Map<string, PaymentReceipt>();
  private readonly loadedAuthorizations: AuthorizationRecord[] = [];

  constructor(
    private readonly filePath: string,
    now: () => number = Date.now,
  ) {
    if (existsSync(filePath)) {
      const oldest = Math.floor(now() / 1_000) - AUTHORIZATION_RETENTION_SECONDS;
      for (const line of readFileSync(filePath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          continue; // skip a corrupt line
        }
        if (isAuthorizationRecord(value)) {
          if (value.validBefore >= oldest) this.loadedAuthorizations.push(value);
        } else if (typeof value === "object" && value !== null && typeof (value as PaymentReceipt).id === "string") {
          const receipt = value as PaymentReceipt;
          this.receipts.set(receipt.id, receipt);
        }
      }
    } else {
      mkdirSync(dirname(filePath), { recursive: true });
    }
  }

  /** Add a receipt. It is indexed in memory even when writing the log throws. */
  add(receipt: PaymentReceipt): void {
    this.receipts.set(receipt.id, receipt);
    appendFileSync(this.filePath, `${JSON.stringify(receipt)}\n`);
  }

  /** Persist a new version of a receipt that was already added. */
  update(receipt: PaymentReceipt): void {
    this.add(receipt);
  }

  /** Append a write-ahead authorization record. Throws when the log cannot be written. */
  appendAuthorization(record: AuthorizationRecord): void {
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`);
  }

  list(): PaymentReceipt[] {
    return [...this.receipts.values()];
  }

  /** Authorization records found in the log at startup (recent ones only). */
  authorizations(): AuthorizationRecord[] {
    return [...this.loadedAuthorizations];
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

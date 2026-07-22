import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CascetEvent, PaymentReceipt } from "@cascet/core";

/** Append-only JSONL receipt store with an in-memory index. */
export class ReceiptStore {
  private receipts: PaymentReceipt[] = [];

  constructor(private readonly filePath: string) {
    if (existsSync(filePath)) {
      for (const line of readFileSync(filePath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.receipts.push(JSON.parse(line) as PaymentReceipt);
        } catch {
          // skip corrupt line
        }
      }
    } else {
      mkdirSync(dirname(filePath), { recursive: true });
    }
  }

  add(receipt: PaymentReceipt): void {
    this.receipts.push(receipt);
    appendFileSync(this.filePath, `${JSON.stringify(receipt)}\n`);
  }

  list(): PaymentReceipt[] {
    return [...this.receipts];
  }
}

/** Fire-and-forget event push to the dashboard ingest endpoint. */
export function makeEventPusher(eventsUrl?: string): (event: CascetEvent) => void {
  if (!eventsUrl) return () => {};
  // The dashboard's /ingest requires this bearer token on public deployments.
  const token = process.env.CASCET_INGEST_TOKEN;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return event => {
    fetch(eventsUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(event),
    }).catch(() => {
      // dashboard being down must never break payments
    });
  };
}

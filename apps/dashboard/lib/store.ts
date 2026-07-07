import type { CascetEvent, PaymentReceipt } from "@cascet/core";

/**
 * Process-wide in-memory store for the demo dashboard. Gateways POST events to
 * /api/ingest; browsers subscribe to /api/stream (SSE). A real deployment would
 * back this with the on-chain ReceiptRegistry + an indexer, but for the live
 * demo an in-memory ring is instant and dependency-free.
 *
 * Kept on globalThis so it survives Next.js dev hot-reloads / route module
 * boundaries within the same server process.
 */
interface ServerInfo {
  name: string;
  tools: Array<{ name: string; priceUsd?: string }>;
  online: boolean;
  lastSeen: string;
}

interface Store {
  receipts: PaymentReceipt[];
  servers: Map<string, ServerInfo>;
  subscribers: Set<(event: CascetEvent) => void>;
}

const g = globalThis as unknown as { __cascetStore?: Store };

export function getStore(): Store {
  if (!g.__cascetStore) {
    g.__cascetStore = { receipts: [], servers: new Map(), subscribers: new Set() };
  }
  return g.__cascetStore;
}

export function ingest(event: CascetEvent): void {
  const store = getStore();
  switch (event.type) {
    case "receipt": {
      store.receipts.unshift(event.receipt);
      if (store.receipts.length > 500) store.receipts.pop();
      break;
    }
    case "server-online": {
      store.servers.set(event.server, {
        name: event.server,
        tools: event.tools,
        online: true,
        lastSeen: new Date().toISOString(),
      });
      break;
    }
    case "server-offline": {
      const info = store.servers.get(event.server);
      if (info) info.online = false;
      break;
    }
  }
  for (const notify of store.subscribers) notify(event);
}

export function subscribe(fn: (event: CascetEvent) => void): () => void {
  const store = getStore();
  store.subscribers.add(fn);
  return () => store.subscribers.delete(fn);
}

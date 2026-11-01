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
      // Dedupe by id: a receipt is pushed once on settle, then again once its
      // on-chain anchor tx lands — the second push updates the same row.
      const existing = store.receipts.findIndex(r => r.id === event.receipt.id);
      if (existing >= 0) {
        store.receipts[existing] = event.receipt;
      } else {
        store.receipts.unshift(event.receipt);
        if (store.receipts.length > 500) store.receipts.pop();
      }
      break;
    }
    case "server-online": {
      // Bounded and sanitised: the event comes over the network (I42).
      if (!store.servers.has(event.server) && store.servers.size >= MAX_SERVERS) break;
      store.servers.set(event.server.slice(0, 128), {
        name: event.server.slice(0, 128),
        tools: sanitizeTools(event.tools),
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

const MAX_SERVERS = 100;
const MAX_TOOLS = 200;

function sanitizeTools(tools: unknown): ServerInfo["tools"] {
  if (!Array.isArray(tools)) return [];
  const out: ServerInfo["tools"] = [];
  for (const t of tools.slice(0, MAX_TOOLS)) {
    if (typeof t !== "object" || t === null) continue;
    const { name, priceUsd } = t as { name?: unknown; priceUsd?: unknown };
    if (typeof name !== "string" || !name) continue;
    out.push({ name: name.slice(0, 128), ...(typeof priceUsd === "string" ? { priceUsd: priceUsd.slice(0, 32) } : {}) });
  }
  return out;
}

export function subscribe(fn: (event: CascetEvent) => void): () => void {
  const store = getStore();
  store.subscribers.add(fn);
  return () => store.subscribers.delete(fn);
}

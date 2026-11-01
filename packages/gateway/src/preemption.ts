/**
 * Settlement preemption check (arXiv 2605.11781).
 *
 * A signed transfer authorization can be submitted by anyone. If someone else
 * executes it before this gateway's facilitator does, the facilitator's settle
 * reverts because the nonce is used, although the seller was paid. Refusing
 * the buyer then is wrong.
 *
 * "The nonce is used" alone is NOT proof of payment: the payer can burn the
 * nonce with `cancel_authorization`, or sign a second authorization with the
 * same nonce to another recipient and submit that one first. So this check
 * reads the token's CES events and only reports `paid` when it finds
 * `AuthorizationUsed(from, nonce)` immediately followed by `Transfer(from →
 * payTo, value)`. Both events are written by one `transfer_with_authorization`
 * execution, in that order, with nothing in between (verified on the CasCet
 * x402 token on testnet and mainnet), so the pair identifies exactly this
 * authorization's transfer.
 *
 * Read-only: chain_get_state_root_hash, query_global_state and
 * state_get_dictionary_item against one state root.
 */

import { latestContractHash, type ContractPackageJson } from "./token-probe.js";

export interface PreemptionQuery {
  /** Payer address, "00" + account hash. */
  payer: string;
  /** Authorization nonce, 64 hex. */
  nonce: string;
  /** Expected payee address ("00"/"01" + 64 hex). */
  payTo: string;
  /** Expected raw amount, decimal string. */
  amount: string;
}

export type PreemptionOutcome =
  /** This exact authorization executed and paid `amount` to `payTo`. */
  | { kind: "paid"; eventIndex: number }
  /** The payer canceled the nonce on-chain: this authorization can never execute. */
  | { kind: "canceled"; eventIndex: number }
  /** The nonce was used by an authorization that did not pay `amount` to `payTo`. */
  | { kind: "consumed-elsewhere"; eventIndex: number; detail: string }
  /** No event for this (payer, nonce) among the scanned events. */
  | { kind: "not-found"; scanned: number };

export interface SettlementPreemptionChecker {
  check(query: PreemptionQuery): Promise<PreemptionOutcome>;
}

export interface CesCheckerOptions {
  /** Casper node JSON-RPC endpoint. */
  nodeUrl: string;
  /** CEP-18 x402 token contract package hash (with or without "hash-"). */
  tokenPackageHash: string;
  /** Number of most recent events to scan. */
  scanWindow: number;
  /** Budget for one whole check. */
  timeoutMs?: number;
  /** Parallel dictionary reads per round. */
  batchSize?: number;
  fetchImpl?: typeof fetch;
}

interface CesKey {
  tag: number;
  hash: string;
}

export type CesEvent =
  | { name: "AuthorizationUsed" | "AuthorizationCanceled"; authorizer: CesKey; nonce: string }
  | { name: "Transfer"; sender: CesKey; recipient: CesKey; amount: bigint }
  | { name: "Other"; rawName: string };

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  take(n: number): Uint8Array {
    if (n < 0 || this.offset + n > this.bytes.length) throw new RangeError("truncated");
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  u8(): number {
    return this.take(1)[0]!;
  }

  u32(): number {
    const b = this.take(4);
    return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
  }

  string(): string {
    const len = this.u32();
    if (len > 256) throw new RangeError("string too long");
    return new TextDecoder("utf-8", { fatal: true }).decode(this.take(len));
  }

  key(): CesKey {
    const tag = this.u8();
    // Account (0) and Hash (1) keys carry 32 bytes; other key kinds never match a payTo.
    if (tag !== 0 && tag !== 1) throw new RangeError(`unsupported key tag ${tag}`);
    return { tag, hash: toHex(this.take(32)) };
  }

  bytesList(): string {
    const len = this.u32();
    if (len > 1_024) throw new RangeError("byte list too long");
    return toHex(this.take(len));
  }

  u256(): bigint {
    const len = this.u8();
    if (len > 32) throw new RangeError("u256 too long");
    const b = this.take(len);
    let value = 0n;
    for (let i = b.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(b[i]!);
    return value;
  }
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Decode one CES event stored in a token's `__events` dictionary: the
 * dictionary value is a `List<U8>` CLValue whose bytes are a u32 length prefix
 * followed by the event: name string ("event_<Name>") then the fields.
 * Returns undefined for anything malformed.
 */
export function decodeCesEvent(clValueBytesHex: string): CesEvent | undefined {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(clValueBytesHex)) return undefined;
  try {
    const outer = new Reader(Buffer.from(clValueBytesHex, "hex"));
    const length = outer.u32();
    if (length !== outer.remaining) return undefined;
    const r = new Reader(outer.take(length));
    const rawName = r.string();
    switch (rawName) {
      case "event_AuthorizationUsed":
      case "event_AuthorizationCanceled": {
        const authorizer = r.key();
        const nonce = r.bytesList();
        if (r.remaining !== 0) return undefined;
        return { name: rawName === "event_AuthorizationUsed" ? "AuthorizationUsed" : "AuthorizationCanceled", authorizer, nonce };
      }
      case "event_Transfer": {
        const sender = r.key();
        const recipient = r.key();
        const amount = r.u256();
        if (r.remaining !== 0) return undefined;
        return { name: "Transfer", sender, recipient, amount };
      }
      default:
        return { name: "Other", rawName };
    }
  } catch {
    return undefined;
  }
}

function addressToKey(address: string): CesKey | undefined {
  const a = address.toLowerCase().replace(/^0x/, "");
  if (!/^(00|01)[0-9a-f]{64}$/.test(a)) return undefined;
  return { tag: a.startsWith("00") ? 0 : 1, hash: a.slice(2) };
}

const sameKey = (a: CesKey, b: CesKey): boolean => a.tag === b.tag && a.hash === b.hash;

class CasperRpc {
  private nextId = 1;
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch,
    private readonly signal: AbortSignal,
  ) {}

  async call<T>(method: string, params: unknown): Promise<T> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
      signal: this.signal,
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    const body = (await response.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
    if (body.error) {
      const err = new Error(`${method}: ${body.error.message}`) as Error & { rpcCode?: number; rpcData?: unknown };
      err.rpcCode = body.error.code;
      err.rpcData = body.error.data;
      throw err;
    }
    if (body.result === undefined) throw new Error(`${method}: empty result`);
    return body.result;
  }
}

function isNotFound(err: unknown): boolean {
  const data = (err as { rpcData?: unknown }).rpcData;
  return typeof data === "string" && /not found/i.test(data);
}

/** Preemption checker backed by a Casper node's JSON-RPC and the token's CES events. */
export function createCesPreemptionChecker(opts: CesCheckerOptions): SettlementPreemptionChecker {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const packageHex = opts.tokenPackageHash.toLowerCase().replace(/^hash-/, "");
  const batchSize = Math.max(1, opts.batchSize ?? 8);
  const timeoutMs = opts.timeoutMs ?? 15_000;

  return {
    async check(query: PreemptionQuery): Promise<PreemptionOutcome> {
      const payer = addressToKey(query.payer);
      const payTo = addressToKey(query.payTo);
      const nonce = query.nonce.toLowerCase().replace(/^0x/, "");
      if (!payer || !payTo || !/^[0-9a-f]{64}$/.test(nonce) || !/^\d+$/.test(query.amount)) {
        throw new Error("preemption check: malformed query");
      }
      const amount = BigInt(query.amount);
      const rpc = new CasperRpc(opts.nodeUrl, fetchImpl, AbortSignal.timeout(timeoutMs));

      const { state_root_hash: stateRoot } = await rpc.call<{ state_root_hash: string }>("chain_get_state_root_hash", {});
      const stateIdentifier = { StateRootHash: stateRoot };

      const pkg = await rpc.call<{ stored_value: { ContractPackage?: ContractPackageJson } }>(
        "query_global_state",
        { state_identifier: stateIdentifier, key: `hash-${packageHex}`, path: [] },
      );
      const contractPackage = pkg.stored_value.ContractPackage;
      if (!contractPackage) throw new Error("preemption check: token package is not a ContractPackage");
      // The newest enabled version; nodes list disabled versions as [major, version] pairs.
      const contractKey = `hash-${latestContractHash(contractPackage)}`;

      const lengthValue = await rpc.call<{ stored_value: { CLValue?: { parsed?: unknown } } }>("query_global_state", {
        state_identifier: stateIdentifier,
        key: contractKey,
        path: ["__events_length"],
      });
      const length = Number(lengthValue.stored_value.CLValue?.parsed);
      if (!Number.isInteger(length) || length < 0) throw new Error("preemption check: unreadable __events_length");

      const cache = new Map<number, CesEvent | undefined>();
      const readEvent = async (index: number): Promise<CesEvent | undefined> => {
        if (cache.has(index)) return cache.get(index);
        let event: CesEvent | undefined;
        try {
          const item = await rpc.call<{ stored_value: { CLValue?: { bytes?: string } } }>("state_get_dictionary_item", {
            state_root_hash: stateRoot,
            dictionary_identifier: {
              ContractNamedKey: { key: contractKey, dictionary_name: "__events", dictionary_item_key: String(index) },
            },
          });
          const bytes = item.stored_value.CLValue?.bytes;
          event = typeof bytes === "string" ? decodeCesEvent(bytes) : undefined;
        } catch (err) {
          if (!isNotFound(err)) throw err;
          event = undefined;
        }
        cache.set(index, event);
        return event;
      };

      const lowest = Math.max(0, length - opts.scanWindow);
      let scanned = 0;
      for (let top = length - 1; top >= lowest; top -= batchSize) {
        const indexes: number[] = [];
        for (let i = top; i > top - batchSize && i >= lowest; i--) indexes.push(i);
        const events = await Promise.all(indexes.map(readEvent));
        scanned += indexes.length;
        for (let j = 0; j < indexes.length; j++) {
          const event = events[j];
          const index = indexes[j]!;
          if (!event || (event.name !== "AuthorizationUsed" && event.name !== "AuthorizationCanceled")) continue;
          if (!sameKey(event.authorizer, payer) || event.nonce !== nonce) continue;
          if (event.name === "AuthorizationCanceled") return { kind: "canceled", eventIndex: index };
          const next = index + 1 < length ? await readEvent(index + 1) : undefined;
          if (!next || next.name !== "Transfer") {
            return { kind: "consumed-elsewhere", eventIndex: index, detail: "no transfer event follows the authorization" };
          }
          if (!sameKey(next.sender, payer)) {
            return { kind: "consumed-elsewhere", eventIndex: index, detail: "the following transfer is not from the payer" };
          }
          if (!sameKey(next.recipient, payTo)) {
            return { kind: "consumed-elsewhere", eventIndex: index, detail: "the authorization paid a different recipient" };
          }
          if (next.amount !== amount) {
            return { kind: "consumed-elsewhere", eventIndex: index, detail: `the authorization paid ${next.amount} instead of ${amount}` };
          }
          return { kind: "paid", eventIndex: index };
        }
      }
      return { kind: "not-found", scanned };
    },
  };
}

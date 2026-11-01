import { byteHash } from "casper-js-sdk";

/**
 * Read-only view of a deployed RevenueSplit: what each payee could release
 * right now (finding L124), computed exactly like the contract's `releasable`,
 * from its Odra storage and the token's CEP-18 balances over JSON-RPC. /withdraw
 * uses it so that the wallet does not pay ~5 CSPR of gas for a `release` that
 * reverts with NothingToRelease.
 *
 * Storage layout (Odra 2.x, contracts/src/revenue_split.rs):
 * - a module's fields live in its "state" dictionary under
 *   hex(blake2b256(u32_be(field index) ++ mapping key bytes)), field indices
 *   counted from 1 in declaration order: token Var<Address> (1), payees List
 *   (2), shares Mapping<Address, u32> (3), total_shares Var<u32> (4), released
 *   Mapping<Address, U256> (5), total_released Var<U256> (6);
 * - each value is a List<U8> CLValue that holds the field's bytesrepr bytes;
 * - the token (Odra's Cep18) keeps balances the CEP-18 way: dictionary
 *   "balances", item key base64(Key bytes), value a U256 CLValue.
 *
 * Everything read is checked against what the dashboard expects (the token
 * field must name the configured token, the shares must match the configured
 * payees), so a different layout becomes an error, never a wrong amount.
 */

export const SPLIT_FIELDS = { token: 1, shares: 3, totalShares: 4, released: 5, totalReleased: 6 } as const;

/** Why the split could not be read; `status` is what the API answers with. */
export class SplitReadError extends Error {
  override name = "SplitReadError";
  constructor(
    message: string,
    readonly status: 502 | 504,
  ) {
    super(message);
  }
}

const hexToBytes = (h: string): Uint8Array => {
  if (!/^(?:[0-9a-f]{2})*$/i.test(h)) throw new SplitReadError("malformed hex in an RPC answer", 502);
  return Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
};
const bytesToHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const bare = (h: string): string => h.trim().toLowerCase().replace(/^(?:account-hash-|hash-|contract-)/, "");

/** bytesrepr of an Odra Address, which is a Casper Key: Account (tag 0) or Hash, a contract package (tag 1). */
export function addressKeyBytes(kind: "account" | "contract", hash: string): Uint8Array {
  const h = bare(hash);
  if (!/^[0-9a-f]{64}$/.test(h)) throw new RangeError(`not a 32-byte hash: ${hash}`);
  return concat(Uint8Array.of(kind === "account" ? 0 : 1), hexToBytes(h));
}

/** Dictionary item key of a top-level Odra field (index 1-15), optionally of one mapping entry. */
export function odraStateKey(field: number, mappingKey: Uint8Array = new Uint8Array()): string {
  if (!Number.isInteger(field) || field < 1 || field > 15) throw new RangeError(`unsupported Odra field index ${field}`);
  const index = new Uint8Array(4);
  new DataView(index.buffer).setUint32(0, field, false);
  return bytesToHex(byteHash(concat(index, mappingKey)));
}

/** CEP-18 "balances" item key of an owner: base64 of its Key bytes. */
export function cep18BalanceKey(kind: "account" | "contract", hash: string): string {
  return btoa(String.fromCharCode(...addressKeyBytes(kind, hash)));
}

interface ClValue {
  cl_type?: unknown;
  bytes?: unknown;
}

/** The bytes an Odra field stores: a List<U8> CLValue is a u32 LE length followed by the bytes. */
export function odraValueBytes(value: unknown): Uint8Array {
  const v = value as ClValue | null;
  const isList = typeof v?.cl_type === "object" && v.cl_type !== null && (v.cl_type as { List?: unknown }).List === "U8";
  if (!isList || typeof v?.bytes !== "string") throw new SplitReadError("unexpected value type in the contract state", 502);
  const all = hexToBytes(v.bytes);
  if (all.length < 4) throw new SplitReadError("truncated value in the contract state", 502);
  const len = new DataView(all.buffer, all.byteOffset).getUint32(0, true);
  if (len !== all.length - 4) throw new SplitReadError("inconsistent value length in the contract state", 502);
  return all.slice(4);
}

export function decodeU32(b: Uint8Array): number {
  if (b.length !== 4) throw new SplitReadError("expected a u32", 502);
  return new DataView(b.buffer, b.byteOffset).getUint32(0, true);
}

/** bytesrepr U256: one length byte, then that many little-endian bytes. */
export function decodeU256(b: Uint8Array): bigint {
  const n = b[0];
  if (n === undefined || n > 32 || b.length !== n + 1) throw new SplitReadError("expected a U256", 502);
  let v = 0n;
  for (let i = n; i >= 1; i--) v = (v << 8n) | BigInt(b[i]!);
  return v;
}

export function decodeAddress(b: Uint8Array): { kind: "account" | "contract"; hash: string } {
  if (b.length !== 33 || (b[0] !== 0 && b[0] !== 1)) throw new SplitReadError("expected an address", 502);
  return { kind: b[0] === 0 ? "account" : "contract", hash: bytesToHex(b.slice(1)) };
}

/** The contract's `releasable`: (held + total released) × shares / total shares − released, never below zero. */
export function releasableOf(p: { heldRaw: bigint; totalReleasedRaw: bigint; shares: number; totalShares: number; releasedRaw: bigint }): bigint {
  if (p.shares === 0 || p.totalShares === 0) return 0n;
  const owed = ((p.heldRaw + p.totalReleasedRaw) * BigInt(p.shares)) / BigInt(p.totalShares);
  return owed > p.releasedRaw ? owed - p.releasedRaw : 0n;
}

export interface SplitReadOptions {
  nodeUrl: string;
  splitPackage: string;
  tokenPackage: string;
  /** The payees as configured, with their expected shares. */
  payees: ReadonlyArray<{ accountHash: string; share: number }>;
  fetchImpl?: typeof fetch;
  /** Deadline per RPC call. */
  timeoutMs?: number;
}

export interface SplitState {
  stateRootHash: string;
  /** Raw units of the token the splitter holds. */
  heldRaw: string;
  totalReleasedRaw: string;
  totalShares: number;
  payees: Array<{ accountHash: string; shares: number; releasedRaw: string; releasableRaw: string }>;
}

/** A dictionary item that does not exist yet (Odra's get_or_default then reads zero). */
const MISSING = Symbol("missing");

export async function readSplitState(o: SplitReadOptions): Promise<SplitState> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 8_000;
  let id = 0;

  const call = async (method: string, params: unknown): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetchImpl(o.nodeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = (e as { name?: unknown } | null)?.name === "TimeoutError";
      throw new SplitReadError(timedOut ? `the Casper node did not answer ${method} in time` : `the Casper node is unreachable`, timedOut ? 504 : 502);
    }
    if (!res.ok) throw new SplitReadError(`the Casper node answered ${method} with HTTP ${res.status}`, 502);
    let body: { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new SplitReadError(`the Casper node answered ${method} with a non-JSON body`, 502);
    }
    if (body.error) {
      const e = body.error;
      if (e.code === -32003 && /not found/i.test(String(e.data ?? e.message ?? ""))) return MISSING;
      throw new SplitReadError(`the Casper node refused ${method}: ${String(e.message ?? "error")}`, 502);
    }
    return body.result;
  };

  const stateRoot = (await call("chain_get_state_root_hash", [])) as { state_root_hash?: unknown } | typeof MISSING;
  const stateRootHash = stateRoot !== MISSING ? stateRoot.state_root_hash : undefined;
  if (typeof stateRootHash !== "string") throw new SplitReadError("no state root hash from the Casper node", 502);
  const stateIdentifier = { StateRootHash: stateRootHash };

  const storedValue = async (key: string): Promise<Record<string, unknown>> => {
    const r = await call("query_global_state", { state_identifier: stateIdentifier, key, path: [] });
    const sv = r !== MISSING ? (r as { stored_value?: Record<string, unknown> }).stored_value : undefined;
    if (!sv) throw new SplitReadError(`${key} was not found on chain`, 502);
    return sv;
  };
  /** Latest contract of a package, and that contract's named keys. */
  const namedKeysOf = async (pkg: string): Promise<Map<string, string>> => {
    const pkgValue = (await storedValue(`hash-${bare(pkg)}`)).ContractPackage as { versions?: Array<{ contract_hash?: unknown }> } | undefined;
    const contractHash = pkgValue?.versions?.at(-1)?.contract_hash;
    if (typeof contractHash !== "string") throw new SplitReadError(`package ${bare(pkg).slice(0, 8)}… has no contract version`, 502);
    const contract = (await storedValue(`hash-${bare(contractHash)}`)).Contract as { named_keys?: Array<{ name?: unknown; key?: unknown }> } | undefined;
    return new Map((contract?.named_keys ?? []).flatMap((k) => (typeof k.name === "string" && typeof k.key === "string" ? [[k.name, k.key]] : [])));
  };

  const [splitKeys, tokenKeys] = await Promise.all([namedKeysOf(o.splitPackage), namedKeysOf(o.tokenPackage)]);
  const stateUref = splitKeys.get("state");
  const balancesUref = tokenKeys.get("balances");
  if (!stateUref || !balancesUref) throw new SplitReadError("the RevenueSplit or its token does not have the expected storage", 502);

  const item = async (seed: string, key: string): Promise<unknown> => {
    const r = await call("state_get_dictionary_item", {
      state_root_hash: stateRootHash,
      dictionary_identifier: { URef: { seed_uref: seed, dictionary_item_key: key } },
    });
    return r === MISSING ? MISSING : (r as { stored_value?: { CLValue?: unknown } }).stored_value?.CLValue;
  };
  const required = (v: unknown, what: string): unknown => {
    if (v === MISSING || v === undefined) throw new SplitReadError(`the RevenueSplit state has no ${what}`, 502);
    return v;
  };
  const u256OrZero = (v: unknown): bigint => (v === MISSING ? 0n : decodeU256(odraValueBytes(v)));

  const [tokenField, totalSharesField, totalReleasedField, balanceField, ...payeeFields] = await Promise.all([
    item(stateUref, odraStateKey(SPLIT_FIELDS.token)),
    item(stateUref, odraStateKey(SPLIT_FIELDS.totalShares)),
    item(stateUref, odraStateKey(SPLIT_FIELDS.totalReleased)),
    item(balancesUref, cep18BalanceKey("contract", o.splitPackage)),
    ...o.payees.flatMap((p) => [
      item(stateUref, odraStateKey(SPLIT_FIELDS.shares, addressKeyBytes("account", p.accountHash))),
      item(stateUref, odraStateKey(SPLIT_FIELDS.released, addressKeyBytes("account", p.accountHash))),
    ]),
  ]);

  // Layout checks: a mismatch means this is not the contract (or storage layout) the dashboard knows.
  const token = decodeAddress(odraValueBytes(required(tokenField, "token")));
  if (token.kind !== "contract" || token.hash !== bare(o.tokenPackage)) {
    throw new SplitReadError("the RevenueSplit pays out a different token than the dashboard expects", 502);
  }
  const totalShares = decodeU32(odraValueBytes(required(totalSharesField, "total_shares")));
  if (totalShares === 0) throw new SplitReadError("the RevenueSplit has no shares configured", 502);
  const totalReleasedRaw = u256OrZero(totalReleasedField);
  const heldRaw =
    balanceField === MISSING
      ? 0n
      : (() => {
          const v = balanceField as ClValue | undefined;
          if (v?.cl_type !== "U256" || typeof v.bytes !== "string") throw new SplitReadError("unexpected token balance value", 502);
          return decodeU256(hexToBytes(v.bytes));
        })();

  const payees = o.payees.map((p, i) => {
    const shares = decodeU32(odraValueBytes(required(payeeFields[2 * i], `shares for ${bare(p.accountHash).slice(0, 8)}…`)));
    if (shares !== p.share) throw new SplitReadError("the on-chain shares differ from the dashboard's payee list", 502);
    const releasedRaw = u256OrZero(payeeFields[2 * i + 1]);
    const releasableRaw = releasableOf({ heldRaw, totalReleasedRaw, shares, totalShares, releasedRaw });
    return { accountHash: bare(p.accountHash), shares, releasedRaw: releasedRaw.toString(), releasableRaw: releasableRaw.toString() };
  });

  return { stateRootHash, heldRaw: heldRaw.toString(), totalReleasedRaw: totalReleasedRaw.toString(), totalShares, payees };
}

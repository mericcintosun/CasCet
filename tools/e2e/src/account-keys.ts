import { isValueNotFound, RpcTransportError, type CasperRpc } from "./casper-rpc.js";
import { normalizeAccountHash } from "./facilitator-roles.js";

/**
 * Read-only check of who can sign for an account (M07).
 *
 * A Casper account accepts a transaction signed by any of its associated keys
 * whose weights reach the account's deployment threshold. If a hot key (the
 * fee payer, the anchoring recorder) were added as an associated key of the
 * owner or a seller account, a leak of that hot key could act for that account,
 * and comparing account hashes would not reveal it. This module reads an
 * account's `associated_keys` with `query_global_state` and lists the accounts
 * a given key can sign for.
 */

export class AccountKeysError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AccountKeysError";
  }
}

export interface AccountKeys {
  /** Associated keys as bare 64-hex account hashes, with their weights. */
  associatedKeys: Array<{ accountHash: string; weight: number }>;
  deploymentThreshold?: number;
  keyManagementThreshold?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const short = (hash: string) => `${hash.slice(0, 10)}…`;

/** One idempotent read, retried once when the node could not be reached. */
async function query(rpc: CasperRpc, key: string): Promise<unknown> {
  const params = { key, path: [] };
  try {
    return await rpc.call("query_global_state", params);
  } catch (err) {
    if (!(err instanceof RpcTransportError)) throw err;
    return await rpc.call("query_global_state", params);
  }
}

/**
 * The account's associated keys and thresholds, or `undefined` when the account
 * does not exist on-chain (then nothing can sign for it yet). Throws
 * {@link AccountKeysError} when the answer cannot be read reliably.
 */
export async function readAccountKeys(rpc: CasperRpc, accountHash: string): Promise<AccountKeys | undefined> {
  const hash = normalizeAccountHash(accountHash);
  let result: unknown;
  try {
    result = await query(rpc, `account-hash-${hash}`);
  } catch (err) {
    if (isValueNotFound(err)) return undefined;
    throw new AccountKeysError(`account ${short(hash)}: ${errorText(err)}`, { cause: err });
  }
  const stored = isObject(result) ? result["stored_value"] : undefined;
  const account = isObject(stored) ? stored["Account"] : undefined;
  if (!isObject(account)) {
    const kind = isObject(stored) ? Object.keys(stored).join(",") : typeof stored;
    throw new AccountKeysError(`account ${short(hash)}: not an Account (stored value: ${kind.slice(0, 40)})`);
  }
  const keys = account["associated_keys"];
  if (!Array.isArray(keys)) throw new AccountKeysError(`account ${short(hash)}: no associated_keys`);
  const associatedKeys = keys.map(k => {
    const raw = isObject(k) ? k["account_hash"] : undefined;
    const weight = isObject(k) ? k["weight"] : undefined;
    if (typeof raw !== "string" || typeof weight !== "number") {
      throw new AccountKeysError(`account ${short(hash)}: unreadable associated key`);
    }
    try {
      return { accountHash: normalizeAccountHash(raw), weight };
    } catch {
      throw new AccountKeysError(`account ${short(hash)}: unreadable associated key`);
    }
  });
  const thresholds = isObject(account["action_thresholds"]) ? account["action_thresholds"] : {};
  const deployment = thresholds["deployment"];
  const keyManagement = thresholds["key_management"];
  return {
    associatedKeys,
    ...(typeof deployment === "number" ? { deploymentThreshold: deployment } : {}),
    ...(typeof keyManagement === "number" ? { keyManagementThreshold: keyManagement } : {}),
  };
}

/**
 * The accounts in `accounts` (other than the key's own account) that list
 * `keyAccountHash` as an associated key, i.e. that the key can help sign for.
 */
export async function accountsSignableBy(rpc: CasperRpc, accounts: readonly string[], keyAccountHash: string): Promise<string[]> {
  const key = normalizeAccountHash(keyAccountHash);
  const others = [...new Set(accounts.map(normalizeAccountHash))].filter(a => a !== key);
  const found: string[] = [];
  for (const account of others) {
    const keys = await readAccountKeys(rpc, account);
    if (keys?.associatedKeys.some(k => k.accountHash === key)) found.push(account);
  }
  return found;
}

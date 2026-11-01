import casperSdk from "casper-js-sdk";
import { isValueNotFound, RpcTransportError, type CasperRpc } from "./casper-rpc.js";

const { byteHash } = casperSdk;

/**
 * Read-only access to the on-chain state of the CasCet x402 token
 * (MAKE's Cep18X402: an Odra-built CEP-18 with CEP-3009
 * `transfer_with_authorization`).
 *
 * Besides Odra's own "state" dictionary, the token exposes CEP-18-compatible
 * named dictionaries. Their item keys were worked out with read-only RPC and
 * checked against settled transactions (testnet 04e54a95…, mainnet 2c66141c…):
 *
 *   balances    item key = base64( Key::Account bytes )            = base64(00 ‖ account_hash)
 *                value    = U256 (no entry = balance 0)
 *   used_nonces item key = hex( blake2b256( Key bytes ‖ Vec<u8>(nonce) ) )
 *                        = hex( blake2b256( 00 ‖ account_hash ‖ u32le(32) ‖ nonce ) )
 *                value    = Bool true once the authorization was used (no entry = unused)
 *
 * A dictionary item's global-state address is
 * `dictionary-` + hex( blake2b256( seed_uref_addr ‖ utf8(item_key) ) ),
 * which `query_global_state` resolves directly (one call per read).
 */

const HEX64 = /^[0-9a-f]{64}$/;
const UREF = /^uref-([0-9a-f]{64})-[0-7]{3}$/;

/** Thrown when the state cannot be read reliably (the caller must not guess). */
export class TokenStateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TokenStateError";
  }
}

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

function bareAccountHash(accountHash: string): string {
  const h = accountHash.toLowerCase().replace(/^account-hash-/, "").replace(/^00(?=[0-9a-f]{64}$)/, "");
  if (!HEX64.test(h)) throw new TokenStateError(`not an account hash: ${accountHash.slice(0, 80)}`);
  return h;
}

function bareNonce(nonce: string): string {
  const n = nonce.toLowerCase().replace(/^0x/, "");
  if (!HEX64.test(n)) throw new TokenStateError("nonce must be 32 bytes of hex");
  return n;
}

function barePackageHash(asset: string): string {
  const h = asset.toLowerCase().replace(/^(hash-|contract-package-|package-)/, "");
  if (!HEX64.test(h)) throw new TokenStateError(`not a contract package hash: ${asset.slice(0, 80)}`);
  return h;
}

/** Serialized `Key::Account` (tag 0x00 + 32-byte account hash). */
export function accountKeyBytes(accountHash: string): Uint8Array {
  const out = new Uint8Array(33);
  out.set(hexToBytes(bareAccountHash(accountHash)), 1);
  return out;
}

/** CEP-18 `balances` dictionary item key for an account. */
export function balanceItemKey(accountHash: string): string {
  return Buffer.from(accountKeyBytes(accountHash)).toString("base64");
}

/** CEP-3009 `used_nonces` dictionary item key for (authorizer, nonce). */
export function usedNonceItemKey(accountHash: string, nonce: string): string {
  const key = accountKeyBytes(accountHash);
  const nonceBytes = hexToBytes(bareNonce(nonce));
  const preimage = new Uint8Array(key.length + 4 + nonceBytes.length);
  preimage.set(key, 0);
  new DataView(preimage.buffer).setUint32(key.length, nonceBytes.length, true);
  preimage.set(nonceBytes, key.length + 4);
  return bytesToHex(byteHash(preimage));
}

/** Global-state address of a dictionary item under the given seed URef. */
export function dictionaryAddress(seedURef: string, itemKey: string): string {
  const m = UREF.exec(seedURef.toLowerCase());
  const seedHex = m ? m[1]! : seedURef.toLowerCase();
  if (!HEX64.test(seedHex)) throw new TokenStateError(`not a URef: ${seedURef.slice(0, 80)}`);
  const seed = hexToBytes(seedHex);
  const item = new TextEncoder().encode(itemKey);
  const preimage = new Uint8Array(seed.length + item.length);
  preimage.set(seed, 0);
  preimage.set(item, seed.length);
  return `dictionary-${bytesToHex(byteHash(preimage))}`;
}

export interface TokenHandles {
  packageHash: string;
  contractHash: string;
  balancesURef: string;
  usedNoncesURef: string;
  nameURef?: string;
}

interface StoredValueEnvelope {
  stored_value?: Record<string, unknown>;
}

interface CLValueJson {
  cl_type?: unknown;
  bytes?: unknown;
  parsed?: unknown;
}

function clValueOf(result: StoredValueEnvelope, what: string): CLValueJson {
  const clv = result.stored_value?.["CLValue"];
  if (typeof clv !== "object" || clv === null) throw new TokenStateError(`${what}: stored value is not a CLValue`);
  return clv as CLValueJson;
}

/** Decode a little-endian, length-prefixed U256/U512 from its CLValue bytes. */
function decodeBigUintBytes(hex: string): bigint {
  const bytes = hexToBytes(hex);
  const len = bytes[0];
  if (len === undefined || bytes.length !== len + 1) throw new TokenStateError("malformed U256 bytes");
  let v = 0n;
  for (let i = len; i >= 1; i--) v = (v << 8n) | BigInt(bytes[i]!);
  return v;
}

export function parseU256(result: StoredValueEnvelope, what: string): bigint {
  const clv = clValueOf(result, what);
  if (clv.cl_type !== "U256") throw new TokenStateError(`${what}: expected U256, got ${JSON.stringify(clv.cl_type)}`);
  if (typeof clv.parsed === "string" && /^\d+$/.test(clv.parsed)) return BigInt(clv.parsed);
  if (typeof clv.bytes === "string" && /^[0-9a-f]*$/i.test(clv.bytes)) return decodeBigUintBytes(clv.bytes);
  throw new TokenStateError(`${what}: unreadable U256`);
}

export function parseBool(result: StoredValueEnvelope, what: string): boolean {
  const clv = clValueOf(result, what);
  if (clv.cl_type !== "Bool") throw new TokenStateError(`${what}: expected Bool, got ${JSON.stringify(clv.cl_type)}`);
  if (typeof clv.parsed === "boolean") return clv.parsed;
  if (clv.bytes === "01") return true;
  if (clv.bytes === "00") return false;
  throw new TokenStateError(`${what}: unreadable Bool`);
}

export function parseString(result: StoredValueEnvelope, what: string): string {
  const clv = clValueOf(result, what);
  if (clv.cl_type !== "String" || typeof clv.parsed !== "string") throw new TokenStateError(`${what}: expected String`);
  return clv.parsed;
}

interface ContractPackageJson {
  versions?: Array<{ contract_hash?: unknown; contract_version?: unknown; protocol_version_major?: unknown }>;
  disabled_versions?: Array<{ contract_version?: unknown; protocol_version_major?: unknown }>;
}

/** Pick the newest enabled contract version of a (pre-2.0 style) ContractPackage. */
export function latestContractHash(pkg: ContractPackageJson): string {
  const disabled = new Set(
    (pkg.disabled_versions ?? []).map(d => `${String(d.protocol_version_major)}:${String(d.contract_version)}`),
  );
  let best: { major: number; version: number; hash: string } | undefined;
  for (const v of pkg.versions ?? []) {
    const major = Number(v.protocol_version_major);
    const version = Number(v.contract_version);
    const hash = typeof v.contract_hash === "string" ? v.contract_hash.replace(/^contract-/, "").toLowerCase() : "";
    if (!Number.isInteger(major) || !Number.isInteger(version) || !HEX64.test(hash)) continue;
    if (disabled.has(`${major}:${version}`)) continue;
    if (!best || major > best.major || (major === best.major && version > best.version)) best = { major, version, hash };
  }
  if (!best) throw new TokenStateError("contract package has no enabled version");
  return best.hash;
}

export interface TokenStateReaderOptions {
  /** How long resolved named keys / token names stay cached. Default 10 minutes. */
  cacheTtlMs?: number;
  now?: () => number;
}

/**
 * Reads balances, used nonces and the token name of a CEP-18/CEP-3009 token.
 * Any RPC failure or unexpected shape throws {@link TokenStateError}; only the
 * node's explicit "value was not found" is interpreted (as 0 / unused).
 */
export class TokenStateReader {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly handles = new Map<string, { value: TokenHandles; expiresAt: number }>();
  private readonly names = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    private readonly rpc: CasperRpc,
    opts: TokenStateReaderOptions = {},
  ) {
    this.ttlMs = opts.cacheTtlMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * `query_global_state` for one key. Reads are idempotent, so a transport
   * failure (timeout, network, HTTP error, garbage) is retried once before the
   * caller has to answer "unavailable"; an answer from the node is never retried.
   */
  private async read(key: string): Promise<StoredValueEnvelope> {
    const params = { key, path: [] };
    try {
      return await this.rpc.call<StoredValueEnvelope>("query_global_state", params);
    } catch (err) {
      if (!(err instanceof RpcTransportError)) throw err;
      return await this.rpc.call<StoredValueEnvelope>("query_global_state", params);
    }
  }

  private async query(key: string, what: string): Promise<StoredValueEnvelope> {
    try {
      return await this.read(key);
    } catch (err) {
      throw new TokenStateError(`${what}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  /** Query a dictionary item; `undefined` when the node says it does not exist. */
  private async queryItem(address: string, what: string): Promise<StoredValueEnvelope | undefined> {
    try {
      return await this.read(address);
    } catch (err) {
      if (isValueNotFound(err)) return undefined;
      throw new TokenStateError(`${what}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  /** Resolve the token's current contract and its named dictionaries (cached). */
  async resolve(asset: string): Promise<TokenHandles> {
    const packageHash = barePackageHash(asset);
    const cached = this.handles.get(packageHash);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const pkgResult = await this.query(`hash-${packageHash}`, "token package");
    const pkg = pkgResult.stored_value?.["ContractPackage"];
    if (typeof pkg !== "object" || pkg === null) {
      throw new TokenStateError("token package: not a ContractPackage (unsupported storage layout)");
    }
    const contractHash = latestContractHash(pkg as ContractPackageJson);

    const contractResult = await this.query(`hash-${contractHash}`, "token contract");
    const contract = contractResult.stored_value?.["Contract"] as { named_keys?: Array<{ name?: unknown; key?: unknown }> } | undefined;
    const namedKeys = new Map<string, string>();
    for (const nk of contract?.named_keys ?? []) {
      if (typeof nk.name === "string" && typeof nk.key === "string") namedKeys.set(nk.name, nk.key.toLowerCase());
    }
    const balancesURef = namedKeys.get("balances");
    const usedNoncesURef = namedKeys.get("used_nonces");
    if (!balancesURef || !UREF.test(balancesURef) || !usedNoncesURef || !UREF.test(usedNoncesURef)) {
      throw new TokenStateError("token contract: missing `balances` / `used_nonces` dictionaries (not a CEP-3009 token?)");
    }
    const nameURef = namedKeys.get("name");
    const value: TokenHandles = {
      packageHash,
      contractHash,
      balancesURef,
      usedNoncesURef,
      ...(nameURef && UREF.test(nameURef) ? { nameURef } : {}),
    };
    this.handles.set(packageHash, { value, expiresAt: this.now() + this.ttlMs });
    return value;
  }

  /** CEP-18 balance of an account (0 when it has no entry). */
  async balanceOf(asset: string, accountHash: string): Promise<bigint> {
    const h = await this.resolve(asset);
    const item = await this.queryItem(dictionaryAddress(h.balancesURef, balanceItemKey(accountHash)), "balance");
    return item ? parseU256(item, "balance") : 0n;
  }

  /** Whether the CEP-3009 authorization nonce of `accountHash` was already used. */
  async isNonceUsed(asset: string, accountHash: string, nonce: string): Promise<boolean> {
    const h = await this.resolve(asset);
    const item = await this.queryItem(dictionaryAddress(h.usedNoncesURef, usedNonceItemKey(accountHash, nonce)), "nonce");
    return item ? parseBool(item, "nonce") : false;
  }

  /** The token's on-chain `name` (used as the EIP-712 domain name), cached. */
  async tokenName(asset: string): Promise<string | undefined> {
    const h = await this.resolve(asset);
    if (!h.nameURef) return undefined;
    const cached = this.names.get(h.packageHash);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const value = parseString(await this.query(h.nameURef, "token name"), "token name");
    this.names.set(h.packageHash, { value, expiresAt: this.now() + this.ttlMs });
    return value;
  }
}

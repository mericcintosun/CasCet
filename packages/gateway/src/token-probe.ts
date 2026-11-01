import casperSdk from "casper-js-sdk";
import type { AuthorizationStyle } from "@cascet/core";
import { isValueNotFound, RpcNodeError, RpcTransportError, type CasperRpc } from "./casper-rpc.js";

const { byteHash } = casperSdk;

/**
 * Token probe: read-only access to the on-chain state of a Casper x402 token,
 * shared by the gateway and the self-hosted facilitator.
 *
 * Both token styles are Odra-built CEP-18 tokens with CEP-3009
 * `transfer_with_authorization`: CasCet's x402 token (MAKE's Cep18X402, whose
 * entry point takes `amount`) and CEP-3009 tokens such as the official Wrapped
 * CSPR (`value`). Besides Odra's own "state" dictionary they expose CEP-18
 * named dictionaries, whose item keys were worked out with read-only RPC and
 * checked against settled transactions (testnet 04e54a95…, mainnet 2c66141c…)
 * and against testnet Wrapped CSPR:
 *
 *   balances    item key = base64( Key::Account bytes )            = base64(00 ‖ account_hash)
 *                value    = U256 (no entry = balance 0)
 *   used_nonces item key = hex( blake2b256( Key bytes ‖ Vec<u8>(nonce) ) )
 *                        = hex( blake2b256( 00 ‖ account_hash ‖ u32le(32) ‖ nonce ) )
 *                value    = Bool true once the authorization was used (no entry = unused)
 *
 * (@x402/casper 2.29 reads an `authorization_state` dictionary, which these
 * tokens do not have, with key base64(Key ‖ nonce): never use that.)
 *
 * A dictionary item's global-state address is
 * `dictionary-` + hex( blake2b256( seed_uref_addr ‖ utf8(item_key) ) ),
 * which `query_global_state` resolves directly (one call per read).
 *
 * The token's authorization style is read from the active contract's
 * `transfer_with_authorization` arguments, its EIP-712 domain from the `name`
 * and `chain_name` named keys.
 *
 * Node errors: -32003 "value was not found in the global state" means the item
 * does not exist (unused nonce, zero balance); -32018 "dictionary URef not
 * found" means the token has no such dictionary (unsupported). Every other
 * failure is indeterminate: the probe throws and callers must fail closed.
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

/**
 * The token cannot be used for x402 payments: no such package, an unsupported
 * storage layout, missing dictionaries, or a `transfer_with_authorization`
 * whose arguments match neither style. Not a transient failure.
 */
export class TokenUnsupportedError extends TokenStateError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TokenUnsupportedError";
  }
}

/** JSON-RPC error code of "Node request failure" (casper-sidecar), e.g. a missing dictionary. */
export const RPC_NODE_REQUEST_FAILED = -32018;

/**
 * What a failed token read means:
 * - `absent`: -32003 "value was not found in the global state": the item does
 *   not exist (an unused nonce, a zero balance);
 * - `unsupported`: -32018 "dictionary URef not found": the token has no such
 *   dictionary;
 * - `unavailable`: anything else (transport failures, other node errors). The
 *   outcome is unknown: fail closed.
 */
export function classifyTokenRpcError(err: unknown): "absent" | "unsupported" | "unavailable" {
  if (isValueNotFound(err)) return "absent";
  if (
    err instanceof RpcNodeError &&
    err.code === RPC_NODE_REQUEST_FAILED &&
    typeof err.data === "string" &&
    /dictionary URef not found/i.test(err.data)
  ) {
    return "unsupported";
  }
  return "unavailable";
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

/** Contract entry point as `query_global_state` returns it. */
export interface EntryPointJson {
  name?: unknown;
  args?: ReadonlyArray<{ name?: unknown; cl_type?: unknown }>;
}

/** The arguments `transfer_with_authorization` takes besides the amount, with their CLTypes. */
const AUTHORIZATION_ARGS: ReadonlyArray<readonly [string, unknown]> = [
  ["from", "Key"],
  ["to", "Key"],
  ["valid_after", "U64"],
  ["valid_before", "U64"],
  ["nonce", { List: "U8" }],
  ["public_key", "PublicKey"],
  ["signature", { List: "U8" }],
];

/**
 * The authorization style of a contract, from its `transfer_with_authorization`
 * entry point: exactly the arguments every facilitator passes (from, to,
 * valid_after, valid_before, nonce, public_key, signature, with their CLTypes)
 * plus a U256 named `amount` (legacy-amount) or `value` (cep3009-value).
 * Undefined when the entry point is missing or takes anything else.
 */
export function authorizationStyleOf(entryPoints: readonly EntryPointJson[] | undefined): AuthorizationStyle | undefined {
  const entryPoint = entryPoints?.find(ep => ep.name === "transfer_with_authorization");
  if (!entryPoint || !Array.isArray(entryPoint.args) || entryPoint.args.length !== AUTHORIZATION_ARGS.length + 1) return undefined;
  const types = new Map(entryPoint.args.map(arg => [String(arg.name), JSON.stringify(arg.cl_type)]));
  if (types.size !== entryPoint.args.length) return undefined;
  for (const [name, type] of AUTHORIZATION_ARGS) {
    if (types.get(name) !== JSON.stringify(type)) return undefined;
  }
  const amountType = JSON.stringify("U256");
  if (types.get("amount") === amountType) return "legacy-amount";
  if (types.get("value") === amountType) return "cep3009-value";
  return undefined;
}

export interface TokenHandles {
  packageHash: string;
  contractHash: string;
  balancesURef: string;
  usedNoncesURef: string;
  nameURef?: string;
  chainNameURef?: string;
  /** Style of the active contract's transfer_with_authorization; undefined when unrecognized. */
  authorizationStyle?: AuthorizationStyle;
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

/** A disabled version as nodes list it: a [protocol_version_major, contract_version] pair (older answers: an object). */
type DisabledVersionJson = readonly unknown[] | { contract_version?: unknown; protocol_version_major?: unknown };

export interface ContractPackageJson {
  versions?: ReadonlyArray<{ contract_hash?: unknown; contract_version?: unknown; protocol_version_major?: unknown }>;
  disabled_versions?: readonly DisabledVersionJson[];
}

function disabledVersionKey(entry: DisabledVersionJson): string {
  if (Array.isArray(entry)) return `${String(entry[0])}:${String(entry[1])}`;
  const object = entry as { contract_version?: unknown; protocol_version_major?: unknown };
  return `${String(object.protocol_version_major)}:${String(object.contract_version)}`;
}

/** Pick the newest enabled contract version of a (pre-2.0 style) ContractPackage. */
export function latestContractHash(pkg: ContractPackageJson): string {
  const disabled = new Set((pkg.disabled_versions ?? []).map(disabledVersionKey));
  let best: { major: number; version: number; hash: string } | undefined;
  for (const v of pkg.versions ?? []) {
    const major = Number(v.protocol_version_major);
    const version = Number(v.contract_version);
    const hash = typeof v.contract_hash === "string" ? v.contract_hash.replace(/^contract-/, "").toLowerCase() : "";
    if (!Number.isInteger(major) || !Number.isInteger(version) || !HEX64.test(hash)) continue;
    if (disabled.has(`${major}:${version}`)) continue;
    if (!best || major > best.major || (major === best.major && version > best.version)) best = { major, version, hash };
  }
  if (!best) throw new TokenUnsupportedError("contract package has no enabled version");
  return best.hash;
}

export interface TokenProbeOptions {
  /** How long resolved contracts, named keys, ABIs and token names stay cached. Default 10 minutes. */
  cacheTtlMs?: number;
  now?: () => number;
}

export interface TokenReadOptions {
  /**
   * Absolute time (ms, on the probe's clock) by which every RPC call of this
   * read must be done. Each call's timeout is cut to what is left, the retry is
   * skipped when too little is left, and a spent budget throws
   * {@link TokenStateError} without calling the node.
   */
  deadlineMs?: number;
}

/** A transport failure is retried only when at least this much of the deadline is left. */
export const MIN_RETRY_BUDGET_MS = 500;

/**
 * Reads the authorization style, EIP-712 domain (name, chain_name), balances
 * and used nonces of CEP-18/CEP-3009 tokens. Any RPC failure or unexpected
 * shape throws {@link TokenStateError} ({@link TokenUnsupportedError} when the
 * token itself cannot be used); only the node's explicit "value was not found"
 * for an item is interpreted (as 0 / unused).
 */
export class TokenProbe {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly handles = new Map<string, { value: TokenHandles; expiresAt: number }>();
  /** Resolutions in progress, shared by concurrent reads of the same token. */
  private readonly resolving = new Map<string, Promise<TokenHandles>>();
  private readonly strings = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    private readonly rpc: CasperRpc,
    opts: TokenProbeOptions = {},
  ) {
    this.ttlMs = opts.cacheTtlMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * `query_global_state` for one key. Reads are idempotent, so a transport
   * failure (timeout, network, HTTP error, garbage) is retried once before the
   * caller has to answer "unavailable", if the deadline leaves time for it; an
   * answer from the node is never retried.
   */
  private async read(key: string, opts: TokenReadOptions): Promise<StoredValueEnvelope> {
    const params = { key, path: [] };
    const left = () => (opts.deadlineMs === undefined ? undefined : opts.deadlineMs - this.now());
    const attempt = () => {
      const budget = left();
      if (budget !== undefined && budget <= 0) throw new TokenStateError("preflight deadline exceeded");
      return this.rpc.call<StoredValueEnvelope>("query_global_state", params, budget !== undefined ? { timeoutMs: budget } : undefined);
    };
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof RpcTransportError)) throw err;
      const budget = left();
      if (budget !== undefined && budget < MIN_RETRY_BUDGET_MS) throw err;
      return await attempt();
    }
  }

  /** Read a value that must exist (a package, a contract, a named key). */
  private async query(key: string, what: string, opts: TokenReadOptions): Promise<StoredValueEnvelope> {
    try {
      return await this.read(key, opts);
    } catch (err) {
      if (err instanceof TokenStateError) throw err;
      const detail = `${what}: ${err instanceof Error ? err.message : String(err)}`;
      if (classifyTokenRpcError(err) === "unavailable") throw new TokenStateError(detail, { cause: err });
      throw new TokenUnsupportedError(detail, { cause: err });
    }
  }

  /** Query a dictionary item; `undefined` when the node says it does not exist. */
  private async queryItem(address: string, what: string, opts: TokenReadOptions): Promise<StoredValueEnvelope | undefined> {
    try {
      return await this.read(address, opts);
    } catch (err) {
      if (err instanceof TokenStateError) throw err;
      const kind = classifyTokenRpcError(err);
      if (kind === "absent") return undefined;
      const detail = `${what}: ${err instanceof Error ? err.message : String(err)}`;
      if (kind === "unsupported") throw new TokenUnsupportedError(detail, { cause: err });
      throw new TokenStateError(detail, { cause: err });
    }
  }

  /** Resolve the token's current contract, its named keys and its ABI (cached; concurrent calls share one lookup). */
  async resolve(asset: string, opts: TokenReadOptions = {}): Promise<TokenHandles> {
    const packageHash = barePackageHash(asset);
    const cached = this.handles.get(packageHash);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const inProgress = this.resolving.get(packageHash);
    if (inProgress) return inProgress;
    const lookup = this.lookup(packageHash, opts).finally(() => this.resolving.delete(packageHash));
    this.resolving.set(packageHash, lookup);
    return lookup;
  }

  private async lookup(packageHash: string, opts: TokenReadOptions): Promise<TokenHandles> {
    const pkgResult = await this.query(`hash-${packageHash}`, "token package", opts);
    const pkg = pkgResult.stored_value?.["ContractPackage"];
    if (typeof pkg !== "object" || pkg === null) {
      throw new TokenUnsupportedError("token package: not a ContractPackage (unsupported storage layout)");
    }
    const contractHash = latestContractHash(pkg as ContractPackageJson);

    const contractResult = await this.query(`hash-${contractHash}`, "token contract", opts);
    const contract = contractResult.stored_value?.["Contract"] as
      | { named_keys?: Array<{ name?: unknown; key?: unknown }>; entry_points?: EntryPointJson[] }
      | undefined;
    const namedKeys = new Map<string, string>();
    for (const nk of contract?.named_keys ?? []) {
      if (typeof nk.name === "string" && typeof nk.key === "string") namedKeys.set(nk.name, nk.key.toLowerCase());
    }
    const balancesURef = namedKeys.get("balances");
    const usedNoncesURef = namedKeys.get("used_nonces");
    if (!balancesURef || !UREF.test(balancesURef) || !usedNoncesURef || !UREF.test(usedNoncesURef)) {
      throw new TokenUnsupportedError("token contract: missing `balances` / `used_nonces` dictionaries (not a CEP-3009 token?)");
    }
    const uref = (name: string): string | undefined => {
      const key = namedKeys.get(name);
      return key && UREF.test(key) ? key : undefined;
    };
    const nameURef = uref("name");
    const chainNameURef = uref("chain_name");
    const authorizationStyle = authorizationStyleOf(contract?.entry_points);
    const value: TokenHandles = {
      packageHash,
      contractHash,
      balancesURef,
      usedNoncesURef,
      ...(nameURef ? { nameURef } : {}),
      ...(chainNameURef ? { chainNameURef } : {}),
      ...(authorizationStyle ? { authorizationStyle } : {}),
    };
    this.handles.set(packageHash, { value, expiresAt: this.now() + this.ttlMs });
    return value;
  }

  /**
   * The token's authorization style, read from its active contract's
   * `transfer_with_authorization` arguments. Throws TokenUnsupportedError when
   * the entry point is missing or matches neither style. Cached like the
   * contract: an upgrade that changes the ABI is seen within the cache TTL.
   */
  async authorizationStyle(asset: string, opts: TokenReadOptions = {}): Promise<AuthorizationStyle> {
    const h = await this.resolve(asset, opts);
    if (!h.authorizationStyle) {
      throw new TokenUnsupportedError(
        `token ${h.packageHash}: transfer_with_authorization is missing or takes neither \`amount\` nor \`value\` with the CEP-3009 arguments`,
      );
    }
    return h.authorizationStyle;
  }

  /** CEP-18 balance of an account (0 when it has no entry). */
  async balanceOf(asset: string, accountHash: string, opts: TokenReadOptions = {}): Promise<bigint> {
    const h = await this.resolve(asset, opts);
    const item = await this.queryItem(dictionaryAddress(h.balancesURef, balanceItemKey(accountHash)), "balance", opts);
    return item ? parseU256(item, "balance") : 0n;
  }

  /** Whether the CEP-3009 authorization nonce of `accountHash` was already used. */
  async isNonceUsed(asset: string, accountHash: string, nonce: string, opts: TokenReadOptions = {}): Promise<boolean> {
    const h = await this.resolve(asset, opts);
    const item = await this.queryItem(dictionaryAddress(h.usedNoncesURef, usedNonceItemKey(accountHash, nonce)), "nonce", opts);
    return item ? parseBool(item, "nonce") : false;
  }

  /** The token's on-chain `name` (its EIP-712 domain name), cached; undefined when it has no such named key. */
  async tokenName(asset: string, opts: TokenReadOptions = {}): Promise<string | undefined> {
    const h = await this.resolve(asset, opts);
    return h.nameURef ? this.cachedString(h.nameURef, "token name", opts) : undefined;
  }

  /**
   * The token's on-chain `chain_name` (its EIP-712 domain chain, a CAIP-2
   * network such as "casper:casper-test"), cached; undefined when it has no
   * such named key.
   */
  async chainName(asset: string, opts: TokenReadOptions = {}): Promise<string | undefined> {
    const h = await this.resolve(asset, opts);
    return h.chainNameURef ? this.cachedString(h.chainNameURef, "token chain_name", opts) : undefined;
  }

  private async cachedString(uref: string, what: string, opts: TokenReadOptions): Promise<string> {
    const cached = this.strings.get(uref);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const value = parseString(await this.query(uref, what, opts), what);
    this.strings.set(uref, { value, expiresAt: this.now() + this.ttlMs });
    return value;
  }
}

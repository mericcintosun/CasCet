import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import casperSdk from "casper-js-sdk";

const { Args, CLValue, CLTypeUInt8, PublicKey, SessionBuilder, Timestamp } = casperSdk;

/**
 * Odra's proxy session, the way Odra's own livenet client calls a payable
 * entry point (one that takes attached CSPR, such as Wrapped CSPR's
 * `deposit`) from an account (odra-casper-rpc-client 2.9.1,
 * `deploy_entrypoint_call_with_proxy`).
 *
 * A contract cannot pull CSPR from an account's purse, so the session wasm
 * `proxy_caller_with_return.wasm` runs in the caller's account context: it
 * moves `attached_value` motes from the account's main purse into the
 * account's cargo purse (named key `__cargo_purse`, created on first use with
 * `create_purse`, 2.5 CSPR of gas), calls `entry_point` on the newest version
 * of `package_hash` with the serialized `args` plus `cargo_purse`, and stores
 * the return value under `__result`. The contract then sweeps the cargo purse.
 *
 * Session args (names and types as Odra builds them; byte-identical to testnet
 * WCSPR deposit 77fb850a…, see wcspr-fixtures.ts):
 *   package_hash    ByteArray(32)  contract package to call
 *   entry_point     String         entry point name
 *   args            List<U8>       the entry point's serialized RuntimeArgs ("00000000" = none)
 *   attached_value  U512           motes to attach
 *   amount          U512           the session's spending limit: Casper lets session code
 *                                  move at most this much out of the account's main purse
 *
 * Session code acts with the account's full authority, so the wasm is pinned
 * by size and SHA-256 and never loaded from anywhere else.
 */
export const ODRA_PROXY_WASM = Object.freeze({
  crate: "odra-casper-rpc-client-2.9.1",
  file: "resources/proxy_caller_with_return.wasm",
  bytes: 184_758,
  sha256: "16f0c0b87706fe46a44c0cd12f7b5a7a1be9c4f7c6276e64b64df9c3a3c9de8a",
});

/** Serialized empty RuntimeArgs: a u32 count of zero. */
export const EMPTY_RUNTIME_ARGS: Uint8Array = Uint8Array.of(0, 0, 0, 0);

const HEX64 = /^[0-9a-f]{64}$/;

export interface ProxyCall {
  /** Contract package hash, bare 64 hex. */
  packageHash: string;
  entryPoint: string;
  /** Serialized RuntimeArgs of the entry point. Default: none ({@link EMPTY_RUNTIME_ARGS}). */
  innerArgs?: Uint8Array;
  /** CSPR to attach, in motes. */
  attachedMotes: bigint;
}

/** Where the proxy wasm sits in a cargo registry: `<cargo home>/registry/src/<index>/<crate>/<file>`. */
export function odraProxyWasmCandidates(cargoHome: string, listDir: (path: string) => string[] = readdirSync): string[] {
  const registry = join(cargoHome, "registry", "src");
  let indexes: string[];
  try {
    indexes = listDir(registry);
  } catch {
    return [];
  }
  return indexes.sort().map(index => join(registry, index, ODRA_PROXY_WASM.crate, ODRA_PROXY_WASM.file));
}

export interface LocateOptions {
  /** An explicit path (`--proxy-wasm`). */
  explicitPath?: string;
  /** Cargo home; default `$CARGO_HOME` or `~/.cargo`. */
  cargoHome?: string;
  exists?: (path: string) => boolean;
  listDir?: (path: string) => string[];
}

/**
 * Path of the proxy wasm: the explicit one, or the first copy in the local cargo
 * registry. `cargo fetch` in `contracts/` downloads the crate (odra-cli 2.9.1
 * depends on it, checksum in contracts/Cargo.lock). Throws with that hint.
 */
export function locateOdraProxyWasm(opts: LocateOptions = {}): string {
  const exists = opts.exists ?? existsSync;
  if (opts.explicitPath) {
    if (!exists(opts.explicitPath)) throw new Error(`proxy wasm not found at ${opts.explicitPath}`);
    return opts.explicitPath;
  }
  const cargoHome = opts.cargoHome ?? process.env["CARGO_HOME"] ?? join(homedir(), ".cargo");
  const found = odraProxyWasmCandidates(cargoHome, opts.listDir).find(path => exists(path));
  if (!found) {
    throw new Error(
      `${ODRA_PROXY_WASM.file} of ${ODRA_PROXY_WASM.crate} is not in ${join(cargoHome, "registry", "src")}: ` +
        "run `cargo fetch` in contracts/ (odra-cli 2.9.1 depends on it), or pass --proxy-wasm <path>",
    );
  }
  return found;
}

/** Throws unless `bytes` is exactly the pinned Odra 2.9.1 proxy (size and SHA-256). */
export function verifyOdraProxyWasm(bytes: Uint8Array): void {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== ODRA_PROXY_WASM.bytes || sha256 !== ODRA_PROXY_WASM.sha256) {
    throw new Error(
      `refusing the proxy wasm: ${bytes.length} bytes, sha256 ${sha256}; expected ${ODRA_PROXY_WASM.bytes} bytes, ` +
        `sha256 ${ODRA_PROXY_WASM.sha256} (${ODRA_PROXY_WASM.crate}/${ODRA_PROXY_WASM.file}). Session code runs with ` +
        "the account's full authority, so only the pinned build is used",
    );
  }
}

/** Read the proxy wasm from `path` and verify it ({@link verifyOdraProxyWasm}). */
export function loadOdraProxyWasm(path: string, read: (path: string) => Uint8Array = readFileSync): Uint8Array {
  const bytes = new Uint8Array(read(path));
  verifyOdraProxyWasm(bytes);
  return bytes;
}

/** The proxy session's runtime args for `call` (see {@link ODRA_PROXY_WASM}). */
export function proxyCallArgs(call: ProxyCall) {
  const packageHash = call.packageHash.toLowerCase();
  if (!HEX64.test(packageHash)) throw new Error(`package hash must be 64 hex characters, got "${call.packageHash.slice(0, 80)}"`);
  if (!/^[a-z_][a-z0-9_]{0,99}$/i.test(call.entryPoint)) throw new Error(`invalid entry point name "${call.entryPoint.slice(0, 80)}"`);
  if (call.attachedMotes < 0n) throw new Error("attached value must not be negative");
  const inner = call.innerArgs ?? EMPTY_RUNTIME_ARGS;
  return Args.fromMap({
    package_hash: CLValue.newCLByteArray(Uint8Array.from(Buffer.from(packageHash, "hex"))),
    entry_point: CLValue.newCLString(call.entryPoint),
    args: CLValue.newCLList(
      CLTypeUInt8,
      Array.from(inner, byte => CLValue.newCLUint8(byte)),
    ),
    attached_value: CLValue.newCLUInt512(call.attachedMotes.toString()),
    amount: CLValue.newCLUInt512(call.attachedMotes.toString()),
  });
}

export interface ProxySessionOptions {
  /** Public key (hex, with algorithm tag) of the account that signs and pays. */
  initiatorPublicKey: string;
  /** Casper chain name, e.g. "casper-test". */
  chainName: string;
  /** Gas limit in motes (charged up front; 75% of the unused part is refunded on success). */
  paymentMotes: bigint;
  /** Transaction TTL. Default 30 minutes. */
  ttlMs?: number;
  /** Fixed timestamp (tests); default now. */
  timestamp?: Date;
}

/**
 * Build the (unsigned) proxy session: a VmCasperV1 session marked
 * install/upgrade, as Odra submits every proxy call, which also puts the
 * 185 KB transaction in the install/upgrade lane (wasm lanes 4 and 5 take at
 * most 128 KB and 64 KB). Standard payment, gas price tolerance 1.
 */
export function buildProxySession(wasm: Uint8Array, call: ProxyCall, opts: ProxySessionOptions) {
  if (opts.paymentMotes <= 0n || opts.paymentMotes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("payment must be a positive number of motes");
  }
  const builder = new SessionBuilder()
    .from(PublicKey.fromHex(opts.initiatorPublicKey))
    .wasm(wasm)
    .installOrUpgrade()
    .runtimeArgs(proxyCallArgs(call))
    .chainName(opts.chainName)
    .payment(Number(opts.paymentMotes), 1);
  if (opts.ttlMs !== undefined) builder.ttl(opts.ttlMs);
  if (opts.timestamp) builder.timestamp(new Timestamp(opts.timestamp));
  return builder.build();
}

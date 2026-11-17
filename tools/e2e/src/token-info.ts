import type { AuthorizationStyle } from "@cascet/core";
import {
  authorizationStyleOf,
  balanceItemKey,
  dictionaryAddress,
  isValueNotFound,
  latestContractHash,
  parseU256,
  type CasperRpc,
  type EntryPointJson,
} from "@cascet/gateway";

type ContractPackageJson = Parameters<typeof latestContractHash>[0];

/**
 * Read-only metadata of a CEP-18 token for the maintainer scripts: its newest
 * contract, `name`, `symbol`, `decimals`, `chain_name` (the EIP-712 domain
 * chain of CEP-3009 tokens), the `transfer_with_authorization` style and the
 * entry points with their argument types. Checked before anything is signed,
 * so a typo'd package hash or an unexpected ABI stops the script.
 */
export interface TokenInfo {
  packageHash: string;
  contractHash: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  /** CAIP-2 network from the `chain_name` named key (CEP-3009 tokens). */
  chainName?: string;
  authorizationStyle?: AuthorizationStyle;
  /** Seed URef of the Odra CEP-18 `balances` dictionary. */
  balancesURef?: string;
  /** Entry point name → its arguments as [name, JSON of the CLType]. */
  entryPoints: ReadonlyMap<string, ReadonlyArray<readonly [string, string]>>;
}

const HEX64 = /^[0-9a-f]{64}$/;
const UREF = /^uref-[0-9a-f]{64}-[0-7]{3}$/;

interface StoredValue {
  stored_value?: Record<string, unknown>;
}

async function query(rpc: CasperRpc, key: string): Promise<Record<string, unknown>> {
  const result = await rpc.call<StoredValue>("query_global_state", { key, path: [] });
  const stored = result?.stored_value;
  if (typeof stored !== "object" || stored === null) throw new Error(`${key.slice(0, 80)}: no stored value`);
  return stored;
}

function clValue(stored: Record<string, unknown>): { cl_type?: unknown; parsed?: unknown } {
  const clv = stored["CLValue"];
  return typeof clv === "object" && clv !== null ? (clv as { cl_type?: unknown; parsed?: unknown }) : {};
}

/** Read the token's metadata (read-only `query_global_state`). Throws when the package or its contract cannot be read. */
export async function readTokenInfo(rpc: CasperRpc, packageHashInput: string): Promise<TokenInfo> {
  const packageHash = packageHashInput.trim().toLowerCase().replace(/^(hash-|contract-package-|package-|0x)/, "");
  if (!HEX64.test(packageHash)) throw new Error(`not a contract package hash (64 hex): "${packageHashInput.slice(0, 80)}"`);

  const pkg = (await query(rpc, `hash-${packageHash}`))["ContractPackage"];
  if (typeof pkg !== "object" || pkg === null) throw new Error(`hash-${packageHash} is not a contract package`);
  const contractHash = latestContractHash(pkg as ContractPackageJson);

  const contract = (await query(rpc, `hash-${contractHash}`))["Contract"] as
    | { named_keys?: Array<{ name?: unknown; key?: unknown }>; entry_points?: EntryPointJson[] }
    | undefined;
  if (!contract) throw new Error(`hash-${contractHash} is not a contract`);

  const namedKeys = new Map<string, string>();
  for (const nk of contract.named_keys ?? []) {
    if (typeof nk.name === "string" && typeof nk.key === "string" && UREF.test(nk.key.toLowerCase())) namedKeys.set(nk.name, nk.key.toLowerCase());
  }
  const readNamed = async (name: string): Promise<{ cl_type?: unknown; parsed?: unknown } | undefined> => {
    const key = namedKeys.get(name);
    return key ? clValue(await query(rpc, key)) : undefined;
  };
  const text = (v: { cl_type?: unknown; parsed?: unknown } | undefined) =>
    v?.cl_type === "String" && typeof v.parsed === "string" ? v.parsed : undefined;

  const [name, symbol, decimalsValue, chainName] = await Promise.all([
    readNamed("name"),
    readNamed("symbol"),
    readNamed("decimals"),
    readNamed("chain_name"),
  ]);
  const decimals = decimalsValue?.cl_type === "U8" && typeof decimalsValue.parsed === "number" ? decimalsValue.parsed : undefined;

  const entryPoints = new Map<string, ReadonlyArray<readonly [string, string]>>();
  for (const ep of contract.entry_points ?? []) {
    if (typeof ep.name !== "string") continue;
    entryPoints.set(
      ep.name,
      (ep.args ?? []).map(arg => [String(arg.name), JSON.stringify(arg.cl_type)] as const),
    );
  }
  const style = authorizationStyleOf(contract.entry_points);
  const nameText = text(name);
  const symbolText = text(symbol);
  const chainText = text(chainName);
  const balancesURef = namedKeys.get("balances");
  return {
    packageHash,
    contractHash,
    ...(nameText !== undefined ? { name: nameText } : {}),
    ...(symbolText !== undefined ? { symbol: symbolText } : {}),
    ...(decimals !== undefined ? { decimals } : {}),
    ...(chainText !== undefined ? { chainName: chainText } : {}),
    ...(style ? { authorizationStyle: style } : {}),
    ...(balancesURef ? { balancesURef } : {}),
    entryPoints,
  };
}

/**
 * CEP-18 balance of an account (read-only), from the Odra `balances`
 * dictionary (item key base64 of the account Key, as token-probe.ts reads
 * it); 0 when the account has no entry. Throws when the token has no such
 * dictionary or the read fails.
 */
export async function readTokenBalance(rpc: CasperRpc, info: Pick<TokenInfo, "packageHash" | "balancesURef">, accountHash: string): Promise<bigint> {
  if (!info.balancesURef) throw new Error(`hash-${info.packageHash} has no \`balances\` dictionary`);
  const key = dictionaryAddress(info.balancesURef, balanceItemKey(accountHash));
  try {
    return parseU256(await rpc.call<StoredValue>("query_global_state", { key, path: [] }), "balance");
  } catch (err) {
    if (isValueNotFound(err)) return 0n;
    throw err;
  }
}

/** Whether the token has entry point `name` with exactly these arguments (names and CLTypes, in order). */
export function hasEntryPoint(info: Pick<TokenInfo, "entryPoints">, name: string, args: ReadonlyArray<readonly [string, unknown]>): boolean {
  const actual = info.entryPoints.get(name);
  if (!actual || actual.length !== args.length) return false;
  return args.every(([argName, type], i) => actual[i]![0] === argName && actual[i]![1] === JSON.stringify(type));
}

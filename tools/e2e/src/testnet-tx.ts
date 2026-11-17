import casperSdk from "casper-js-sdk";
import { isValueNotFound, RpcNodeError, type CasperRpc } from "@cascet/gateway";
import { CSPR_DECIMALS, formatAmount, parseAmount } from "./amounts.js";
import { NETWORKS } from "./facilitator-env.js";
import { DEFINITE_REJECTION_CODES } from "./settlement.js";

const { TransactionWrapper } = casperSdk;
type TransactionT = InstanceType<typeof casperSdk.Transaction>;

/**
 * Shared pieces of the testnet maintainer scripts that sign (wrap-wcspr,
 * fund-token): strict argument parsing, the testnet-only guard, read-only
 * account reads, and submission. Those scripts are dry runs unless --send is
 * given; everything here except {@link submitTransaction} only reads.
 */

export const TESTNET_NETWORK = "casper:casper-test";
export const TESTNET_CHAIN_NAME = NETWORKS["casper:casper-test"].chainName;
export const TESTNET_EXPLORER = NETWORKS["casper:casper-test"].explorer;

/** A command-line mistake: the script prints it with its usage and exits 1. */
export class UsageError extends Error {
  override name = "UsageError";
}

export interface ParsedCli {
  positionals: string[];
  flags: Map<string, string | true>;
}

export interface CliSpec {
  /** Flags without a value, e.g. "send". */
  booleans?: readonly string[];
  /** Flags with a value (`--name value` or `--name=value`), e.g. "gas-cspr". */
  values?: readonly string[];
}

/**
 * Strict `--flag` parsing: unknown or repeated flags and missing values are
 * errors; `--` ends the flags. A leading `--` is dropped (pnpm passes the one
 * in `pnpm <script> -- <args>` through).
 */
export function parseCli(argvIn: readonly string[], spec: CliSpec): ParsedCli {
  const argv = argvIn[0] === "--" ? argvIn.slice(1) : argvIn;
  const booleans = new Set(spec.booleans ?? []);
  const values = new Set(spec.values ?? []);
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (flags.has(name)) throw new UsageError(`--${name} is given twice`);
    if (booleans.has(name)) {
      if (eq >= 0) throw new UsageError(`--${name} takes no value`);
      flags.set(name, true);
    } else if (values.has(name)) {
      const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "" || (eq < 0 && value.startsWith("--"))) throw new UsageError(`--${name} needs a value`);
      flags.set(name, value);
    } else {
      throw new UsageError(`unknown option --${name}`);
    }
  }
  return { positionals, flags };
}

/** The value of a value flag, or undefined. */
export function flagValue(cli: ParsedCli, name: string): string | undefined {
  const v = cli.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

type Env = Record<string, string | undefined>;

/**
 * Refuse every mainnet selection: these scripts sign with testnet keys and move
 * testnet funds only. `--network`, CASCET_NETWORK and CASCET_NET must be unset
 * or name the testnet.
 */
export function assertTestnetSelection(env: Env, networkFlag?: string): void {
  const checks: Array<[string, string | undefined, string]> = [
    ["--network", networkFlag?.trim(), TESTNET_NETWORK],
    ["CASCET_NETWORK", env["CASCET_NETWORK"]?.trim(), TESTNET_NETWORK],
    ["CASCET_NET", env["CASCET_NET"]?.trim(), "testnet"],
  ];
  for (const [source, value, testnet] of checks) {
    if (value && value !== testnet) {
      throw new UsageError(`${source}=${value.slice(0, 40)}: this script runs on Casper testnet only (${TESTNET_NETWORK}) and refuses mainnet`);
    }
  }
}

/** CASCET_RPC_URL (an http(s) URL) or the public testnet node. */
export function testnetRpcUrl(env: Env): string {
  const raw = env["CASCET_RPC_URL"]?.trim();
  if (!raw) return NETWORKS["casper:casper-test"].rpcUrl;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`CASCET_RPC_URL must be an http(s) URL, got "${raw.slice(0, 80)}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UsageError(`CASCET_RPC_URL must be an http(s) URL, got "${raw.slice(0, 80)}"`);
  return raw;
}

/** Read-only: the chain a node serves (`info_get_status` chainspec name), as the node answers it. */
export async function nodeChainName(rpc: CasperRpc): Promise<unknown> {
  const status = await rpc.call<{ chainspec_name?: unknown }>("info_get_status", []);
  return status?.chainspec_name;
}

/**
 * Read-only: the node must serve the testnet (`info_get_status` chainspec name
 * "casper-test"). A transaction signed for "casper-test" is refused by mainnet
 * nodes anyway; this catches a misconfigured CASCET_RPC_URL before any signing.
 */
export async function assertTestnetNode(rpc: CasperRpc): Promise<void> {
  const name = await nodeChainName(rpc);
  if (name !== TESTNET_CHAIN_NAME) {
    throw new Error(`${rpc.url} serves chain "${String(name).slice(0, 40)}", not ${TESTNET_CHAIN_NAME}: refusing (testnet only)`);
  }
}

/** Read-only: CSPR balance (motes) of an account's main purse. */
export async function readCsprBalance(rpc: CasperRpc, accountHash: string): Promise<bigint> {
  const result = await rpc.call<{ balance?: unknown }>("query_balance", {
    purse_identifier: { main_purse_under_account_hash: `account-hash-${accountHash}` },
  });
  if (typeof result?.balance !== "string" || !/^\d+$/.test(result.balance)) throw new Error("query_balance: no balance in the answer");
  return BigInt(result.balance);
}

/** Read-only: the names of an account's named keys, or undefined when the account does not exist. */
export async function readAccountNamedKeys(rpc: CasperRpc, accountHash: string): Promise<string[] | undefined> {
  let result: { stored_value?: { Account?: { named_keys?: Array<{ name?: unknown }> } } };
  try {
    result = await rpc.call("query_global_state", { key: `account-hash-${accountHash}`, path: [] });
  } catch (err) {
    if (isValueNotFound(err)) return undefined;
    throw err;
  }
  const account = result?.stored_value?.Account;
  if (!account) throw new Error(`account-hash-${accountHash.slice(0, 10)}… is not an account`);
  return (account.named_keys ?? []).map(k => String(k.name));
}

/**
 * A gas limit from `--gas-cspr` (decimal CSPR), or the default; refused outside
 * [minMotes, maxMotes]: a limit that runs out reverts and burns all of it.
 */
export function gasLimitFromFlag(flag: string | undefined, defaultMotes: bigint, minMotes: bigint, maxMotes: bigint): bigint {
  let motes: bigint;
  try {
    motes = flag === undefined ? defaultMotes : parseAmount(flag, CSPR_DECIMALS, "--gas-cspr");
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (motes < minMotes || motes > maxMotes) {
    throw new UsageError(
      `--gas-cspr must be between ${formatAmount(minMotes, CSPR_DECIMALS)} and ${formatAmount(maxMotes, CSPR_DECIMALS)} CSPR`,
    );
  }
  return motes;
}

export type SubmitOutcome =
  | { kind: "accepted"; hash: string }
  | { kind: "rejected"; error: string }
  | { kind: "unknown"; hash: string; error: string };

/**
 * Submit a signed transaction (`account_put_transaction`). A JSON-RPC error
 * that proves rejection means nothing was submitted; any other failure leaves
 * the outcome unknown (it may still execute: look the hash up before retrying).
 */
export async function submitTransaction(rpc: CasperRpc, tx: TransactionT): Promise<SubmitOutcome> {
  const hash = tx.hash.toHex();
  try {
    await rpc.call("account_put_transaction", { transaction: TransactionWrapper.toJSON(tx.getTransactionWrapper()) });
    return { kind: "accepted", hash };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (err instanceof RpcNodeError && DEFINITE_REJECTION_CODES.has(err.code)) return { kind: "rejected", error };
    return { kind: "unknown", hash, error };
  }
}

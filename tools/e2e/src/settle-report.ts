import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCasperRpc, type CasperRpc } from "@cascet/gateway";
import { NETWORKS, type CasperNetwork } from "./facilitator-env.js";
import {
  defaultLimitFor,
  formatCostTable,
  formatGasSuggestions,
  gasSuggestions,
  kindLabel,
  normalizeTransactionHash,
  readTransactionReport,
  type ReadTransactionOptions,
  type TransactionReport,
} from "./gas-report.js";
import { flagValue, nodeChainName, parseCli, UsageError } from "./testnet-tx.js";

/**
 * Measured gas of settle transactions (and anchors, wraps and transfers):
 * limit, consumed, refund and net cost per transaction, and per kind a gas
 * limit suggested from the measurements, ceil(1.3 × max consumed), next to
 * the configured default. Run it on the hashes of 3-5 testnet settles of one
 * style (demo-real prints them) to set DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE.
 *
 *   pnpm --filter @cascet/e2e settle-report <tx-hash> [<tx-hash> …]
 *   pnpm --filter @cascet/e2e settle-report --network casper:casper <tx-hash> …
 *
 * Read-only (`info_get_status`, `info_get_transaction`); it never signs.
 * CASCET_RPC_URL picks the node, which must serve the chain --network names:
 * the report is labelled and linked by --network.
 */

const USAGE = `usage: pnpm --filter @cascet/e2e settle-report [--network casper:casper-test|casper:casper] <tx-hash> [<tx-hash> …]

Reads each transaction (read-only) and prints its gas: limit, consumed, refund and net cost,
then a suggested limit per kind (settle per authorization style, anchor, wrap, transfer).
CASCET_RPC_URL selects the node (default: the network's public node); it must serve that network.`;

const TAG = "[settle-report]";

function network(flag: string | undefined): CasperNetwork {
  if (flag === undefined || flag === "casper:casper-test") return "casper:casper-test";
  if (flag === "casper:casper") return "casper:casper";
  throw new UsageError("--network must be casper:casper-test or casper:casper");
}

export interface SettleReportDeps {
  /** The node client for `url` (default: createCasperRpc with a 15 s timeout). */
  rpc?: (url: string) => CasperRpc;
  log?: (line: string) => void;
  /** Clock of the transaction reads (tests). */
  read?: Pick<ReadTransactionOptions, "now" | "sleep">;
}

/** The report for `argv`; resolves to the exit code (1 when a transaction has not executed). */
export async function settleReport(argv: string[], env: Record<string, string | undefined>, deps: SettleReportDeps = {}): Promise<number> {
  const log = deps.log ?? (line => console.log(line));
  const cli = parseCli(argv, { booleans: ["help"], values: ["network"] });
  if (cli.flags.has("help")) {
    log(USAGE);
    return 0;
  }
  if (cli.positionals.length === 0) throw new UsageError("give at least one transaction hash");
  let hashes: string[];
  try {
    hashes = [...new Set(cli.positionals.map(normalizeTransactionHash))];
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const net = NETWORKS[network(flagValue(cli, "network"))];
  const url = env["CASCET_RPC_URL"]?.trim() || net.rpcUrl;
  const rpc = deps.rpc ? deps.rpc(url) : createCasperRpc(url, { timeoutMs: 15_000 });

  // The chain label and the explorer links follow --network, so the node must
  // serve that chain: a mainnet CASCET_RPC_URL left in the shell would label
  // mainnet settles casper-test with dead testnet links (and the reverse polls
  // every hash for 20 s on a node that cannot know it).
  const served = await nodeChainName(rpc);
  if (served !== net.chainName) {
    const fits = (Object.keys(NETWORKS) as CasperNetwork[]).find(n => NETWORKS[n].chainName === served);
    throw new Error(
      `${rpc.url} serves chain "${String(served).slice(0, 40)}", not ${net.chainName}: ` +
        (fits ? `pass --network ${fits} for its transactions, or ` : "") +
        `point CASCET_RPC_URL at a ${net.chainName} node`,
    );
  }

  const now = deps.read?.now ?? Date.now;
  const reports: TransactionReport[] = [];
  for (const hash of hashes) reports.push(await readTransactionReport(rpc, hash, { deadlineMs: now() + 20_000, ...deps.read }));

  log(`\nGas of ${reports.length} transaction${reports.length === 1 ? "" : "s"} on ${net.chainName} (${rpc.url})\n`);
  for (const line of formatCostTable(reports.map(report => ({ label: kindLabel(report.kind), report })))) log(line);
  const suggestions = gasSuggestions(reports, defaultLimitFor);
  if (suggestions.length > 0) {
    log("");
    for (const line of formatGasSuggestions(suggestions)) log(line);
  }
  for (const report of reports) log(`  ${report.hash}: ${net.explorer}/transaction/${report.hash}`);
  return reports.every(r => r.cost) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  settleReport(process.argv.slice(2), process.env).then(
    code => {
      process.exitCode = code;
    },
    (err: unknown) => {
      if (err instanceof UsageError) console.error(`${TAG} ${err.message}\n\n${USAGE}`);
      else console.error(`${TAG} ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}

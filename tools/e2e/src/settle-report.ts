import { createCasperRpc } from "@cascet/gateway";
import { NETWORKS, type CasperNetwork } from "./facilitator-env.js";
import {
  defaultLimitFor,
  formatCostTable,
  formatGasSuggestions,
  gasSuggestions,
  kindLabel,
  normalizeTransactionHash,
  readTransactionReport,
  type TransactionReport,
} from "./gas-report.js";
import { flagValue, parseCli, UsageError } from "./testnet-tx.js";

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
 * Read-only (`info_get_transaction`); it never signs. CASCET_RPC_URL picks the node.
 */

const USAGE = `usage: pnpm --filter @cascet/e2e settle-report [--network casper:casper-test|casper:casper] <tx-hash> [<tx-hash> …]

Reads each transaction (read-only) and prints its gas: limit, consumed, refund and net cost,
then a suggested limit per kind (settle per authorization style, anchor, wrap, transfer).
CASCET_RPC_URL selects the node (default: the network's public node).`;

const TAG = "[settle-report]";

function network(flag: string | undefined): CasperNetwork {
  if (flag === undefined || flag === "casper:casper-test") return "casper:casper-test";
  if (flag === "casper:casper") return "casper:casper";
  throw new UsageError("--network must be casper:casper-test or casper:casper");
}

async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const cli = parseCli(argv, { booleans: ["help"], values: ["network"] });
  if (cli.flags.has("help")) {
    console.log(USAGE);
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
  const rpc = createCasperRpc(env["CASCET_RPC_URL"]?.trim() || net.rpcUrl, { timeoutMs: 15_000 });

  const reports: TransactionReport[] = [];
  for (const hash of hashes) reports.push(await readTransactionReport(rpc, hash, { deadlineMs: Date.now() + 20_000 }));

  console.log(`\nGas of ${reports.length} transaction${reports.length === 1 ? "" : "s"} on ${net.chainName} (${rpc.url})\n`);
  for (const line of formatCostTable(reports.map(report => ({ label: kindLabel(report.kind), report })))) console.log(line);
  const suggestions = gasSuggestions(reports, defaultLimitFor);
  if (suggestions.length > 0) {
    console.log("");
    for (const line of formatGasSuggestions(suggestions)) console.log(line);
  }
  for (const report of reports) console.log(`  ${report.hash}: ${net.explorer}/transaction/${report.hash}`);
  return reports.every(r => r.cost) ? 0 : 1;
}

main(process.argv.slice(2), process.env).then(
  code => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof UsageError) console.error(`${TAG} ${err.message}\n\n${USAGE}`);
    else console.error(`${TAG} ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);

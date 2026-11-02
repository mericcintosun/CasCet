import { resolve } from "node:path";
import { createCasperRpc, TokenProbe } from "@cascet/gateway";
import { CSPR_DECIMALS, formatAmount, parseAmount } from "./amounts.js";
import { formatCostTable, readTransactionReport } from "./gas-report.js";
import { loadSecretKeyFile, type KeyAlgo } from "./key-file.js";
import { loadOdraProxyWasm, locateOdraProxyWasm, ODRA_PROXY_WASM } from "./odra-proxy.js";
import {
  assertTestnetNode,
  assertTestnetSelection,
  flagValue,
  gasLimitFromFlag,
  parseCli,
  readAccountNamedKeys,
  readCsprBalance,
  submitTransaction,
  TESTNET_CHAIN_NAME,
  TESTNET_EXPLORER,
  testnetRpcUrl,
  UsageError,
} from "./testnet-tx.js";
import { hasEntryPoint, readTokenInfo } from "./token-info.js";
import {
  buildWrapTransaction,
  DEFAULT_WRAP_GAS_MOTES,
  formatWrapPlan,
  MAX_WRAP_GAS_MOTES,
  MIN_WRAP_GAS_MOTES,
  planWrap,
  TESTNET_WCSPR,
} from "./wcspr.js";

/**
 * Wrap testnet CSPR into the official Wrapped CSPR (WCSPR), the CEP-3009 token
 * the hosted CSPR.cloud facilitator settles, by calling its payable `deposit`
 * entry point through Odra's proxy session (odra-proxy.ts). The WCSPR is minted
 * to the signing account; hand it to a buyer with fund-token.
 *
 * Dry run by default: it reads the chain (read-only), checks the token, the
 * account and the proxy wasm, and prints the expected cost. Nothing is signed
 * or sent without --send. Testnet only: it refuses any mainnet selection and
 * any node that does not serve casper-test.
 *
 *   pnpm --filter @cascet/e2e wrap-wcspr 5            # dry run
 *   pnpm --filter @cascet/e2e wrap-wcspr 5 --send     # sign and submit
 *
 * Signs with --key (default: the CasCet testnet deployer key,
 * contracts/keys/deployer_secret_key.pem). CASCET_RPC_URL picks the node.
 */

const USAGE = `usage: pnpm --filter @cascet/e2e wrap-wcspr <cspr> [--send] [--gas-cspr <limit>] [--key <pem>]
                                            [--key-algo ed25519|secp256k1] [--proxy-wasm <path>]

  <cspr>          testnet CSPR to wrap, e.g. 5 or 2.5 (minted 1:1 as WCSPR to the signer)
  --send          sign and submit; without it nothing is signed or sent (dry run)
  --gas-cspr      gas limit in CSPR (default ${formatAmount(DEFAULT_WRAP_GAS_MOTES, CSPR_DECIMALS)}; charged up front, 75% of the unused part refunded)
  --key           signer PEM, absolute path (default: contracts/keys/deployer_secret_key.pem)
  --key-algo      ed25519 (default) or secp256k1
  --proxy-wasm    path to ${ODRA_PROXY_WASM.file} of ${ODRA_PROXY_WASM.crate} (default: the local cargo registry)

Testnet only. CASCET_RPC_URL selects the node (default: the public testnet node).`;

const ROOT = resolve(import.meta.dirname, "../../..");
const TAG = "[wrap-wcspr]";

function keyAlgo(flag: string | undefined): KeyAlgo {
  if (flag === undefined || flag === "ed25519") return "ed25519";
  if (flag === "secp256k1") return "secp256k1";
  throw new UsageError("--key-algo must be ed25519 or secp256k1");
}

async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const cli = parseCli(argv, { booleans: ["send", "help"], values: ["gas-cspr", "key", "key-algo", "proxy-wasm", "network"] });
  if (cli.flags.has("help")) {
    console.log(USAGE);
    return 0;
  }
  assertTestnetSelection(env, flagValue(cli, "network"));
  if (cli.positionals.length !== 1) throw new UsageError("give exactly one amount of CSPR to wrap");
  let depositMotes: bigint;
  try {
    depositMotes = parseAmount(cli.positionals[0]!, CSPR_DECIMALS, "the amount to wrap");
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (depositMotes <= 0n) throw new UsageError("the amount to wrap must be more than 0 CSPR");
  const gasLimitMotes = gasLimitFromFlag(flagValue(cli, "gas-cspr"), DEFAULT_WRAP_GAS_MOTES, MIN_WRAP_GAS_MOTES, MAX_WRAP_GAS_MOTES);
  const algo = keyAlgo(flagValue(cli, "key-algo"));
  const keyFlag = flagValue(cli, "key");
  const keyPath = keyFlag ? resolve(keyFlag) : resolve(ROOT, "contracts/keys/deployer_secret_key.pem");
  const send = cli.flags.has("send");

  const rpc = createCasperRpc(testnetRpcUrl(env), { timeoutMs: 15_000 });
  await assertTestnetNode(rpc);

  const signer = loadSecretKeyFile(keyPath, algo, "signer", message => console.warn(`${TAG} warning: ${message}`));
  const publicKey = signer.publicKey.toHex();
  const accountHash = signer.publicKey.accountHash().toHex();

  // The token, read before anything is signed: a different ABI or chain stops here.
  const token = await readTokenInfo(rpc, TESTNET_WCSPR.packageHash);
  const tokenProblems: string[] = [];
  if (!hasEntryPoint(token, "deposit", [])) tokenProblems.push("it has no payable `deposit()` entry point");
  if (token.name !== TESTNET_WCSPR.name) tokenProblems.push(`its name is ${JSON.stringify(token.name)}, not "${TESTNET_WCSPR.name}"`);
  if (token.chainName !== TESTNET_WCSPR.network) tokenProblems.push(`its chain_name is ${JSON.stringify(token.chainName)}`);
  if (token.decimals !== TESTNET_WCSPR.decimals) tokenProblems.push(`it has ${String(token.decimals)} decimals`);
  if (token.authorizationStyle !== "cep3009-value") tokenProblems.push("its transfer_with_authorization does not take `value`");
  if (tokenProblems.length > 0) {
    throw new Error(`hash-${TESTNET_WCSPR.packageHash} no longer looks like testnet Wrapped CSPR: ${tokenProblems.join("; ")}`);
  }

  let csprMotes: bigint;
  try {
    csprMotes = await readCsprBalance(rpc, accountHash);
  } catch (err) {
    throw new Error(
      `cannot read the CSPR balance of account-hash-${accountHash} (${err instanceof Error ? err.message : String(err)}); ` +
        "a new account must be funded from the testnet faucet first",
    );
  }
  const [wcsprRaw, namedKeys] = await Promise.all([
    new TokenProbe(rpc).balanceOf(TESTNET_WCSPR.packageHash, accountHash),
    readAccountNamedKeys(rpc, accountHash).catch(() => undefined),
  ]);
  const hasCargoPurse = namedKeys ? namedKeys.includes("__cargo_purse") : undefined;
  const plan = planWrap(depositMotes, gasLimitMotes, hasCargoPurse);

  const problems: string[] = [];
  if (csprMotes < plan.requiredBalanceMotes) {
    problems.push(
      `the signer holds ${formatAmount(csprMotes, CSPR_DECIMALS)} CSPR, less than the ${formatAmount(plan.requiredBalanceMotes, CSPR_DECIMALS)} ` +
        "CSPR needed (deposit + gas limit)",
    );
  }
  let wasm: Uint8Array | undefined;
  let wasmPath: string | undefined;
  try {
    wasmPath = locateOdraProxyWasm({ ...(flagValue(cli, "proxy-wasm") ? { explicitPath: resolve(flagValue(cli, "proxy-wasm")!) } : {}) });
    wasm = loadOdraProxyWasm(wasmPath);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }

  console.log(`\nWrap ${formatAmount(depositMotes, CSPR_DECIMALS)} CSPR into ${TESTNET_WCSPR.name} on Casper testnet${send ? "" : " (DRY RUN)"}\n`);
  console.log(`  token:    ${token.name} (${token.symbol}) hash-${token.packageHash}, contract ${token.contractHash.slice(0, 12)}…, ${token.authorizationStyle}`);
  console.log(`  signer:   ${publicKey} (account-hash-${accountHash})`);
  console.log(`  balances: ${formatAmount(csprMotes, CSPR_DECIMALS)} CSPR, ${formatAmount(wcsprRaw, TESTNET_WCSPR.decimals)} ${TESTNET_WCSPR.symbol}`);
  console.log(
    `  session:  ${ODRA_PROXY_WASM.crate}/${ODRA_PROXY_WASM.file} (sha256 ${ODRA_PROXY_WASM.sha256.slice(0, 12)}…)` +
      (wasmPath && wasm ? `, found at ${wasmPath}` : ""),
  );
  console.log(`  node:     ${rpc.url} (casper-test)\n`);
  for (const line of formatWrapPlan(plan)) console.log(line);
  console.log("");
  for (const problem of problems) console.error(`${TAG} problem: ${problem}`);

  if (!send) {
    console.log(`Dry run: nothing was signed or sent.${problems.length === 0 ? " Re-run with --send to wrap." : ""}`);
    return problems.length === 0 ? 0 : 1;
  }
  if (problems.length > 0 || !wasm) {
    console.error(`${TAG} not sending: fix the problems above first`);
    return 1;
  }

  const tx = buildWrapTransaction(wasm, depositMotes, { initiatorPublicKey: publicKey, chainName: TESTNET_CHAIN_NAME, paymentMotes: gasLimitMotes });
  tx.sign(signer);
  const outcome = await submitTransaction(rpc, tx);
  if (outcome.kind === "rejected") {
    console.error(`${TAG} the node rejected the transaction (nothing was submitted): ${outcome.error}`);
    return 1;
  }
  console.log(`submitted ${outcome.hash}\n  ${TESTNET_EXPLORER}/transaction/${outcome.hash}`);
  if (outcome.kind === "unknown") {
    console.warn(`${TAG} warning: the submission's outcome is unknown (${outcome.error}); looking the hash up before anything else`);
  }

  const report = await readTransactionReport(rpc, outcome.hash, { deadlineMs: Date.now() + 180_000, pollMs: 4_000 });
  console.log("");
  for (const line of formatCostTable([{ label: "wrap", report }])) console.log(line);
  if (!report.cost) {
    console.error(`${TAG} not executed within 3 minutes (${report.note ?? "pending"}); check the explorer before wrapping again`);
    return 1;
  }
  if (report.cost.status !== "success") return 1;
  const after = await new TokenProbe(rpc).balanceOf(TESTNET_WCSPR.packageHash, accountHash);
  console.log(`\nwrapped: the signer now holds ${formatAmount(after, TESTNET_WCSPR.decimals)} ${TESTNET_WCSPR.symbol}`);
  console.log(
    `give some to a buyer: pnpm --filter @cascet/e2e fund-token ${TESTNET_WCSPR.packageHash} <buyer account hash> <amount> --send`,
  );
  return 0;
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

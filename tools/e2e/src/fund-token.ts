import { resolve } from "node:path";
import { createCasperRpc } from "@cascet/gateway";
import { CSPR_DECIMALS, formatAmount, formatCspr, parseAmount } from "./amounts.js";
import {
  buildCep18Transfer,
  CEP18_TRANSFER_ARGS,
  DEFAULT_TRANSFER_GAS_MOTES,
  expectedTransferGasMotes,
  MAX_TRANSFER_GAS_MOTES,
  MIN_TRANSFER_GAS_MOTES,
} from "./cep18-transfer.js";
import { normalizeAccountHash } from "./facilitator-roles.js";
import { formatCostTable, readTransactionReport } from "./gas-report.js";
import { loadSecretKeyFile, type KeyAlgo } from "./key-file.js";
import {
  assertTestnetNode,
  assertTestnetSelection,
  flagValue,
  gasLimitFromFlag,
  parseCli,
  readCsprBalance,
  submitTransaction,
  TESTNET_CHAIN_NAME,
  TESTNET_EXPLORER,
  TESTNET_NETWORK,
  testnetRpcUrl,
  UsageError,
} from "./testnet-tx.js";
import { hasEntryPoint, readTokenBalance, readTokenInfo } from "./token-info.js";

/**
 * Transfer CEP-18 tokens from the signer (default: the CasCet testnet
 * deployer, which holds CasCet's x402 token treasury and wraps WCSPR with
 * wrap-wcspr) to a buyer's account, so that wallet can pay real x402
 * micropayments. Works for any CEP-18 token with `transfer(recipient, amount)`:
 * CasCet's x402 token (legacy-amount) and Wrapped CSPR (cep3009-value) alike.
 *
 *   pnpm --filter @cascet/e2e fund-token <token-package-hash> <recipient-account-hash> <amount>          # dry run
 *   pnpm --filter @cascet/e2e fund-token <token-package-hash> <recipient-account-hash> <amount> --send   # sign and submit
 *
 * `amount` is in whole tokens ("10", "0.5") at the token's on-chain decimals,
 * or in raw units with --raw. Dry run by default: it reads the chain
 * (read-only) and prints what it would send; nothing is signed or sent
 * without --send. Testnet only.
 */

const USAGE = `usage: pnpm --filter @cascet/e2e fund-token <token-package-hash> <recipient-account-hash> <amount>
                                            [--raw] [--send] [--gas-cspr <limit>] [--key <pem>] [--key-algo ed25519|secp256k1]

  <token-package-hash>      CEP-18 package, e.g. cb65a928… (CasCet X402 Token) or 3d80df21… (Wrapped CSPR)
  <recipient-account-hash>  the buyer: "00" + 64 hex, account-hash-<hex> or 64 hex (never a public key)
  <amount>                  whole tokens at the token's decimals (e.g. 10 or 0.5), or raw units with --raw
  --send                    sign and submit; without it nothing is signed or sent (dry run)
  --gas-cspr                gas limit in CSPR (default ${formatAmount(DEFAULT_TRANSFER_GAS_MOTES, CSPR_DECIMALS)})
  --key                     signer PEM, absolute path (default: contracts/keys/deployer_secret_key.pem)
  --key-algo                ed25519 (default) or secp256k1

Testnet only. CASCET_RPC_URL selects the node (default: the public testnet node).`;

const ROOT = resolve(import.meta.dirname, "../../..");
const TAG = "[fund-token]";

function keyAlgo(flag: string | undefined): KeyAlgo {
  if (flag === undefined || flag === "ed25519") return "ed25519";
  if (flag === "secp256k1") return "secp256k1";
  throw new UsageError("--key-algo must be ed25519 or secp256k1");
}

function packageHashArg(value: string): string {
  const bare = value.trim().toLowerCase().replace(/^(hash-|contract-package-|package-|0x)/, "");
  if (!/^[0-9a-f]{64}$/.test(bare)) throw new UsageError(`the token must be a contract package hash (64 hex), got "${value.slice(0, 80)}"`);
  return bare;
}

function recipientArg(value: string): string {
  try {
    return normalizeAccountHash(value);
  } catch {
    throw new UsageError(
      `the recipient must be an account hash ("00" + 64 hex, account-hash-<hex> or 64 hex), got "${value.slice(0, 80)}"; ` +
        "a public key is not one (npx @cascet/cli account-hash <public-key> prints it)",
    );
  }
}

async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const cli = parseCli(argv, { booleans: ["send", "raw", "help"], values: ["gas-cspr", "key", "key-algo", "network"] });
  if (cli.flags.has("help")) {
    console.log(USAGE);
    return 0;
  }
  assertTestnetSelection(env, flagValue(cli, "network"));
  if (cli.positionals.length !== 3) throw new UsageError("give the token package hash, the recipient account hash and the amount");
  const [tokenArg, recipientInput, amountArg] = cli.positionals as [string, string, string];
  const packageHash = packageHashArg(tokenArg);
  const recipient = recipientArg(recipientInput);
  const gasLimitMotes = gasLimitFromFlag(flagValue(cli, "gas-cspr"), DEFAULT_TRANSFER_GAS_MOTES, MIN_TRANSFER_GAS_MOTES, MAX_TRANSFER_GAS_MOTES);
  const algo = keyAlgo(flagValue(cli, "key-algo"));
  const keyFlag = flagValue(cli, "key");
  const keyPath = keyFlag ? resolve(keyFlag) : resolve(ROOT, "contracts/keys/deployer_secret_key.pem");
  const send = cli.flags.has("send");

  const rpc = createCasperRpc(testnetRpcUrl(env), { timeoutMs: 15_000 });
  await assertTestnetNode(rpc);

  const signer = loadSecretKeyFile(keyPath, algo, "signer", message => console.warn(`${TAG} warning: ${message}`));
  const publicKey = signer.publicKey.toHex();
  const sender = signer.publicKey.accountHash().toHex();
  if (sender === recipient) throw new UsageError("the recipient is the signer itself");

  // The token, read before anything is signed.
  const token = await readTokenInfo(rpc, packageHash);
  if (!hasEntryPoint(token, "transfer", CEP18_TRANSFER_ARGS)) {
    throw new Error(`hash-${packageHash} has no CEP-18 transfer(recipient: Key, amount: U256) entry point`);
  }
  if (token.chainName !== undefined && token.chainName !== TESTNET_NETWORK) {
    throw new Error(`hash-${packageHash} signs authorizations for ${token.chainName}, not ${TESTNET_NETWORK}`);
  }
  const raw = cli.flags.has("raw");
  if (!raw && token.decimals === undefined) {
    throw new UsageError(`hash-${packageHash} has no decimals named key: give the amount in raw units with --raw`);
  }
  const decimals = raw ? 0 : token.decimals!;
  let amountRaw: bigint;
  try {
    amountRaw = parseAmount(amountArg, decimals, "the amount");
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (amountRaw <= 0n) throw new UsageError("the amount must be more than 0");
  const shown = (units: bigint) =>
    token.decimals !== undefined ? `${formatAmount(units, token.decimals)} ${token.symbol ?? "tokens"}` : `${units} raw units`;

  // Balances: an unreadable token balance only warns (non-Odra layouts), a known shortfall refuses.
  const tokenBalance = (account: string) =>
    readTokenBalance(rpc, token, account).then(
      units => ({ units }),
      (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
    );
  const [senderTokens, recipientTokens] = await Promise.all([tokenBalance(sender), tokenBalance(recipient)]);
  const balanceText = (b: { units: bigint } | { error: string }) => ("units" in b ? shown(b.units) : "unknown token balance");
  let csprMotes: bigint;
  try {
    csprMotes = await readCsprBalance(rpc, sender);
  } catch (err) {
    throw new Error(`cannot read the signer's CSPR balance (${err instanceof Error ? err.message : String(err)})`);
  }

  const problems: string[] = [];
  if ("units" in senderTokens && senderTokens.units < amountRaw) {
    problems.push(`the signer holds ${shown(senderTokens.units)}, less than the ${shown(amountRaw)} to send`);
  }
  if ("error" in senderTokens) console.warn(`${TAG} warning: cannot read the signer's token balance (${senderTokens.error})`);
  if (csprMotes < gasLimitMotes) {
    problems.push(`the signer holds ${formatAmount(csprMotes, CSPR_DECIMALS)} CSPR, less than the ${formatAmount(gasLimitMotes, CSPR_DECIMALS)} CSPR gas limit`);
  }

  console.log(`\nTransfer ${shown(amountRaw)} (${token.name ?? `hash-${packageHash}`}) on Casper testnet${send ? "" : " (DRY RUN)"}\n`);
  console.log(
    `  token:   ${token.name ?? "(no name)"} (${token.symbol ?? "?"}) hash-${packageHash}, ${token.decimals ?? "?"} decimals` +
      (token.authorizationStyle ? `, ${token.authorizationStyle}` : ""),
  );
  console.log(`  from:    ${publicKey} (account-hash-${sender}): ${formatAmount(csprMotes, CSPR_DECIMALS)} CSPR, ${balanceText(senderTokens)}`);
  console.log(`  to:      account-hash-${recipient}: ${balanceText(recipientTokens)}`);
  console.log(`  amount:  ${shown(amountRaw)} = ${amountRaw} raw units`);
  console.log(
    `  gas:     limit ${formatAmount(gasLimitMotes, CSPR_DECIMALS)} CSPR, charged up front; a recorded transfer consumed ~0.46 CSPR, ` +
      `so ~${formatCspr(expectedTransferGasMotes(gasLimitMotes), 2)} CSPR net on success (the whole limit if it reverts)`,
  );
  console.log(`  node:    ${rpc.url} (casper-test)\n`);
  for (const problem of problems) console.error(`${TAG} problem: ${problem}`);

  if (!send) {
    console.log(`Dry run: nothing was signed or sent.${problems.length === 0 ? " Re-run with --send to transfer." : ""}`);
    return problems.length === 0 ? 0 : 1;
  }
  if (problems.length > 0) {
    console.error(`${TAG} not sending: fix the problems above first`);
    return 1;
  }

  const tx = buildCep18Transfer(packageHash, recipient, amountRaw, {
    initiatorPublicKey: publicKey,
    chainName: TESTNET_CHAIN_NAME,
    paymentMotes: gasLimitMotes,
  });
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
  for (const line of formatCostTable([{ label: "transfer", report }])) console.log(line);
  if (!report.cost) {
    console.error(`${TAG} not executed within 3 minutes (${report.note ?? "pending"}); check the explorer before sending again`);
    return 1;
  }
  if (report.cost.status !== "success") return 1;
  console.log(`\nthe recipient now holds ${balanceText(await tokenBalance(recipient))}`);
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

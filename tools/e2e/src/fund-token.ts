import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import casperSdk from "casper-js-sdk";

/**
 * Transfer real Cep18X402 tokens from the CasCet deployer (which holds the
 * treasury) to a recipient account, so wallets other than the demo agent (e.g.
 * the cascade's analyst) can pay real x402 micropayments on-chain.
 *
 * Usage:
 *   pnpm --filter @cascet/e2e fund-token <recipient-account-hash-hex> [tokens]
 *
 * `tokens` is a human amount (default 200) at the token's 9 decimals.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const NODE_URL = "https://node.testnet.casper.network/rpc";
const TOKEN_PACKAGE = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
const DECIMALS = 9n;

const recipientHash = (process.argv[2] ?? "").replace(/^account-hash-/, "").replace(/^00/, "");
if (!/^[0-9a-fA-F]{64}$/.test(recipientHash)) {
  console.error("❌ usage: fund-token <recipient-account-hash-hex(64)> [tokens]");
  process.exit(1);
}
const tokens = BigInt(process.argv[3] ?? "200");
const amountRaw = (tokens * 10n ** DECIMALS).toString();

const deployerPem = readFileSync(resolve(ROOT, "contracts/keys/deployer_secret_key.pem"), "utf8");
const deployer = casperSdk.PrivateKey.fromPem(deployerPem, casperSdk.KeyAlgorithm.ED25519);

const recipientKey = casperSdk.Key.newKey("account-hash-" + recipientHash);
const args = casperSdk.Args.fromMap({
  recipient: casperSdk.CLValue.newCLKey(recipientKey),
  amount: casperSdk.CLValue.newCLUInt256(amountRaw),
});

const tx = new casperSdk.ContractCallBuilder()
  .from(deployer.publicKey)
  .byPackageHash(TOKEN_PACKAGE)
  .entryPoint("transfer")
  .runtimeArgs(args)
  .chainName("casper-test")
  .payment(5_000_000_000)
  .build();

tx.sign(deployer);

const rpc = new casperSdk.RpcClient(new casperSdk.HttpHandler(NODE_URL));
console.log(`→ transferring ${tokens} tokens (${amountRaw} raw) → account-hash-${recipientHash}`);
const put = await rpc.putTransaction(tx);
const hash = put.transactionHash.toHex();
console.log(`  submitted tx ${hash}`);
console.log(`  https://testnet.cspr.live/transaction/${hash}`);
console.log("  (allow ~1 min to finalize, then verify the recipient's ft-token-ownership)");
process.exit(0);

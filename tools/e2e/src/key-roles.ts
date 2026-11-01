import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import casperSdk from "casper-js-sdk";
import { NETWORKS, type CasperNetwork } from "./facilitator-env.js";

const { PrivateKey, KeyAlgorithm } = casperSdk;

/**
 * Offline key-role planner (M07).
 *
 * CasCet's mainnet setup ran ONE hot key as fee payer, seller, anchoring
 * recorder, contract owner and token upgrader. This tool generates fresh
 * ed25519 keys for the three hot/cold roles that must move off that key —
 * fee payer, recorder, seller — into a directory you choose (secret keys
 * mode 600, directory 700, existing files are never overwritten), and prints
 * the on-chain steps that are still needed, as text only.
 *
 * It sends nothing and contacts no node: funding, authorizing and ownership
 * changes are yours to run, on testnet first.
 *
 *   pnpm --filter @cascet/e2e key-roles -- --out ~/cascet-keys/mainnet [--network casper|casper-test]
 */

export type Role = "fee-payer" | "recorder" | "seller";
export const ROLES: readonly Role[] = ["fee-payer", "recorder", "seller"];

export interface RoleKeyInfo {
  role: Role;
  pemPath: string;
  publicKeyHex: string;
  /** Serialized account-hash Key ("00" + 64 hex), the form payTo and the facilitator use. */
  accountKey: string;
}

/**
 * Generate one fresh key per role. Fails before writing anything if any target
 * file exists; secret keys are created exclusively with mode 600.
 */
export function generateRoleKeys(outDir: string): RoleKeyInfo[] {
  const dir = resolve(outDir);
  const created = !existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (created) chmodSync(dir, 0o700);

  const plan = ROLES.map(role => ({
    role,
    pemPath: resolve(dir, `${role}_secret_key.pem`),
    pubPath: resolve(dir, `${role}_public_key_hex`),
  }));
  const taken = plan.flatMap(p => [p.pemPath, p.pubPath]).filter(p => existsSync(p));
  if (taken.length > 0) {
    throw new Error(`refusing to overwrite existing key files: ${taken.join(", ")} — choose an empty directory`);
  }

  return plan.map(({ role, pemPath, pubPath }) => {
    const key = PrivateKey.generate(KeyAlgorithm.ED25519);
    // "wx": create exclusively (no check-then-write race), mode 600 from the start.
    const fd = openSync(pemPath, "wx", 0o600);
    try {
      writeSync(fd, key.toPem());
    } finally {
      closeSync(fd);
    }
    chmodSync(pemPath, 0o600);
    const publicKeyHex = key.publicKey.toHex();
    const pubFd = openSync(pubPath, "wx", 0o644);
    try {
      writeSync(pubFd, `${publicKeyHex}\n`);
    } finally {
      closeSync(pubFd);
    }
    return { role, pemPath, publicKeyHex, accountKey: `00${key.publicKey.accountHash().toHex()}` };
  });
}

/** The remaining on-chain steps, as text. Contains public data only. */
export function renderPlan(keys: RoleKeyInfo[], opts: { network: CasperNetwork; outDir: string }): string {
  const k = (role: Role) => keys.find(x => x.role === role)!;
  const fee = k("fee-payer");
  const rec = k("recorder");
  const sel = k("seller");
  const mainnet = opts.network === "casper:casper";
  const net = NETWORKS[opts.network];
  const owner = mainnet ? NETWORKS["casper:casper"].deployerAccount : "<the testnet deployer account (00…)>";
  const chainName = net.chainName;
  const registry = net.receiptRegistry;
  const accountHashArg = (accountKey: string) => `account-hash-${accountKey.slice(2)}`;

  return [
    `CasCet key-role plan for ${opts.network} — NOTHING has been sent. Every step below is yours to run.`,
    "",
    `Generated keys in ${resolve(opts.outDir)} (secret keys mode 600 — never print, commit or share them):`,
    ...keys.map(x => `  ${x.role.padEnd(9)}  public key ${x.publicKeyHex}\n             account    ${x.accountKey}\n             secret key ${x.pemPath}`),
    "",
    "Roles after the split:",
    `  owner / deployer  ${owner}  existing key; take it OFFLINE (only for authorize / revoke / transfer_ownership / upgrades)`,
    `  fee payer         ${fee.accountKey}  HOT, small float; signs and pays for every settle`,
    `  recorder          ${rec.accountKey}  HOT; anchors receipts in ReceiptRegistry`,
    `  seller (payTo)    ${sel.accountKey}  COLD; only receives payments`,
    "",
    "0. Rehearse every step on testnet first (CASCET_NETWORK=casper:casper-test, the testnet package hashes in docs/onchain.md).",
    "   Verify each command's flags with `casper-client <subcommand> --help` before signing anything.",
    "",
    `1. Fund the fee payer with a limited float only: a native CSPR transfer to ${fee.publicKeyHex}.`,
    "   Size it to about one day of sponsored gas (CASCET_DAILY_GAS_CAP_MOTES, default 500 CSPR); a settle costs about",
    "   3.0 CSPR at the default 4 CSPR limit. Top it up as needed instead of parking a large balance on a hot key.",
    `   e.g. casper-client transfer --node-address ${net.rpcUrl} --chain-name ${chainName} \\`,
    `          --secret-key <treasury key> --target-account ${fee.publicKeyHex} --amount <motes> --transfer-id <id> --payment-amount 100000000`,
    "",
    `2. Authorize the new recorder on ReceiptRegistry ${registry} (signed by the OWNER key):`,
    `   entry point "authorize", argument recorder: Key = ${accountHashArg(rec.accountKey)}`,
    `   then set the gateway's anchoring.keyPath to ${rec.pemPath}.`,
    "",
    "3. Revoke the old recorder (signed by the OWNER key): entry point \"revoke\", argument recorder: Key = the account that",
    "   anchored until now (the deployer — the registry's init made it a recorder). Then stop the old anchoring config.",
    "",
    `4. Point revenue at the cold seller: payTo = ${sel.accountKey} in every gateway config,`,
    `   CASCET_SELLER_ACCOUNT_HASH=${sel.accountKey} for the facilitator. Move any balance still on the old seller`,
    "   account with a CEP-18 transfer signed by that account.",
    "",
    "5. Protect ownership (the deployer also holds the upgrade access of the UNLOCKED x402 token package, which has no",
    "   ownership-transfer entry point):",
    "   a) ReceiptRegistry: entry point \"transfer_ownership\", argument new_owner: Key = a fresh cold owner key",
    "      (generated offline for this purpose; not one of the keys above).",
    "      transfer_ownership keeps the previous owner as an authorized recorder — revoke it afterwards with the new owner.",
    "   b) Deployer account: add associated keys (add_associated_key) and raise the deployment and key_management action",
    "      thresholds (set_action_threshold, via a key-management session WASM) so the single deployer key can no longer",
    "      deploy, upgrade or change keys alone. The associated keys must be NEW keys kept offline, never the fee-payer,",
    "      recorder or seller keys generated above: a leak of such a hot key would then help sign for the owner account.",
    "      (The facilitator refuses to start when its fee payer is an associated key of an owner or seller account.)",
    "      Keep enough keys to reach the thresholds, or the account is locked forever.",
    "",
    "6. Start the facilitator with the separated roles (it refuses to start if the fee payer is an owner or a seller,",
    "   or an associated key of one):",
    `   CASCET_NETWORK=${opts.network} CASCET_FACILITATOR_KEY=${fee.pemPath} \\`,
    `   CASCET_FACILITATOR_TOKEN=$(openssl rand -hex 32) CASCET_SELLER_ACCOUNT_HASH=${sel.accountKey} \\`,
    `   CASCET_OWNER_ACCOUNT_HASH=${owner} pnpm --filter @cascet/e2e facilitator`,
    "   Add the new ReceiptRegistry owner from 5a to CASCET_OWNER_ACCOUNT_HASH (comma list); on mainnet the deployer",
    "   always counts as an owner. Give every gateway the same token as facilitator.apiKey.",
    "",
    "Key compromise runbook: docs/mainnet-readiness.md.",
  ].join("\n");
}

const USAGE = "usage: key-roles --out <dir> [--network casper|casper-test]";

function parseNetwork(n: string | undefined): CasperNetwork {
  if (n === "casper" || n === "casper:casper") return "casper:casper";
  if (n === "casper-test" || n === "casper:casper-test") return "casper:casper-test";
  throw new Error(`--network must be casper or casper-test, got ${String(n)}`);
}

export function parseArgs(argv: string[]): { outDir: string; network: CasperNetwork } {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let outDir: string | undefined;
  let network: CasperNetwork = "casper:casper";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out") outDir = args[++i];
    else if (a === "--network") network = parseNetwork(args[++i]);
    else throw new Error(a === "--help" || a === "-h" ? USAGE : `unknown argument ${a}\n${USAGE}`);
  }
  if (!outDir) throw new Error(USAGE);
  return { outDir, network };
}

async function main(): Promise<void> {
  let args: { outDir: string; network: CasperNetwork };
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  const keys = generateRoleKeys(args.outDir);
  const mode = statSync(resolve(args.outDir)).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    console.warn(`warning: ${resolve(args.outDir)} is accessible by group/others (mode ${mode.toString(8)}); consider chmod 700`);
  }
  console.log(renderPlan(keys, { network: args.network, outDir: args.outDir }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(err => {
    console.error(`key-roles: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

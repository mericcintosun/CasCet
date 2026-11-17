/**
 * Key-role separation rules for the facilitator (M07).
 *
 * On mainnet CasCet ran one hot key as fee payer, seller (payTo), anchoring
 * recorder and contract owner. The facilitator now refuses to start on
 * `casper:casper` when its fee-payer account is an owner account or one of
 * the seller accounts it settles to, so a leaked fee-payer key can no longer
 * also drain revenue or administer the contracts. On testnet the same overlaps
 * only produce warnings, so the demos keep working with one deployer key.
 * (Associated keys, which these account comparisons cannot see, are checked
 * on-chain by account-keys.ts.)
 */

const HEX64 = /^[0-9a-f]{64}$/;

/** Normalize "00"+hex, "account-hash-"+hex or bare hex to a bare 64-hex account hash. */
export function normalizeAccountHash(input: string): string {
  const s = input.trim().toLowerCase().replace(/^0x/, "");
  if (s.startsWith("account-hash-") && HEX64.test(s.slice(13))) return s.slice(13);
  if (/^00[0-9a-f]{64}$/.test(s)) return s.slice(2);
  if (HEX64.test(s)) return s;
  throw new Error(`not an account hash ("00" + 64 hex, account-hash-<hex> or 64 hex): ${input.slice(0, 80)}`);
}

export interface RoleCheckInput {
  network: string;
  /** Account hash of the key that signs and pays for settlement transactions. */
  feePayerAccountHash: string;
  /**
   * Accounts that own or administer the CasCet contracts: the deployer (it holds
   * the token package's upgrade access) and any later ReceiptRegistry owner.
   * At least one is required on mainnet.
   */
  ownerAccountHashes: readonly string[];
  /** Accounts the facilitator settles payments to (its payTo allowlist). */
  sellerAccountHashes: readonly string[];
}

export interface RoleCheckResult {
  errors: string[];
  warnings: string[];
}

export function checkRoleSeparation(input: RoleCheckInput): RoleCheckResult {
  const mainnet = input.network === "casper:casper";
  const errors: string[] = [];
  const warnings: string[] = [];
  const problem = (msg: string) => (mainnet ? errors : warnings).push(msg);

  const feePayer = normalizeAccountHash(input.feePayerAccountHash);
  const owners = input.ownerAccountHashes.map(normalizeAccountHash);
  const sellers = input.sellerAccountHashes.map(normalizeAccountHash);

  if (mainnet && owners.length === 0) {
    errors.push("the owner account is required on mainnet (set CASCET_OWNER_ACCOUNT_HASH)");
  }
  if (owners.includes(feePayer)) {
    problem(
      `the fee-payer key is a contract owner account (${feePayer.slice(0, 10)}…); use a separate, low-float fee-payer key ` +
        "(see tools/e2e/src/key-roles.ts and docs/mainnet-readiness.md)",
    );
  }
  if (sellers.includes(feePayer)) {
    problem(
      `the fee-payer key is also a seller (payTo) account (${feePayer.slice(0, 10)}…); revenue must not land on the hot fee-payer key`,
    );
  }
  return { errors, warnings };
}

export interface RecorderCheckInput {
  network: string;
  /** Account hash of the ReceiptRegistry recorder key (the gateway's anchoring.keyPath). */
  recorderAccountHash: string;
  feePayerAccountHash: string;
  ownerAccountHashes: readonly string[];
  sellerAccountHashes: readonly string[];
}

/**
 * The anchoring recorder is its own hot key (M07). On mainnet it must not be
 * the fee payer, the contract owner or a seller: the owner key stays offline
 * and authorizes a dedicated recorder on ReceiptRegistry instead. On testnet
 * the same overlaps only warn.
 */
export function checkRecorderSeparation(input: RecorderCheckInput): RoleCheckResult {
  const mainnet = input.network === "casper:casper";
  const errors: string[] = [];
  const warnings: string[] = [];
  const problem = (msg: string) => (mainnet ? errors : warnings).push(msg);

  const recorder = normalizeAccountHash(input.recorderAccountHash);
  if (recorder === normalizeAccountHash(input.feePayerAccountHash)) {
    problem("the recorder key is also the fee-payer key; use one key per role");
  }
  if (input.ownerAccountHashes.map(normalizeAccountHash).includes(recorder)) {
    problem(
      `the recorder key is a contract owner account (${recorder.slice(0, 10)}…); authorize a dedicated recorder on ` +
        "ReceiptRegistry and keep the owner key offline",
    );
  }
  if (input.sellerAccountHashes.map(normalizeAccountHash).includes(recorder)) {
    problem(`the recorder key is also a seller (payTo) account (${recorder.slice(0, 10)}…); revenue must not land on a hot key`);
  }
  return { errors, warnings };
}

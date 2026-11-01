/**
 * Key-role separation rules for the facilitator (M07).
 *
 * On mainnet CasCet ran one hot key as fee payer, seller (payTo), anchoring
 * recorder and contract owner. The facilitator now refuses to start on
 * `casper:casper` when its fee-payer account is the owner account or one of
 * the seller accounts it settles to, so a leaked fee-payer key can no longer
 * also drain revenue or administer the contracts. On testnet the same overlaps
 * only produce warnings, so the demos keep working with one deployer key.
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
  /** Account that owns the CasCet contracts (deployer). Required on mainnet. */
  ownerAccountHash?: string;
  /** Accounts the facilitator settles payments to (its payTo allowlist). */
  sellerAccountHashes: string[];
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
  const owner = input.ownerAccountHash ? normalizeAccountHash(input.ownerAccountHash) : undefined;
  const sellers = input.sellerAccountHashes.map(normalizeAccountHash);

  if (mainnet && !owner) {
    errors.push("the owner account is required on mainnet (set CASCET_OWNER_ACCOUNT_HASH)");
  }
  if (owner && feePayer === owner) {
    problem(
      `the fee-payer key is the contract owner account (${owner.slice(0, 10)}…); use a separate, low-float fee-payer key ` +
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

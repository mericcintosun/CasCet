import casperSdk from "casper-js-sdk";
import { CSPR_DECIMALS, formatAmount } from "./amounts.js";
import { expectedNetMotes } from "./gas-report.js";

const { Args, CLValue, ContractCallBuilder, Key, PublicKey, Timestamp } = casperSdk;

/**
 * A CEP-18 `transfer(recipient: Key, amount: U256)` from the signing account,
 * as fund-token sends it. Both CasCet's x402 token and Wrapped CSPR are Odra
 * CEP-18 tokens with this entry point (read on-chain, 2026-11-02).
 */

/** The `transfer` arguments fund-token requires the token to declare, in order. */
export const CEP18_TRANSFER_ARGS: ReadonlyArray<readonly [string, unknown]> = [
  ["recipient", "Key"],
  ["amount", "U256"],
];

/** Gas a CEP-18 transfer consumed: testnet d299b19b… (CasCet's x402 token) used 0.4545 CSPR; four more read 0.453–0.456. */
export const RECORDED_TRANSFER_CONSUMED_MOTES = 455_824_466n;
/** Default gas limit of a transfer (fund-token's limit since it was written; about 10× the measured consumption). */
export const DEFAULT_TRANSFER_GAS_MOTES = 5_000_000_000n;
/** Floor of `--gas-cspr`: CasCet policy (wide headroom over the measured ~0.46 CSPR), not a node rule. */
export const MIN_TRANSFER_GAS_MOTES = 2_500_000_000n;
export const MAX_TRANSFER_GAS_MOTES = 20_000_000_000n;

const HEX64 = /^[0-9a-f]{64}$/;

/** Runtime args of `transfer` to an account. */
export function cep18TransferArgs(recipientAccountHash: string, amountRaw: bigint) {
  const recipient = recipientAccountHash.toLowerCase();
  if (!HEX64.test(recipient)) throw new Error("recipient must be a bare 64-hex account hash");
  if (amountRaw <= 0n || amountRaw >= 2n ** 256n) throw new Error("amount must be a positive U256");
  return Args.fromMap({
    recipient: CLValue.newCLKey(Key.newKey(`account-hash-${recipient}`)),
    amount: CLValue.newCLUInt256(amountRaw.toString()),
  });
}

export interface TransferOptions {
  /** Public key (hex) of the account that signs, pays the gas and sends the tokens. */
  initiatorPublicKey: string;
  chainName: string;
  paymentMotes: bigint;
  /** Transaction TTL. Default 30 minutes. */
  ttlMs?: number;
  /** Fixed timestamp (tests); default now. */
  timestamp?: Date;
}

/** The (unsigned) transfer of `amountRaw` units of token `packageHash` to `recipientAccountHash`. */
export function buildCep18Transfer(packageHash: string, recipientAccountHash: string, amountRaw: bigint, opts: TransferOptions) {
  const pkg = packageHash.toLowerCase();
  if (!HEX64.test(pkg)) throw new Error("token must be a bare 64-hex contract package hash");
  if (opts.paymentMotes <= 0n || opts.paymentMotes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("payment must be a positive number of motes");
  const builder = new ContractCallBuilder()
    .from(PublicKey.fromHex(opts.initiatorPublicKey))
    .byPackageHash(pkg)
    .entryPoint("transfer")
    .runtimeArgs(cep18TransferArgs(recipientAccountHash, amountRaw))
    .chainName(opts.chainName)
    .payment(Number(opts.paymentMotes));
  if (opts.ttlMs !== undefined) builder.ttl(opts.ttlMs);
  if (opts.timestamp) builder.timestamp(new Timestamp(opts.timestamp));
  return builder.build();
}

/** Expected gas cost of a transfer with `limitMotes`, from the recorded consumption. */
export function expectedTransferGasMotes(limitMotes: bigint): bigint {
  return expectedNetMotes(limitMotes, RECORDED_TRANSFER_CONSUMED_MOTES);
}

/** A token balance as fund-token read it: the raw units, or why they could not be read. */
export type TokenBalanceRead = { units: bigint } | { error: string };

export interface TransferCheckInput {
  /** The signer's token balance. */
  signerTokens: TokenBalanceRead;
  /** Raw units to send. */
  amountRaw: bigint;
  /** The signer's CSPR (motes): it pays the gas limit up front. */
  signerMotes: bigint;
  gasLimitMotes: bigint;
  /** `--skip-balance-check`: send even when the signer's token balance cannot be read. */
  skipBalanceCheck: boolean;
  /** Token units as text, e.g. "5 WCSPR". */
  show: (units: bigint) => string;
}

/**
 * What stops fund-token from sending (`problems`; `--send` refuses while there
 * is one) and what it only warns about. Fails closed: a transfer the signer's
 * balance does not cover reverts and burns its whole gas limit, so a token
 * balance that cannot be read (an RPC error, or a token without an Odra
 * `balances` dictionary) is a problem unless `--skip-balance-check` is given.
 * A balance that was read and is short is always a problem.
 */
export function transferChecks(input: TransferCheckInput): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const tokens = input.signerTokens;
  if ("units" in tokens) {
    if (tokens.units < input.amountRaw) {
      problems.push(`the signer holds ${input.show(tokens.units)}, less than the ${input.show(input.amountRaw)} to send`);
    }
  } else if (input.skipBalanceCheck) {
    warnings.push(
      `cannot read the signer's token balance (${tokens.error}); sending anyway (--skip-balance-check): ` +
        "a balance below the amount reverts the transfer and burns its whole gas limit",
    );
  } else {
    problems.push(
      `cannot read the signer's token balance (${tokens.error}); re-run, or pass --skip-balance-check ` +
        "for a token without an Odra `balances` dictionary",
    );
  }
  if (input.signerMotes < input.gasLimitMotes) {
    problems.push(
      `the signer holds ${formatAmount(input.signerMotes, CSPR_DECIMALS)} CSPR, ` +
        `less than the ${formatAmount(input.gasLimitMotes, CSPR_DECIMALS)} CSPR gas limit`,
    );
  }
  return { problems, warnings };
}

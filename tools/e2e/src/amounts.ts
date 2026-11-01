/**
 * Decimal amounts for the maintainer scripts (wrap-wcspr, fund-token, the gas
 * reports): "5" or "0.25" to raw units (motes for CSPR, raw units for a CEP-18
 * token) and back. BigInt only: a float would round large or long amounts.
 */

/** CSPR has 9 decimals: 1 CSPR = 1_000_000_000 motes. */
export const CSPR_DECIMALS = 9;
export const MOTES_PER_CSPR = 1_000_000_000n;

/** Largest number of decimals accepted (CEP-18 `decimals` is a u8; a U256 has at most 78 digits). */
const MAX_DECIMALS = 77;
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

const clip = (text: string): string => (text.length > 40 ? `${text.slice(0, 40)}…` : text);

function checkDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new RangeError(`decimals must be a whole number from 0 to ${MAX_DECIMALS}, got ${decimals}`);
  }
}

/**
 * Parse a non-negative decimal amount ("5", "0.25", "1_000") into raw units at
 * `decimals`. Refuses signs, exponents, empty input and more fractional digits
 * than the unit has (nothing is rounded). Zero comes back as 0n; callers that
 * need a positive amount check for it.
 */
export function parseAmount(text: string, decimals: number, what = "amount"): bigint {
  checkDecimals(decimals);
  const cleaned = text.trim().replace(/_/g, "");
  const match = DECIMAL.exec(cleaned);
  if (!match) throw new Error(`${what} must be a decimal number such as 5 or 0.25, got "${clip(text)}"`);
  const whole = match[1]!;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new Error(`${what} has more than ${decimals} decimal place${decimals === 1 ? "" : "s"}: "${clip(text)}"`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** Exact decimal text of `raw` units at `decimals`, without trailing zeros: 2500000000n at 9 → "2.5". */
export function formatAmount(raw: bigint, decimals: number): string {
  checkDecimals(decimals);
  const sign = raw < 0n ? "-" : "";
  const value = raw < 0n ? -raw : raw;
  const unit = 10n ** BigInt(decimals);
  const whole = (value / unit).toString();
  const fraction = decimals === 0 ? "" : (value % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * CSPR with a fixed number of decimals, for reports, rounded half up:
 * 2706561290n → "2.7066" (4 digits, the default).
 */
export function formatCspr(motes: bigint, fractionDigits = 4): string {
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > CSPR_DECIMALS) {
    throw new RangeError(`fractionDigits must be a whole number from 0 to ${CSPR_DECIMALS}`);
  }
  const sign = motes < 0n ? "-" : "";
  const value = motes < 0n ? -motes : motes;
  const step = 10n ** BigInt(CSPR_DECIMALS - fractionDigits);
  const rounded = (value + step / 2n) / step; // half up; step / 2n is 0 when nothing is cut
  const unit = 10n ** BigInt(fractionDigits);
  const whole = (rounded / unit).toString();
  if (fractionDigits === 0) return `${sign}${whole}`;
  return `${sign}${whole}.${(rounded % unit).toString().padStart(fractionDigits, "0")}`;
}

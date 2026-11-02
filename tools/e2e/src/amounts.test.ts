import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CSPR_DECIMALS, formatAmount, formatCspr, formatCsprExact, MOTES_PER_CSPR, parseAmount } from "./amounts.js";

describe("decimal amounts", () => {
  test("parses whole and fractional amounts into raw units without floating point", () => {
    assert.equal(parseAmount("5", CSPR_DECIMALS), 5n * MOTES_PER_CSPR);
    assert.equal(parseAmount("0.25", CSPR_DECIMALS), 250_000_000n);
    assert.equal(parseAmount("2.5", 9), 2_500_000_000n);
    assert.equal(parseAmount("1_000", 9), 1_000n * MOTES_PER_CSPR);
    assert.equal(parseAmount(" 0.000000001 ", 9), 1n);
    assert.equal(parseAmount("12345678901234567890.123456", 6), 12345678901234567890123456n);
    assert.equal(parseAmount("300", 0), 300n);
    assert.equal(parseAmount("0", 9), 0n);
  });

  test("refuses signs, exponents, empty input and digits the unit cannot hold", () => {
    for (const bad of ["", "-1", "+1", "1e9", "0x10", ".5", "5.", "1,5", "abc", "NaN", "1.2.3"]) {
      assert.throws(() => parseAmount(bad, 9), /must be a decimal number/, bad);
    }
    assert.throws(() => parseAmount("0.0000000001", 9), /more than 9 decimal places/);
    assert.throws(() => parseAmount("1.5", 0), /more than 0 decimal places/);
    assert.throws(() => parseAmount("1.25", 1, "the amount"), /the amount has more than 1 decimal place:/);
    assert.throws(() => parseAmount("1", -1), RangeError);
    assert.throws(() => parseAmount("1", 1.5), RangeError);
  });

  test("formats raw units exactly, without trailing zeros", () => {
    assert.equal(formatAmount(2_500_000_000n, 9), "2.5");
    assert.equal(formatAmount(5_000_000_000n, 9), "5");
    assert.equal(formatAmount(1n, 9), "0.000000001");
    assert.equal(formatAmount(0n, 9), "0");
    assert.equal(formatAmount(300n, 0), "300");
    assert.equal(formatAmount(-1_500_000n, 6), "-1.5");
    assert.equal(formatAmount(parseAmount("88.000000123", 9), 9), "88.000000123");
  });

  test("formats CSPR for reports with fixed digits, rounded half up", () => {
    assert.equal(formatCspr(2_706_561_290n), "2.7066");
    assert.equal(formatCspr(3_220_079_032n), "3.2201");
    assert.equal(formatCspr(7_000_000_000n), "7.0000");
    assert.equal(formatCspr(1_469_000_000n, 2), "1.47");
    assert.equal(formatCspr(1_465_000_000n, 2), "1.47"); // half up
    assert.equal(formatCspr(1_464_999_999n, 2), "1.46");
    assert.equal(formatCspr(2_145_235_542n, 3), "2.145");
    assert.equal(formatCspr(999_999_999n, 0), "1");
    assert.equal(formatCspr(123n, 9), "0.000000123");
    assert.equal(formatCspr(-2_500_000_000n, 1), "-2.5");
    assert.throws(() => formatCspr(1n, 10), RangeError);
  });

  test("formats a CSPR amount the user gave exactly, with at least two decimals", () => {
    assert.equal(formatCsprExact(4_000_000_000n), "4.00");
    assert.equal(formatCsprExact(5_450_000_000n), "5.45");
    assert.equal(formatCsprExact(5_449_000_000n), "5.449", "never rounded up to the next cent");
    assert.equal(formatCsprExact(5_449_999_999n), "5.449999999");
    assert.equal(formatCsprExact(2_500_000_000n, 0), "2.5");
    assert.equal(formatCsprExact(3_000_000_000n, 0), "3");
    assert.equal(formatCsprExact(-1_500_000_000n), "-1.50");
    assert.throws(() => formatCsprExact(1n, 10), RangeError);
  });
});

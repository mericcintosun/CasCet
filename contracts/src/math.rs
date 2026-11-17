//! Integer helpers shared by the contracts.

use odra::casper_types::U256;

/// `floor(value * numerator / denominator)` without computing
/// `value * numerator`, which overflows U256 (a wasm trap) as soon as
/// `value > U256::MAX / numerator`.
///
/// With `value = q * denominator + r` the result is
/// `q * numerator + r * numerator / denominator`, which is exact. Neither
/// product can overflow: `q * numerator <= q * denominator <= value` because
/// callers keep `numerator <= denominator`, and `r * numerator` is below
/// `denominator^2 < 2^128`. The result is at most `value`.
///
/// Callers must pass a non-zero `denominator` and `numerator <= denominator`
/// (attribution bps and payee shares both satisfy this).
pub fn mul_div_floor(value: U256, numerator: u64, denominator: u64) -> U256 {
    let numerator = U256::from(numerator);
    let denominator = U256::from(denominator);
    value / denominator * numerator + value % denominator * numerator / denominator
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::Lcg;

    fn naive(value: U256, numerator: u64, denominator: u64) -> U256 {
        value * U256::from(numerator) / U256::from(denominator)
    }

    #[test]
    fn matches_the_naive_formula_wherever_that_does_not_overflow() {
        for value in 0u64..=257 {
            for (numerator, denominator) in [(0, 1), (1, 1), (0, 3), (2, 3), (3, 3), (7, 10)] {
                let value = U256::from(value);
                assert_eq!(
                    mul_div_floor(value, numerator, denominator),
                    naive(value, numerator, denominator)
                );
            }
        }
        let mut rng = Lcg(42);
        for _ in 0..2_000 {
            let denominator = match rng.below(3) {
                0 => 10_000,
                1 => u32::MAX as u64,
                _ => 1 + rng.below(1 << 31),
            };
            let numerator = rng.below(denominator + 1);
            // Below 2^224, so the naive product fits even for a u32 numerator.
            let wide = (U256::from(rng.below(1 << 31)) << 193)
                | (U256::from(rng.below(1 << 31)) << 97)
                | U256::from(rng.below(1 << 31));
            let value = wide >> (rng.below(224) as usize);
            assert_eq!(
                mul_div_floor(value, numerator, denominator),
                naive(value, numerator, denominator)
            );
        }
    }

    #[test]
    fn stays_exact_where_the_naive_product_overflows() {
        let max = U256::MAX;
        assert_eq!(mul_div_floor(max, 5_000, 10_000), max / 2);
        assert_eq!(mul_div_floor(max, 10_000, 10_000), max);
        assert_eq!(mul_div_floor(max, 0, 10_000), U256::zero());
        assert_eq!(mul_div_floor(max, 2, 4), max / 2);
        assert_eq!(mul_div_floor(max, 1, 3), max / 3);
        // 2^256 - 1 = 3 * 5 * 17 * 257 * 641 * 65537 * ... so 3 divides it.
        assert_eq!(mul_div_floor(max, 2, 3), max / 3 * 2);
        let shares = u32::MAX as u64;
        assert_eq!(mul_div_floor(max, shares, shares), max);
        assert_eq!(mul_div_floor(max, shares - 1, shares) + max / shares, max);
    }
}

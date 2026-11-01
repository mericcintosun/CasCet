//! Helpers shared by the unit tests. Compiled only under `cfg(test)`.

/// Small deterministic generator (a 64-bit LCG) for the invariant tests, so
/// they explore many orderings without extra crates and replay identically.
pub struct Lcg(pub u64);

impl Lcg {
    /// The next value in `0..bound`.
    pub fn below(&mut self, bound: u64) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) % bound
    }
}

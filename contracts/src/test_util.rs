//! Helpers shared by the unit tests. Compiled only under `cfg(test)`.
//!
//! The tests run on OdraVM by default (`cargo odra test`) and on the Casper
//! execution engine with `cargo odra test -b casper`, which runs the same wasm
//! that gets deployed. Contracts used by tests must therefore be listed in
//! `Odra.toml`, which is why the tests pay with `DemoToken` rather than
//! odra-modules' `Cep18`.

use crate::demo_token::{DemoToken, DemoTokenHostRef, DemoTokenInitArgs};
use odra::casper_types::U256;
use odra::host::{Deployer, HostEnv};

/// Deploy a DemoToken whose whole `supply` goes to the current caller.
pub fn deploy_demo_token(env: &HostEnv, supply: u64) -> DemoTokenHostRef {
    DemoToken::deploy(
        env,
        DemoTokenInitArgs {
            symbol: "WCSPR".to_string(),
            name: "Wrapped CSPR".to_string(),
            decimals: 9,
            initial_supply: U256::from(supply),
        },
    )
}

/// True when the tests run on the Casper execution engine
/// (`cargo odra test -b casper` sets `ODRA_BACKEND=casper`). Test-only modules
/// have no wasm there, so tests that deploy one return early on it.
pub fn on_casper_backend() -> bool {
    std::env::var("ODRA_BACKEND").is_ok_and(|backend| backend == "casper")
}

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

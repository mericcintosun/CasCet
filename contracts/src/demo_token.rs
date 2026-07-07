//! A deployable CEP-18 demo token for the RevenueSplit demo.
//!
//! `odra-modules`' `Cep18` can't be built into a contract wasm directly from an
//! external crate (the entry point `call` export is only generated for modules
//! defined in *this* crate). Wrapping it as a submodule and re-exposing the
//! CEP-18 entry points we need yields a proper, deployable contract while
//! reusing the audited CEP-18 logic.

use odra::prelude::*;
use odra::casper_types::U256;
use odra_modules::cep18_token::Cep18;

#[odra::module]
pub struct DemoToken {
    token: SubModule<Cep18>,
}

#[odra::module]
impl DemoToken {
    /// Mints `initial_supply` to the deployer, exactly like a standard CEP-18.
    pub fn init(&mut self, symbol: String, name: String, decimals: u8, initial_supply: U256) {
        self.token.init(symbol, name, decimals, initial_supply);
    }

    /// Transfer tokens to `recipient`. Arg names/types match the CEP-18 standard
    /// so RevenueSplit's external interface calls it transparently.
    pub fn transfer(&mut self, recipient: Address, amount: U256) {
        self.token.transfer(&recipient, &amount);
    }

    pub fn balance_of(&self, address: Address) -> U256 {
        self.token.balance_of(&address)
    }

    pub fn total_supply(&self) -> U256 {
        self.token.total_supply()
    }

    pub fn name(&self) -> String {
        self.token.name()
    }

    pub fn symbol(&self) -> String {
        self.token.symbol()
    }

    pub fn decimals(&self) -> u8 {
        self.token.decimals()
    }
}

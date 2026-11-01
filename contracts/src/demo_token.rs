//! A deployable CEP-18 demo token for the RevenueSplit demo.
//!
//! `odra-modules`' `Cep18` can't be built into a contract wasm directly from an
//! external crate (the entry point `call` export is only generated for modules
//! defined in *this* crate). Wrapping it as a submodule and re-exposing the
//! CEP-18 entry points we need yields a proper, deployable contract while
//! reusing the odra-modules CEP-18 logic. That logic must come from
//! odra-modules 2.9.0 or later (see Cargo.toml): older releases break
//! `transfer_from` allowance accounting (finding M33).

use odra::casper_types::U256;
use odra::prelude::*;
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

    /// Approve `spender` to move up to `amount` of the caller's tokens.
    pub fn approve(&mut self, spender: Address, amount: U256) {
        self.token.approve(&spender, &amount);
    }

    /// Move `amount` from `owner` to `recipient` using the caller's allowance,
    /// which goes down by `amount`. Up to odra-modules 2.8.2 the reduced value
    /// was written to `(owner, recipient)` instead, so the spender's allowance
    /// never shrank and the recipient gained one nobody granted (M33).
    pub fn transfer_from(&mut self, owner: Address, recipient: Address, amount: U256) {
        self.token.transfer_from(&owner, &recipient, &amount);
    }

    pub fn allowance(&self, owner: Address, spender: Address) -> U256 {
        self.token.allowance(&owner, &spender)
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

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostEnv};
    use odra_modules::cep18::errors::Error as Cep18Error;

    const SUPPLY: u64 = 1_000_000;

    fn deploy(env: &HostEnv) -> DemoTokenHostRef {
        DemoToken::deploy(
            env,
            DemoTokenInitArgs {
                symbol: "WCSPR".to_string(),
                name: "Wrapped CSPR (CasCet demo)".to_string(),
                decimals: 9,
                initial_supply: U256::from(SUPPLY),
            },
        )
    }

    #[test]
    fn init_mints_the_whole_supply_to_the_deployer() {
        let env = odra_test::env();
        let deployer = env.get_account(0);
        let token = deploy(&env);

        assert_eq!(token.symbol(), "WCSPR");
        assert_eq!(token.name(), "Wrapped CSPR (CasCet demo)");
        assert_eq!(token.decimals(), 9);
        assert_eq!(token.total_supply(), U256::from(SUPPLY));
        assert_eq!(token.balance_of(deployer), U256::from(SUPPLY));
    }

    #[test]
    fn transfer_moves_balance_and_rejects_overdraft() {
        let env = odra_test::env();
        let deployer = env.get_account(0);
        let alice = env.get_account(1);
        let bob = env.get_account(2);
        let mut token = deploy(&env);

        token.transfer(alice, U256::from(250u64));
        assert_eq!(token.balance_of(alice), U256::from(250u64));
        assert_eq!(token.balance_of(deployer), U256::from(SUPPLY - 250));

        env.set_caller(alice);
        assert_eq!(
            token.try_transfer(bob, U256::from(251u64)),
            Err(Cep18Error::InsufficientBalance.into())
        );
        assert_eq!(token.total_supply(), U256::from(SUPPLY));
    }

    // M33 regression: transfer_from must spend the caller's (spender's)
    // allowance and must not create an allowance for the recipient.
    #[test]
    fn transfer_from_spends_the_spender_allowance_only() {
        let env = odra_test::env();
        let owner = env.get_account(0);
        let spender = env.get_account(1);
        let recipient = env.get_account(2);
        let third_party = env.get_account(3);
        let mut token = deploy(&env);

        token.approve(spender, U256::from(100u64));

        env.set_caller(spender);
        token.transfer_from(owner, recipient, U256::from(40u64));
        assert_eq!(token.allowance(owner, spender), U256::from(60u64));
        assert_eq!(token.allowance(owner, recipient), U256::zero());
        assert_eq!(token.balance_of(recipient), U256::from(40u64));
        assert_eq!(token.balance_of(owner), U256::from(SUPPLY - 40));

        // The spender is held to what is left of its allowance.
        assert_eq!(
            token.try_transfer_from(owner, recipient, U256::from(61u64)),
            Err(Cep18Error::InsufficientAllowance.into())
        );
        token.transfer_from(owner, recipient, U256::from(60u64));
        assert_eq!(token.allowance(owner, spender), U256::zero());
        assert_eq!(
            token.try_transfer_from(owner, recipient, U256::one()),
            Err(Cep18Error::InsufficientAllowance.into())
        );

        // The recipient never received an allowance it could spend.
        env.set_caller(recipient);
        assert_eq!(token.allowance(owner, recipient), U256::zero());
        assert_eq!(
            token.try_transfer_from(owner, third_party, U256::one()),
            Err(Cep18Error::InsufficientAllowance.into())
        );
        assert_eq!(token.balance_of(owner), U256::from(SUPPLY - 100));
        assert_eq!(token.balance_of(third_party), U256::zero());
    }

    // Our own contracts call transfer_from with spender == recipient (the
    // contract pulls a deposit to itself); that path must keep working.
    #[test]
    fn transfer_from_to_the_spender_itself() {
        let env = odra_test::env();
        let owner = env.get_account(0);
        let puller = env.get_account(1);
        let mut token = deploy(&env);

        token.approve(puller, U256::from(30u64));
        env.set_caller(puller);
        token.transfer_from(owner, puller, U256::from(30u64));
        assert_eq!(token.balance_of(puller), U256::from(30u64));
        assert_eq!(token.allowance(owner, puller), U256::zero());
        assert_eq!(
            token.try_transfer_from(owner, puller, U256::one()),
            Err(Cep18Error::InsufficientAllowance.into())
        );
    }
}

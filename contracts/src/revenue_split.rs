//! On-chain revenue splitting for CasCet paid MCP servers.
//!
//! A gateway can set its x402 `payTo` to a `RevenueSplit` contract instead of a
//! plain account. All CEP-18 micropayments for that server then accrue to the
//! contract, and each configured payee can pull their weighted share at any
//! time. This turns "who gets paid for this MCP server" into a contract-enforced
//! guarantee — the natural fit for co-authored tools and Casper's multi-party
//! ownership model.
//!
//! The accounting mirrors OpenZeppelin's PaymentSplitter: shares are fixed at
//! init, and `releasable` is computed from lifetime received value, so funds
//! that arrive at any time are always split by the exact configured weights.

use odra::prelude::*;
use odra::casper_types::U256;
use odra::ContractRef;

/// Minimal external view of the CEP-18 token this splitter distributes.
/// Matches the `odra-modules` CEP-18 entrypoints (`transfer`, `balance_of`).
#[odra::external_contract]
pub trait Cep18Token {
    fn transfer(&mut self, recipient: Address, amount: U256);
    fn balance_of(&self, address: Address) -> U256;
}

#[odra::event]
pub struct PaymentReleased {
    pub account: Address,
    pub amount: U256,
}

#[odra::odra_error]
pub enum Error {
    /// `payees` and `shares` had different lengths.
    LengthMismatch = 1,
    /// A payee was configured with zero shares.
    ZeroShares = 2,
    /// No payees were provided.
    NoPayees = 3,
    /// The account is not a configured payee.
    NotAPayee = 4,
    /// The account has nothing to withdraw right now.
    NothingToRelease = 5,
    /// A payee address appeared more than once.
    DuplicatePayee = 6,
}

#[odra::module(events = [PaymentReleased], errors = Error)]
pub struct RevenueSplit {
    token: Var<Address>,
    payees: List<Address>,
    shares: Mapping<Address, u32>,
    total_shares: Var<u32>,
    released: Mapping<Address, U256>,
    total_released: Var<U256>,
}

#[odra::module]
impl RevenueSplit {
    /// Configure the splitter over a CEP-18 `token`, with parallel `payees` and
    /// `shares` arrays (payee `i` receives `shares[i] / total_shares` of revenue).
    pub fn init(&mut self, token: Address, payees: Vec<Address>, shares: Vec<u32>) {
        if payees.is_empty() {
            self.env().revert(Error::NoPayees);
        }
        if payees.len() != shares.len() {
            self.env().revert(Error::LengthMismatch);
        }
        self.token.set(token);
        let mut running_total: u32 = 0;
        for (i, payee) in payees.iter().enumerate() {
            let share = shares[i];
            if share == 0 {
                self.env().revert(Error::ZeroShares);
            }
            if self.shares.get_or_default(payee) != 0 {
                self.env().revert(Error::DuplicatePayee);
            }
            self.shares.set(payee, share);
            self.payees.push(*payee);
            running_total += share;
        }
        self.total_shares.set(running_total);
        self.total_released.set(U256::zero());
    }

    /// Lifetime CEP-18 value that has flowed through the splitter
    /// (current balance still held + everything already released).
    pub fn total_received(&self) -> U256 {
        let held = Cep18TokenContractRef::new(self.env(), self.token())
            .balance_of(self.env().self_address());
        held + self.total_released.get_or_default()
    }

    /// Amount `account` can withdraw right now.
    pub fn releasable(&self, account: Address) -> U256 {
        let shares = self.shares.get_or_default(&account);
        if shares == 0 {
            return U256::zero();
        }
        let total_received = self.total_received();
        let owed = total_received * U256::from(shares) / U256::from(self.total_shares());
        let already = self.released.get_or_default(&account);
        if owed > already {
            owed - already
        } else {
            U256::zero()
        }
    }

    /// Pull `account`'s outstanding share, transferring CEP-18 tokens to them.
    /// Anyone may trigger a release; funds only ever go to the payee.
    pub fn release(&mut self, account: Address) {
        if self.shares.get_or_default(&account) == 0 {
            self.env().revert(Error::NotAPayee);
        }
        let amount = self.releasable(account);
        if amount.is_zero() {
            self.env().revert(Error::NothingToRelease);
        }
        self.released.set(&account, self.released.get_or_default(&account) + amount);
        self.total_released.set(self.total_released.get_or_default() + amount);
        Cep18TokenContractRef::new(self.env(), self.token()).transfer(account, amount);
        self.env().emit_event(PaymentReleased { account, amount });
    }

    /// The CEP-18 token being distributed.
    pub fn token(&self) -> Address {
        self.token.get().unwrap_or_revert(&self.env())
    }

    /// Shares assigned to `account`.
    pub fn shares_of(&self, account: Address) -> u32 {
        self.shares.get_or_default(&account)
    }

    /// Total value already released to `account`.
    pub fn released_of(&self, account: Address) -> U256 {
        self.released.get_or_default(&account)
    }

    /// Sum of all configured shares.
    pub fn total_shares(&self) -> u32 {
        self.total_shares.get_or_default()
    }

    /// Number of payees.
    pub fn payee_count(&self) -> u32 {
        self.payees.len()
    }

    /// Payee at `index`.
    pub fn payee(&self, index: u32) -> Address {
        self.payees.get(index).unwrap_or_revert(&self.env())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::casper_types::U256;
    use odra::host::Deployer;
    use odra_modules::cep18_token::{Cep18, Cep18HostRef, Cep18InitArgs};

    fn deploy_token(env: &odra::host::HostEnv, supply: u64) -> Cep18HostRef {
        Cep18::deploy(
            env,
            Cep18InitArgs {
                symbol: "WCSPR".to_string(),
                name: "Wrapped CSPR".to_string(),
                decimals: 9,
                initial_supply: U256::from(supply),
            },
        )
    }

    #[test]
    fn splits_revenue_by_weight() {
        let env = odra_test::env();
        let owner = env.get_account(0);
        let alice = env.get_account(1);
        let bob = env.get_account(2);

        let mut token = deploy_token(&env, 1_000_000);
        // 60/40 split between alice and bob.
        let mut split = RevenueSplit::deploy(
            &env,
            RevenueSplitInitArgs {
                token: token.address(),
                payees: vec![alice, bob],
                shares: vec![60, 40],
            },
        );

        // Server earns 1000 tokens: owner (holding initial supply) funds the splitter.
        env.set_caller(owner);
        token.transfer(&split.address(), &U256::from(1000u64));

        assert_eq!(split.total_received(), U256::from(1000u64));
        assert_eq!(split.releasable(alice), U256::from(600u64));
        assert_eq!(split.releasable(bob), U256::from(400u64));

        split.release(alice);
        assert_eq!(token.balance_of(&alice), U256::from(600u64));
        assert_eq!(split.releasable(alice), U256::zero());

        // More revenue arrives; only the new delta is releasable.
        env.set_caller(owner);
        token.transfer(&split.address(), &U256::from(500u64));
        assert_eq!(split.releasable(alice), U256::from(300u64)); // 60% of 500
        assert_eq!(split.releasable(bob), U256::from(600u64)); // 40% of 1500 total, none released yet

        split.release(bob);
        assert_eq!(token.balance_of(&bob), U256::from(600u64));
    }

    #[test]
    fn rejects_non_payee_release() {
        let env = odra_test::env();
        let alice = env.get_account(1);
        let stranger = env.get_account(3);
        let token = deploy_token(&env, 1000);
        let mut split = RevenueSplit::deploy(
            &env,
            RevenueSplitInitArgs { token: token.address(), payees: vec![alice], shares: vec![100] },
        );
        assert_eq!(split.try_release(stranger), Err(Error::NotAPayee.into()));
    }

    #[test]
    fn rejects_mismatched_config() {
        let env = odra_test::env();
        let alice = env.get_account(1);
        let token = deploy_token(&env, 1000);
        let err = RevenueSplit::try_deploy(
            &env,
            RevenueSplitInitArgs { token: token.address(), payees: vec![alice], shares: vec![50, 50] },
        );
        assert!(err.is_err());
    }
}

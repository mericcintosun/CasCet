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

use crate::math::mul_div_floor;
use odra::casper_types::U256;
use odra::prelude::*;
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
    /// The shares add up to more than `u32::MAX`.
    SharesOverflow = 7,
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
            // Release wasm used to build without overflow checks, so a plain
            // `+=` could wrap to a total below the real sum, and payees would
            // then be owed more than the splitter ever received (finding L40).
            running_total = running_total
                .checked_add(share)
                .unwrap_or_revert_with(&self.env(), Error::SharesOverflow);
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
        // floor(total_received * shares / total_shares) without the full
        // product, which would overflow (and make `release` impossible) once
        // total_received passed U256::MAX / shares. `shares <= total_shares`.
        let owed = mul_div_floor(
            self.total_received(),
            shares.into(),
            self.total_shares().into(),
        );
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
        self.released
            .set(&account, self.released.get_or_default(&account) + amount);
        self.total_released
            .set(self.total_released.get_or_default() + amount);
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
    use crate::test_util::{deploy_demo_token as deploy_token, deploy_demo_token_u256, Lcg};
    use odra::casper_types::U256;
    use odra::host::{Deployer, HostEnv};

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
        token.transfer(split.address(), U256::from(1000u64));

        assert_eq!(split.total_received(), U256::from(1000u64));
        assert_eq!(split.releasable(alice), U256::from(600u64));
        assert_eq!(split.releasable(bob), U256::from(400u64));

        split.release(alice);
        assert_eq!(token.balance_of(alice), U256::from(600u64));
        assert_eq!(split.releasable(alice), U256::zero());

        // More revenue arrives; only the new delta is releasable.
        env.set_caller(owner);
        token.transfer(split.address(), U256::from(500u64));
        assert_eq!(split.releasable(alice), U256::from(300u64)); // 60% of 500
        assert_eq!(split.releasable(bob), U256::from(600u64)); // 40% of 1500 total, none released yet

        split.release(bob);
        assert_eq!(token.balance_of(bob), U256::from(600u64));
    }

    #[test]
    fn rejects_non_payee_release() {
        let env = odra_test::env();
        let alice = env.get_account(1);
        let stranger = env.get_account(3);
        let token = deploy_token(&env, 1000);
        let mut split = RevenueSplit::deploy(
            &env,
            RevenueSplitInitArgs {
                token: token.address(),
                payees: vec![alice],
                shares: vec![100],
            },
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
            RevenueSplitInitArgs {
                token: token.address(),
                payees: vec![alice],
                shares: vec![50, 50],
            },
        );
        assert!(err.is_err());
    }

    fn try_config(env: &HostEnv, payees: Vec<Address>, shares: Vec<u32>) -> Option<OdraError> {
        let token = deploy_token(env, 1000);
        RevenueSplit::try_deploy(
            env,
            RevenueSplitInitArgs {
                token: token.address(),
                payees,
                shares,
            },
        )
        .err()
    }

    #[test]
    fn rejects_every_invalid_config_with_its_error() {
        let env = odra_test::env();
        let alice = env.get_account(1);
        let bob = env.get_account(2);

        assert_eq!(
            try_config(&env, vec![], vec![]),
            Some(Error::NoPayees.into())
        );
        assert_eq!(
            try_config(&env, vec![alice, bob], vec![1]),
            Some(Error::LengthMismatch.into())
        );
        assert_eq!(
            try_config(&env, vec![alice, bob], vec![1, 0]),
            Some(Error::ZeroShares.into())
        );
        assert_eq!(
            try_config(&env, vec![alice, alice], vec![1, 1]),
            Some(Error::DuplicatePayee.into())
        );
    }

    // L40: the share total is a u32; it must never wrap.
    #[test]
    fn rejects_shares_whose_sum_overflows_u32() {
        let env = odra_test::env();
        let alice = env.get_account(1);
        let bob = env.get_account(2);
        let carol = env.get_account(3);

        assert_eq!(
            try_config(&env, vec![alice, bob], vec![u32::MAX, 1]),
            Some(Error::SharesOverflow.into())
        );
        // Would wrap to 10 and let carol claim everything the splitter holds.
        assert_eq!(
            try_config(&env, vec![alice, bob, carol], vec![1 << 31, 1 << 31, 10]),
            Some(Error::SharesOverflow.into())
        );
        assert_eq!(
            try_config(&env, vec![alice, bob], vec![u32::MAX - 1, 1]),
            None
        );
    }

    #[test]
    fn anyone_can_trigger_a_release_but_only_the_payee_is_paid() {
        let env = odra_test::env();
        let owner = env.get_account(0);
        let alice = env.get_account(1);
        let stranger = env.get_account(4);
        let mut token = deploy_token(&env, 1_000_000);
        let mut split = RevenueSplit::deploy(
            &env,
            RevenueSplitInitArgs {
                token: token.address(),
                payees: vec![alice],
                shares: vec![1],
            },
        );
        token.transfer(split.address(), U256::from(70u64));

        env.set_caller(stranger);
        split.release(alice);
        assert_eq!(token.balance_of(alice), U256::from(70u64));
        assert_eq!(token.balance_of(stranger), U256::zero());
        assert!(env.emitted_event(
            &split,
            PaymentReleased {
                account: alice,
                amount: U256::from(70u64),
            }
        ));
        assert_eq!(
            split.try_release(alice),
            Err(Error::NothingToRelease.into())
        );
        assert_eq!(token.balance_of(owner), U256::from(1_000_000u64 - 70));
    }

    // Accounting invariant: whatever the order of deposits and releases, no
    // payee is ever owed or paid more than its share of what was received,
    // and the payouts never exceed the revenue.
    #[test]
    fn released_never_exceeds_received() {
        let env = odra_test::env();
        let source = env.get_account(0);
        let payees = [env.get_account(1), env.get_account(2), env.get_account(3)];
        let shares: [u32; 3] = [3, 5, 11];
        let total_shares = U256::from(shares.iter().sum::<u32>());

        let mut token = deploy_token(&env, 100_000_000);
        let mut split = RevenueSplit::deploy(
            &env,
            RevenueSplitInitArgs {
                token: token.address(),
                payees: payees.to_vec(),
                shares: shares.to_vec(),
            },
        );

        let mut rng = Lcg(0x5eed);
        let mut deposited = U256::zero();
        for _ in 0..120 {
            if rng.below(3) == 0 {
                let amount = U256::from(1 + rng.below(10_000));
                env.set_caller(source);
                token.transfer(split.address(), amount);
                deposited += amount;
            } else {
                // Anyone may trigger a release; use a payee as the caller.
                let who = payees[rng.below(3) as usize];
                env.set_caller(payees[rng.below(3) as usize]);
                if !split.releasable(who).is_zero() {
                    split.release(who);
                }
            }

            let received = split.total_received();
            assert_eq!(received, deposited);
            let mut paid = U256::zero();
            for (payee, share) in payees.iter().zip(shares) {
                let entitled = received * U256::from(share) / total_shares;
                let released = split.released_of(*payee);
                assert!(released <= entitled);
                assert_eq!(token.balance_of(*payee), released);
                assert_eq!(split.releasable(*payee), entitled - released);
                paid += released;
            }
            assert!(paid <= received);
            assert_eq!(token.balance_of(split.address()), received - paid);
        }

        // Drain: each payee ends with exactly its floor share; the stranded
        // rounding dust is below the number of payees (accepted risk C5).
        for payee in payees {
            if !split.releasable(payee).is_zero() {
                split.release(payee);
            }
        }
        let mut paid = U256::zero();
        for (payee, share) in payees.iter().zip(shares) {
            let entitled = deposited * U256::from(share) / total_shares;
            assert_eq!(split.released_of(*payee), entitled);
            paid += entitled;
        }
        assert!(deposited - paid < U256::from(payees.len()));
    }

    // `releasable` computes floor(received * shares / total_shares) without
    // the full product, so no balance can make `release` impossible. Before,
    // `received * shares` trapped once received passed U256::MAX / shares.
    #[test]
    fn huge_revenue_stays_releasable() {
        let env = odra_test::env();
        let alice = env.get_account(1);
        let bob = env.get_account(2);
        let mut token = deploy_demo_token_u256(&env, U256::MAX);
        let mut split = RevenueSplit::deploy(
            &env,
            RevenueSplitInitArgs {
                token: token.address(),
                payees: vec![alice, bob],
                shares: vec![2, 2],
            },
        );
        token.transfer(split.address(), U256::MAX);

        // Each payee is owed floor(U256::MAX * 2 / 4) = U256::MAX / 2.
        assert_eq!(split.releasable(alice), U256::MAX / 2);
        split.release(alice);
        assert_eq!(split.releasable(bob), U256::MAX / 2);
        split.release(bob);
        assert_eq!(token.balance_of(alice), U256::MAX / 2);
        assert_eq!(token.balance_of(bob), U256::MAX / 2);
        // U256::MAX is odd: one unit of rounding dust stays behind.
        assert_eq!(split.total_received(), U256::MAX);
        assert_eq!(token.balance_of(split.address()), U256::one());
    }
}

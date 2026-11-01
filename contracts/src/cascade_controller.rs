//! Budget-bounded cascading payments with recursive revenue attribution.
//!
//! This is the primitive that turns CasCet's payment *cascades* into a
//! programmable machine-to-machine supply chain:
//!
//!  1. **On-chain budget tree.** An agent opens a cascade with ONE deposit that
//!     is the total budget for a whole call tree. Every hop is paid out of that
//!     deposit and the contract refuses any hop that would exceed the budget —
//!     enforcement is by construction (the contract can never pay out more than
//!     it holds), not by trusting the gateway. Existing agent wallets only cap
//!     per-call spend; this caps the entire tree.
//!
//!  2. **Recursive attribution.** When a downstream hop earns, a configurable
//!     share flows back UP to its parent hop's payee — the service that composed
//!     it earns a margin on what it resells. The payment graph doubles as the
//!     revenue-sharing graph.
//!
//! Casper's instant deterministic finality is what makes a multi-hop tree
//! settle without stalls; the on-chain hop records reconstruct the whole tree.

use crate::math::mul_div_floor;
use odra::casper_types::U256;
use odra::prelude::*;
use odra::ContractRef;

/// Basis points denominator (100% = 10_000 bps).
const BPS_DENOMINATOR: u64 = 10_000;

/// CEP-18 surface the controller needs.
#[odra::external_contract]
pub trait CascadeToken {
    fn transfer(&mut self, recipient: Address, amount: U256);
    fn transfer_from(&mut self, owner: Address, recipient: Address, amount: U256);
}

#[odra::odra_type]
pub struct Cascade {
    pub owner: Address,
    pub operator: Address,
    pub token: Address,
    pub budget: U256,
    pub spent: U256,
    pub next_hop: u64,
    pub closed: bool,
}

#[odra::odra_type]
pub struct Hop {
    pub payee: Address,
    pub parent: u64,
    pub gross: U256,
    pub net_to_payee: U256,
    pub to_parent: U256,
}

#[odra::event]
pub struct CascadeOpened {
    pub cascade_id: u64,
    pub owner: Address,
    pub operator: Address,
    pub budget: U256,
}

#[odra::event]
pub struct HopCharged {
    pub cascade_id: u64,
    pub hop_id: u64,
    pub parent: u64,
    pub payee: Address,
    pub gross: U256,
    pub to_parent: U256,
}

#[odra::event]
pub struct CascadeClosed {
    pub cascade_id: u64,
    pub spent: U256,
    pub refunded: U256,
}

#[odra::odra_error]
pub enum Error {
    UnknownCascade = 1,
    CascadeIsClosed = 2,
    /// Caller is not the cascade's authorized operator.
    NotOperator = 3,
    /// Caller is not the cascade owner.
    NotOwner = 4,
    /// This hop would push total spend past the budget.
    BudgetExceeded = 5,
    /// Attribution basis points exceed 100%.
    InvalidAttribution = 6,
    /// The referenced parent hop does not exist.
    UnknownParent = 7,
}

#[odra::module(events = [CascadeOpened, HopCharged, CascadeClosed], errors = Error)]
pub struct CascadeController {
    cascades: Mapping<u64, Cascade>,
    hops: Mapping<(u64, u64), Hop>,
    exists: Mapping<u64, bool>,
    next_id: Var<u64>,
}

#[odra::module]
impl CascadeController {
    pub fn init(&mut self) {
        self.next_id.set(0);
    }

    /// Open a cascade: the caller (owner) deposits `budget` CEP-18 tokens (must
    /// have approved this contract) and authorizes `operator` (a gateway) to
    /// charge hops against it up to that budget.
    pub fn open(&mut self, operator: Address, token: Address, budget: U256) -> u64 {
        let owner = self.env().caller();
        CascadeTokenContractRef::new(self.env(), token).transfer_from(
            owner,
            self.env().self_address(),
            budget,
        );

        let id = self.next_id.get_or_default();
        self.next_id.set(id + 1);
        self.cascades.set(
            &id,
            Cascade {
                owner,
                operator,
                token,
                budget,
                spent: U256::zero(),
                next_hop: 1,
                closed: false,
            },
        );
        self.exists.set(&id, true);
        self.env().emit_event(CascadeOpened {
            cascade_id: id,
            owner,
            operator,
            budget,
        });
        id
    }

    /// Charge a hop against the cascade budget. Only the operator may call.
    ///
    /// Pays `gross` out of the deposit: `attribution_bps` of it goes UP to the
    /// parent hop's payee (0 for root hops with `parent == 0`), the rest to
    /// `payee`. Reverts if it would exceed the budget. Returns the hop id.
    pub fn charge(
        &mut self,
        cascade_id: u64,
        parent: u64,
        payee: Address,
        gross: U256,
        attribution_bps: u64,
    ) -> u64 {
        let mut cascade = self.load(cascade_id);
        if cascade.closed {
            self.env().revert(Error::CascadeIsClosed);
        }
        if self.env().caller() != cascade.operator {
            self.env().revert(Error::NotOperator);
        }
        if attribution_bps > BPS_DENOMINATOR {
            self.env().revert(Error::InvalidAttribution);
        }
        // `spent <= budget` always holds (this check is the only way `spent`
        // grows), so the subtraction cannot underflow. Comparing against the
        // remainder instead of computing `spent + gross` means even a gross
        // near U256::MAX reverts with BudgetExceeded instead of an opaque
        // overflow trap.
        if gross > cascade.budget - cascade.spent {
            self.env().revert(Error::BudgetExceeded);
        }

        // Recursive attribution: a share of this hop's gross is redirected UP to
        // the payee of its parent hop (the service that composed it). Compute it
        // here but do NOT move funds yet — all state must be committed before any
        // external token transfer (checks-effects-interactions), so even a token
        // with a reentrant `transfer` cannot re-enter `charge` against a stale
        // `spent` and push total payouts past the budget.
        let (to_parent, parent_payee) = if parent == 0 {
            (U256::zero(), None)
        } else {
            let parent_hop = self
                .hops
                .get(&(cascade_id, parent))
                .unwrap_or_revert_with(&self.env(), Error::UnknownParent);
            // floor(gross * bps / 10_000) without the full product, which
            // overflowed (an opaque trap) for any gross above
            // U256::MAX / 10_000, even when the hop fit the budget.
            let cut = mul_div_floor(gross, attribution_bps, BPS_DENOMINATOR);
            (cut, Some(parent_hop.payee))
        };
        let net = gross - to_parent;

        // EFFECTS: commit the hop and the increased spend first.
        let hop_id = cascade.next_hop;
        cascade.next_hop += 1;
        cascade.spent += gross;
        let token = cascade.token;
        self.cascades.set(&cascade_id, cascade);
        self.hops.set(
            &(cascade_id, hop_id),
            Hop {
                payee,
                parent,
                gross,
                net_to_payee: net,
                to_parent,
            },
        );

        // INTERACTIONS: pay out last.
        if let Some(parent_payee) = parent_payee {
            if !to_parent.is_zero() {
                CascadeTokenContractRef::new(self.env(), token).transfer(parent_payee, to_parent);
            }
        }
        if !net.is_zero() {
            CascadeTokenContractRef::new(self.env(), token).transfer(payee, net);
        }
        self.env().emit_event(HopCharged {
            cascade_id,
            hop_id,
            parent,
            payee,
            gross,
            to_parent,
        });
        hop_id
    }

    /// Owner closes the cascade and reclaims the unspent remainder.
    pub fn close(&mut self, cascade_id: u64) {
        let mut cascade = self.load(cascade_id);
        if cascade.closed {
            self.env().revert(Error::CascadeIsClosed);
        }
        if self.env().caller() != cascade.owner {
            self.env().revert(Error::NotOwner);
        }
        let refund = cascade.budget - cascade.spent;
        cascade.closed = true;
        let owner = cascade.owner;
        let token = cascade.token;
        let spent = cascade.spent;
        self.cascades.set(&cascade_id, cascade);
        if !refund.is_zero() {
            CascadeTokenContractRef::new(self.env(), token).transfer(owner, refund);
        }
        self.env().emit_event(CascadeClosed {
            cascade_id,
            spent,
            refunded: refund,
        });
    }

    pub fn get_cascade(&self, cascade_id: u64) -> Cascade {
        self.load(cascade_id)
    }

    pub fn get_hop(&self, cascade_id: u64, hop_id: u64) -> Hop {
        self.hops
            .get(&(cascade_id, hop_id))
            .unwrap_or_revert_with(&self.env(), Error::UnknownParent)
    }

    /// Budget still available to charge.
    pub fn remaining(&self, cascade_id: u64) -> U256 {
        let cascade = self.load(cascade_id);
        cascade.budget - cascade.spent
    }

    pub fn cascade_count(&self) -> u64 {
        self.next_id.get_or_default()
    }

    fn load(&self, cascade_id: u64) -> Cascade {
        if !self.exists.get_or_default(&cascade_id) {
            self.env().revert(Error::UnknownCascade);
        }
        self.cascades
            .get(&cascade_id)
            .unwrap_or_revert_with(&self.env(), Error::UnknownCascade)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::demo_token::DemoTokenHostRef;
    use crate::test_util::{
        deploy_demo_token as deploy_token, deploy_demo_token_u256, on_casper_backend, Lcg,
    };
    use odra::casper_types::U256;
    use odra::host::{Deployer, HostEnv, NoArgs};

    #[test]
    fn budget_tree_with_attribution() {
        let env = odra_test::env();
        let agent = env.get_account(0); // holds the initial supply
        let gateway = env.get_account(1); // operator
        let analyst = env.get_account(2);
        let data = env.get_account(3);

        let mut token = deploy_token(&env, 1_000_000);
        let mut controller = CascadeController::deploy(&env, NoArgs);

        // Agent opens a cascade with a 1000-token budget, delegating charging to
        // the gateway operator.
        env.set_caller(agent);
        token.approve(controller.address(), U256::from(1_000u64));
        let cid = controller.open(gateway, token.address(), U256::from(1_000u64));
        assert_eq!(controller.remaining(cid), U256::from(1_000u64));

        // Gateway charges the root hop: the agent pays the analyst 100 (no parent).
        env.set_caller(gateway);
        let analyst_hop = controller.charge(cid, 0, analyst, U256::from(100u64), 0);
        assert_eq!(token.balance_of(analyst), U256::from(100u64));

        // Analyst buys data (child hop) gross 30 with 20% attribution back up:
        // data gets 24, analyst (parent payee) gets 6.
        controller.charge(cid, analyst_hop, data, U256::from(30u64), 2_000);
        assert_eq!(token.balance_of(data), U256::from(24u64));
        assert_eq!(token.balance_of(analyst), U256::from(106u64));

        // Budget enforcement: total spent is 130; a 900-token hop would exceed
        // the 1000 budget and must revert.
        let err = controller.try_charge(cid, 0, data, U256::from(900u64), 0);
        assert_eq!(err, Err(Error::BudgetExceeded.into()));
        assert_eq!(controller.remaining(cid), U256::from(1_000u64 - 130u64));

        // Agent closes and reclaims the unspent 870.
        env.set_caller(agent);
        controller.close(cid);
        // Agent started with 1,000,000, deposited 1000, got 870 back.
        assert_eq!(token.balance_of(agent), U256::from(1_000_000u64 - 130u64));
    }

    #[test]
    fn only_operator_can_charge() {
        let env = odra_test::env();
        let agent = env.get_account(0);
        let gateway = env.get_account(1);
        let intruder = env.get_account(4);

        let mut token = deploy_token(&env, 1_000_000);
        let mut controller = CascadeController::deploy(&env, NoArgs);
        env.set_caller(agent);
        token.approve(controller.address(), U256::from(1_000u64));
        let cid = controller.open(gateway, token.address(), U256::from(1_000u64));

        env.set_caller(intruder);
        let err = controller.try_charge(cid, 0, intruder, U256::from(10u64), 0);
        assert_eq!(err, Err(Error::NotOperator.into()));
    }

    /// Account 0 (which holds the token supply) opens a cascade of `budget`
    /// that `operator` may charge.
    fn open_cascade(
        env: &HostEnv,
        token: &mut DemoTokenHostRef,
        controller: &mut CascadeControllerHostRef,
        operator: Address,
        budget: u64,
    ) -> u64 {
        env.set_caller(env.get_account(0));
        token.approve(controller.address(), U256::from(budget));
        controller.open(operator, token.address(), U256::from(budget))
    }

    // Budget and attribution invariants over many hops with uneven
    // attribution: spent never exceeds the budget, every hop splits its gross
    // exactly into net + to_parent, everything paid out equals spent, and the
    // controller still holds budget - spent.
    #[test]
    fn spent_stays_within_budget_and_payouts_equal_spent() {
        let env = odra_test::env();
        let owner = env.get_account(0);
        let gateway = env.get_account(1);
        let payees = [
            env.get_account(2),
            env.get_account(3),
            env.get_account(4),
            env.get_account(5),
        ];
        let budget = U256::from(10_000u64);
        let mut token = deploy_token(&env, 1_000_000);
        let mut controller = CascadeController::deploy(&env, NoArgs);
        let cid = open_cascade(&env, &mut token, &mut controller, gateway, 10_000);

        env.set_caller(gateway);
        let mut rng = Lcg(7);
        let mut hops: Vec<u64> = Vec::new();
        let mut spent = U256::zero();
        let mut rejected = 0;
        for _ in 0..80 {
            let gross = U256::from(rng.below(400));
            let payee = payees[rng.below(4) as usize];
            let parent = if hops.is_empty() || rng.below(3) == 0 {
                0
            } else {
                hops[rng.below(hops.len() as u64) as usize]
            };
            let bps = [0u64, 1, 2_000, 3_333, 9_999, 10_000][rng.below(6) as usize];

            match controller.try_charge(cid, parent, payee, gross, bps) {
                Ok(hop_id) => {
                    let hop = controller.get_hop(cid, hop_id);
                    assert_eq!(hop.net_to_payee + hop.to_parent, gross);
                    let expected_cut = if parent == 0 {
                        U256::zero()
                    } else {
                        gross * U256::from(bps) / U256::from(BPS_DENOMINATOR)
                    };
                    assert_eq!(hop.to_parent, expected_cut);
                    hops.push(hop_id);
                    spent += gross;
                }
                Err(err) => {
                    assert_eq!(err, Error::BudgetExceeded.into());
                    assert!(spent + gross > budget);
                    rejected += 1;
                }
            }

            let cascade = controller.get_cascade(cid);
            assert_eq!(cascade.spent, spent);
            assert!(cascade.spent <= cascade.budget);
            assert_eq!(controller.remaining(cid), budget - spent);
            let paid_out = payees
                .iter()
                .fold(U256::zero(), |sum, p| sum + token.balance_of(*p));
            assert_eq!(paid_out, spent);
            assert_eq!(token.balance_of(controller.address()), budget - spent);
        }
        // The run must have exercised both outcomes.
        assert!(!hops.is_empty());
        assert!(rejected > 0);

        // Closing refunds exactly the unspent budget and freezes the cascade.
        env.set_caller(owner);
        controller.close(cid);
        assert_eq!(token.balance_of(controller.address()), U256::zero());
        assert_eq!(token.balance_of(owner), U256::from(1_000_000u64) - spent);
        assert!(env.emitted_event(
            &controller,
            CascadeClosed {
                cascade_id: cid,
                spent,
                refunded: budget - spent,
            }
        ));
    }

    #[test]
    fn a_hop_may_use_the_exact_remaining_budget_but_not_one_unit_more() {
        let env = odra_test::env();
        let gateway = env.get_account(1);
        let payee = env.get_account(2);
        let mut token = deploy_token(&env, 1_000_000);
        let mut controller = CascadeController::deploy(&env, NoArgs);
        let cid = open_cascade(&env, &mut token, &mut controller, gateway, 1_000);

        env.set_caller(gateway);
        controller.charge(cid, 0, payee, U256::from(400u64), 0);
        assert_eq!(
            controller.try_charge(cid, 0, payee, U256::from(601u64), 0),
            Err(Error::BudgetExceeded.into())
        );
        controller.charge(cid, 0, payee, U256::from(600u64), 0);
        assert_eq!(controller.remaining(cid), U256::zero());
        assert_eq!(
            controller.try_charge(cid, 0, payee, U256::one(), 0),
            Err(Error::BudgetExceeded.into())
        );
        // A gross so large that spent + gross overflows U256 is rejected the
        // same way.
        assert_eq!(
            controller.try_charge(cid, 0, payee, U256::MAX, 0),
            Err(Error::BudgetExceeded.into())
        );
        assert_eq!(token.balance_of(payee), U256::from(1_000u64));
    }

    // The attribution cut is computed without the full `gross * bps`
    // product, so every hop that fits the budget can be charged. Before, a
    // child hop with a gross above U256::MAX / 10_000 and a non-zero
    // attribution trapped even inside the budget. Such budgets are possible:
    // the cascade owner picks the token.
    #[test]
    fn a_huge_child_hop_within_budget_is_charged_without_overflow() {
        let env = odra_test::env();
        let gateway = env.get_account(1);
        let parent_payee = env.get_account(2);
        let child_payee = env.get_account(3);
        env.set_caller(env.get_account(0));
        let mut token = deploy_demo_token_u256(&env, U256::MAX);
        let mut controller = CascadeController::deploy(&env, NoArgs);
        token.approve(controller.address(), U256::MAX);
        let cid = controller.open(gateway, token.address(), U256::MAX);

        env.set_caller(gateway);
        let root = controller.charge(cid, 0, parent_payee, U256::one(), 0);
        let gross = U256::MAX / 2;
        let child = controller
            .try_charge(cid, root, child_payee, gross, 5_000)
            .expect("a hop within the budget must not trap");
        let hop = controller.get_hop(cid, child);
        assert_eq!(hop.to_parent, gross / 2);
        assert_eq!(hop.net_to_payee, gross - gross / 2);
        assert_eq!(token.balance_of(parent_payee), U256::one() + gross / 2);
        assert_eq!(token.balance_of(child_payee), gross - gross / 2);

        // The rest of the budget, at 25% attribution, splits exactly as well.
        let rest = controller.remaining(cid);
        let last = controller.charge(cid, child, parent_payee, rest, 2_500);
        assert_eq!(controller.get_hop(cid, last).to_parent, rest / 4);
        assert_eq!(controller.get_cascade(cid).spent, U256::MAX);
        assert_eq!(token.balance_of(controller.address()), U256::zero());
        assert_eq!(
            token.balance_of(parent_payee) + token.balance_of(child_payee),
            U256::MAX
        );
    }

    #[test]
    fn rejects_invalid_hops_and_actions_on_closed_cascades() {
        let env = odra_test::env();
        let owner = env.get_account(0);
        let gateway = env.get_account(1);
        let payee = env.get_account(2);
        let mut token = deploy_token(&env, 1_000_000);
        let mut controller = CascadeController::deploy(&env, NoArgs);
        let cid = open_cascade(&env, &mut token, &mut controller, gateway, 1_000);

        env.set_caller(gateway);
        assert_eq!(
            controller.try_charge(cid, 0, payee, U256::one(), BPS_DENOMINATOR + 1),
            Err(Error::InvalidAttribution.into())
        );
        assert_eq!(
            controller.try_charge(cid, 99, payee, U256::one(), 0),
            Err(Error::UnknownParent.into())
        );
        assert_eq!(
            controller.try_charge(cid + 1, 0, payee, U256::one(), 0),
            Err(Error::UnknownCascade.into())
        );
        // Full attribution sends the whole hop to the parent's payee.
        let parent = controller.charge(cid, 0, payee, U256::from(10u64), 0);
        let child_payee = env.get_account(3);
        controller.charge(cid, parent, child_payee, U256::from(50u64), BPS_DENOMINATOR);
        assert_eq!(token.balance_of(child_payee), U256::zero());
        assert_eq!(token.balance_of(payee), U256::from(60u64));

        // Only the owner may close, and only once; a closed cascade takes no hops.
        assert_eq!(controller.try_close(cid), Err(Error::NotOwner.into()));
        env.set_caller(owner);
        controller.close(cid);
        assert_eq!(
            controller.try_close(cid),
            Err(Error::CascadeIsClosed.into())
        );
        env.set_caller(gateway);
        assert_eq!(
            controller.try_charge(cid, 0, payee, U256::one(), 0),
            Err(Error::CascadeIsClosed.into())
        );
    }

    /// Test-only CEP-18 stand-in whose `transfer` can re-enter
    /// `CascadeController::charge` once. It is also the cascade operator, so
    /// the re-entrant call passes the operator check: the worst case for the
    /// checks-effects-interactions ordering of `charge` (July fix C2).
    #[odra::module]
    pub struct ReentrantToken {
        balances: Mapping<Address, U256>,
        armed: Var<bool>,
        controller: Var<Address>,
        cascade_id: Var<u64>,
        reentry_payee: Var<Address>,
        reentry_gross: Var<U256>,
    }

    #[odra::module]
    impl ReentrantToken {
        pub fn init(&mut self, supply: U256) {
            let caller = self.env().caller();
            self.balances.set(&caller, supply);
        }

        pub fn balance_of(&self, address: Address) -> U256 {
            self.balances.get_or_default(&address)
        }

        pub fn transfer(&mut self, recipient: Address, amount: U256) {
            let sender = self.env().caller();
            self.move_balance(sender, recipient, amount);
            if self.armed.get_or_default() {
                self.armed.set(false);
                let controller = self.controller.get().unwrap_or_revert(&self.env());
                let payee = self.reentry_payee.get().unwrap_or_revert(&self.env());
                CascadeControllerContractRef::new(self.env(), controller).charge(
                    self.cascade_id.get_or_default(),
                    0,
                    payee,
                    self.reentry_gross.get_or_default(),
                    0,
                );
            }
        }

        /// No allowance bookkeeping: only the re-entrancy matters here.
        pub fn transfer_from(&mut self, owner: Address, recipient: Address, amount: U256) {
            self.move_balance(owner, recipient, amount);
        }

        /// Re-enter `charge(cascade_id, 0, payee, gross, 0)` on the next `transfer`.
        pub fn arm(&mut self, controller: Address, cascade_id: u64, payee: Address, gross: U256) {
            self.controller.set(controller);
            self.cascade_id.set(cascade_id);
            self.reentry_payee.set(payee);
            self.reentry_gross.set(gross);
            self.armed.set(true);
        }

        /// Charge a root hop with this contract as the cascade operator.
        pub fn charge_as_operator(
            &mut self,
            controller: Address,
            cascade_id: u64,
            payee: Address,
            gross: U256,
        ) -> u64 {
            CascadeControllerContractRef::new(self.env(), controller)
                .charge(cascade_id, 0, payee, gross, 0)
        }

        fn move_balance(&mut self, from: Address, to: Address, amount: U256) {
            let left = self
                .balances
                .get_or_default(&from)
                .checked_sub(amount)
                .unwrap_or_revert(&self.env());
            self.balances.set(&from, left);
            let to_balance = self.balances.get_or_default(&to);
            self.balances.set(&to, to_balance + amount);
        }
    }

    /// A 100-token cascade whose operator and token are a `ReentrantToken`,
    /// next to a 1,000-token cascade of a bystander in the same controller
    /// (the funds an overspend would take).
    fn reentrancy_setup(
        env: &HostEnv,
    ) -> (
        ReentrantTokenHostRef,
        CascadeControllerHostRef,
        u64,
        Address,
    ) {
        let agent = env.get_account(0);
        let bystander = env.get_account(6);
        let payee = env.get_account(2);
        env.set_caller(agent);
        let mut token = ReentrantToken::deploy(
            env,
            ReentrantTokenInitArgs {
                supply: U256::from(1_000_000u64),
            },
        );
        let mut controller = CascadeController::deploy(env, NoArgs);
        token.transfer(bystander, U256::from(1_000u64));

        let cid = controller.open(token.address(), token.address(), U256::from(100u64));
        env.set_caller(bystander);
        controller.open(env.get_account(7), token.address(), U256::from(1_000u64));
        env.set_caller(agent);
        (token, controller, cid, payee)
    }

    // C2 regression: `charge` commits `spent` before it pays out, so a hop
    // that re-enters from the token's `transfer` sees the updated spend and
    // cannot push the payouts past the budget.
    #[test]
    fn reentrant_charge_cannot_exceed_the_budget() {
        if on_casper_backend() {
            eprintln!("skipped on the Casper backend: ReentrantToken has no wasm");
            return;
        }
        let env = odra_test::env();
        let (mut token, controller, cid, payee) = reentrancy_setup(&env);

        token.arm(controller.address(), cid, payee, U256::from(60u64));
        let result =
            token.try_charge_as_operator(controller.address(), cid, payee, U256::from(60u64));
        assert_eq!(result, Err(Error::BudgetExceeded.into()));

        // The whole call reverted: nothing was paid and nothing was spent.
        assert_eq!(token.balance_of(payee), U256::zero());
        assert_eq!(controller.get_cascade(cid).spent, U256::zero());
        assert_eq!(token.balance_of(controller.address()), U256::from(1_100u64));
    }

    // With the re-entrant hop inside the budget, both hops are recorded and
    // paid, and `spent` still equals the payouts. Before C2 the outer call
    // wrote back a stale `spent` (40 recorded, 80 paid).
    #[test]
    fn reentrant_charge_within_budget_keeps_spent_equal_to_payouts() {
        if on_casper_backend() {
            eprintln!("skipped on the Casper backend: ReentrantToken has no wasm");
            return;
        }
        let env = odra_test::env();
        let (mut token, controller, cid, payee) = reentrancy_setup(&env);

        token.arm(controller.address(), cid, payee, U256::from(40u64));
        let hop_id = token.charge_as_operator(controller.address(), cid, payee, U256::from(40u64));
        assert_eq!(hop_id, 1);

        let cascade = controller.get_cascade(cid);
        assert_eq!(cascade.spent, U256::from(80u64));
        assert_eq!(cascade.next_hop, 3);
        assert_eq!(token.balance_of(payee), U256::from(80u64));
        assert_eq!(
            token.balance_of(controller.address()),
            U256::from(1_100u64 - 80)
        );
    }
}

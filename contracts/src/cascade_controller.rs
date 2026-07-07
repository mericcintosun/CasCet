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

use odra::prelude::*;
use odra::casper_types::U256;
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
        CascadeTokenContractRef::new(self.env(), token).transfer_from(owner, self.env().self_address(), budget);

        let id = self.next_id.get_or_default();
        self.next_id.set(id + 1);
        self.cascades.set(
            &id,
            Cascade { owner, operator, token, budget, spent: U256::zero(), next_hop: 1, closed: false },
        );
        self.exists.set(&id, true);
        self.env().emit_event(CascadeOpened { cascade_id: id, owner, operator, budget });
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
        if cascade.spent + gross > cascade.budget {
            self.env().revert(Error::BudgetExceeded);
        }

        // Recursive attribution: redirect a share of this hop's gross to the
        // payee of its parent hop (the service that composed it).
        let to_parent = if parent == 0 {
            U256::zero()
        } else {
            let parent_hop = self
                .hops
                .get(&(cascade_id, parent))
                .unwrap_or_revert_with(&self.env(), Error::UnknownParent);
            let cut = gross * U256::from(attribution_bps) / U256::from(BPS_DENOMINATOR);
            if !cut.is_zero() {
                CascadeTokenContractRef::new(self.env(), cascade.token).transfer(parent_hop.payee, cut);
            }
            cut
        };
        let net = gross - to_parent;
        if !net.is_zero() {
            CascadeTokenContractRef::new(self.env(), cascade.token).transfer(payee, net);
        }

        let hop_id = cascade.next_hop;
        cascade.next_hop += 1;
        cascade.spent += gross;
        self.cascades.set(&cascade_id, cascade);
        self.hops.set(
            &(cascade_id, hop_id),
            Hop { payee, parent, gross, net_to_payee: net, to_parent },
        );
        self.env().emit_event(HopCharged { cascade_id, hop_id, parent, payee, gross, to_parent });
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
        self.env().emit_event(CascadeClosed { cascade_id, spent, refunded: refund });
    }

    pub fn get_cascade(&self, cascade_id: u64) -> Cascade {
        self.load(cascade_id)
    }

    pub fn get_hop(&self, cascade_id: u64, hop_id: u64) -> Hop {
        self.hops.get(&(cascade_id, hop_id)).unwrap_or_revert_with(&self.env(), Error::UnknownParent)
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
        self.cascades.get(&cascade_id).unwrap_or_revert_with(&self.env(), Error::UnknownCascade)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::casper_types::U256;
    use odra::host::{Deployer, NoArgs};
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
        token.approve(&controller.address(), &U256::from(1_000u64));
        let cid = controller.open(gateway, token.address(), U256::from(1_000u64));
        assert_eq!(controller.remaining(cid), U256::from(1_000u64));

        // Gateway charges the root hop: the agent pays the analyst 100 (no parent).
        env.set_caller(gateway);
        let analyst_hop = controller.charge(cid, 0, analyst, U256::from(100u64), 0);
        assert_eq!(token.balance_of(&analyst), U256::from(100u64));

        // Analyst buys data (child hop) gross 30 with 20% attribution back up:
        // data gets 24, analyst (parent payee) gets 6.
        controller.charge(cid, analyst_hop, data, U256::from(30u64), 2_000);
        assert_eq!(token.balance_of(&data), U256::from(24u64));
        assert_eq!(token.balance_of(&analyst), U256::from(106u64));

        // Budget enforcement: total spent is 130; a 900-token hop would exceed
        // the 1000 budget and must revert.
        let err = controller.try_charge(cid, 0, data, U256::from(900u64), 0);
        assert_eq!(err, Err(Error::BudgetExceeded.into()));
        assert_eq!(controller.remaining(cid), U256::from(1_000u64 - 130u64));

        // Agent closes and reclaims the unspent 870.
        env.set_caller(agent);
        controller.close(cid);
        // Agent started with 1,000,000, deposited 1000, got 870 back.
        assert_eq!(token.balance_of(&agent), U256::from(1_000_000u64 - 130u64));
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
        token.approve(&controller.address(), &U256::from(1_000u64));
        let cid = controller.open(gateway, token.address(), U256::from(1_000u64));

        env.set_caller(intruder);
        let err = controller.try_charge(cid, 0, intruder, U256::from(10u64), 0);
        assert_eq!(err, Err(Error::NotOperator.into()));
    }
}

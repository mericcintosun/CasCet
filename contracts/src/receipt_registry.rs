//! On-chain anchor for CasCet payment receipts.
//!
//! After a gateway settles an x402 micropayment for a tool call, it anchors a
//! compact receipt here. The registry makes two things verifiable by anyone,
//! without trusting the gateway's off-chain database:
//!
//!  1. that a given tool call was actually paid for (payment id -> amount, payee), and
//!  2. how payments compose into cascades (each receipt carries its `parent_id`,
//!     so a multi-hop payment chain reconstructs purely from on-chain data).
//!
//! Anchoring is permissioned: the deployer (a gateway operator) owns the
//! registry and may authorize additional recorder accounts.

use odra::prelude::*;
use odra::casper_types::U256;

/// A compact, immutable record of one settled tool-call payment.
#[odra::odra_type]
pub struct Receipt {
    /// CasCet payment id (uuid) minted by the settling gateway.
    pub payment_id: String,
    /// Payment id of the call that funded this one; empty string if this is a root.
    pub parent_id: String,
    /// Buyer (payer) public key, hex.
    pub payer: String,
    /// Payee public key or contract account, hex.
    pub payee: String,
    /// Raw CEP-18 token units transferred.
    pub amount: U256,
    /// Human-readable server name that served the call.
    pub server: String,
    /// Tool that was invoked.
    pub tool: String,
    /// Casper settlement deploy hash, hex.
    pub tx_hash: String,
    /// Block time (ms) at which the receipt was anchored.
    pub block_time: u64,
}

#[odra::event]
pub struct ReceiptAnchored {
    pub payment_id: String,
    pub parent_id: String,
    pub payee: String,
    pub amount: U256,
}

#[odra::odra_error]
pub enum Error {
    /// A receipt with this payment id was already anchored.
    AlreadyAnchored = 1,
    /// Caller is neither the owner nor an authorized recorder.
    Unauthorized = 2,
    /// The requested receipt does not exist.
    NotFound = 3,
}

#[odra::module(events = [ReceiptAnchored], errors = Error)]
pub struct ReceiptRegistry {
    owner: Var<Address>,
    recorders: Mapping<Address, bool>,
    receipts: Mapping<String, Receipt>,
    exists: Mapping<String, bool>,
    count: Var<u64>,
}

#[odra::module]
impl ReceiptRegistry {
    /// Deploy the registry. The caller becomes the owner and an authorized recorder.
    pub fn init(&mut self) {
        let caller = self.env().caller();
        self.owner.set(caller);
        self.recorders.set(&caller, true);
        self.count.set(0);
    }

    /// Authorize another account (e.g. a second gateway) to anchor receipts.
    pub fn authorize(&mut self, recorder: Address) {
        self.assert_owner();
        self.recorders.set(&recorder, true);
    }

    /// Revoke a recorder's authorization.
    pub fn revoke(&mut self, recorder: Address) {
        self.assert_owner();
        self.recorders.set(&recorder, false);
    }

    /// Anchor a settled payment receipt. Rejects duplicate payment ids.
    #[allow(clippy::too_many_arguments)]
    pub fn record(
        &mut self,
        payment_id: String,
        parent_id: String,
        payer: String,
        payee: String,
        amount: U256,
        server: String,
        tool: String,
        tx_hash: String,
    ) {
        self.assert_recorder();
        if self.exists.get_or_default(&payment_id) {
            self.env().revert(Error::AlreadyAnchored);
        }
        let block_time = self.env().get_block_time();
        let receipt = Receipt {
            payment_id: payment_id.clone(),
            parent_id: parent_id.clone(),
            payer,
            payee: payee.clone(),
            amount,
            server,
            tool,
            tx_hash,
            block_time,
        };
        self.receipts.set(&payment_id, receipt);
        self.exists.set(&payment_id, true);
        self.count.set(self.count.get_or_default() + 1);
        self.env().emit_event(ReceiptAnchored {
            payment_id,
            parent_id,
            payee,
            amount,
        });
    }

    /// Total number of anchored receipts.
    pub fn count(&self) -> u64 {
        self.count.get_or_default()
    }

    /// Whether a payment id has been anchored.
    pub fn is_anchored(&self, payment_id: String) -> bool {
        self.exists.get_or_default(&payment_id)
    }

    /// Fetch a receipt by payment id, reverting if it is unknown.
    pub fn get(&self, payment_id: String) -> Receipt {
        if !self.exists.get_or_default(&payment_id) {
            self.env().revert(Error::NotFound);
        }
        self.receipts.get(&payment_id).unwrap_or_revert(&self.env())
    }

    /// The registry owner.
    pub fn owner(&self) -> Address {
        self.owner.get().unwrap_or_revert(&self.env())
    }

    /// Whether an account may anchor receipts.
    pub fn is_recorder(&self, account: Address) -> bool {
        self.recorders.get_or_default(&account)
    }

    fn assert_owner(&self) {
        if self.env().caller() != self.owner() {
            self.env().revert(Error::Unauthorized);
        }
    }

    fn assert_recorder(&self) {
        if !self.recorders.get_or_default(&self.env().caller()) {
            self.env().revert(Error::Unauthorized);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::casper_types::U256;
    use odra::host::{Deployer, NoArgs};

    #[test]
    fn anchors_and_reads_back() {
        let env = odra_test::env();
        let mut reg = ReceiptRegistry::deploy(&env, NoArgs);

        reg.record(
            "pay-root".into(),
            "".into(),
            "01payer".into(),
            "01payee".into(),
            U256::from(5_000_000_000u64),
            "portfolio-analyst".into(),
            "analyze_portfolio".into(),
            "deadbeef".into(),
        );
        assert_eq!(reg.count(), 1);
        assert!(reg.is_anchored("pay-root".into()));

        let r = reg.get("pay-root".into());
        assert_eq!(r.parent_id, "");
        assert_eq!(r.amount, U256::from(5_000_000_000u64));
        assert_eq!(r.tool, "analyze_portfolio");
    }

    #[test]
    fn links_cascade_children_to_parent() {
        let env = odra_test::env();
        let mut reg = ReceiptRegistry::deploy(&env, NoArgs);

        reg.record("root".into(), "".into(), "01a".into(), "01b".into(), U256::from(10u64), "analyst".into(), "analyze".into(), "tx0".into());
        reg.record("child-1".into(), "root".into(), "01b".into(), "01c".into(), U256::from(1u64), "data".into(), "get_cspr".into(), "tx1".into());
        reg.record("child-2".into(), "root".into(), "01b".into(), "01c".into(), U256::from(2u64), "data".into(), "get_yields".into(), "tx2".into());

        assert_eq!(reg.count(), 3);
        assert_eq!(reg.get("child-1".into()).parent_id, "root");
        assert_eq!(reg.get("child-2".into()).parent_id, "root");
    }

    #[test]
    fn rejects_duplicate_payment_id() {
        let env = odra_test::env();
        let mut reg = ReceiptRegistry::deploy(&env, NoArgs);
        reg.record("dup".into(), "".into(), "01a".into(), "01b".into(), U256::from(1u64), "s".into(), "t".into(), "tx".into());

        let err = reg.try_record(
            "dup".into(), "".into(), "01a".into(), "01b".into(), U256::from(1u64), "s".into(), "t".into(), "tx".into(),
        );
        assert_eq!(err, Err(Error::AlreadyAnchored.into()));
    }

    #[test]
    fn only_authorized_can_record() {
        let env = odra_test::env();
        let mut reg = ReceiptRegistry::deploy(&env, NoArgs);
        let intruder = env.get_account(1);

        env.set_caller(intruder);
        let err = reg.try_record(
            "x".into(), "".into(), "01a".into(), "01b".into(), U256::from(1u64), "s".into(), "t".into(), "tx".into(),
        );
        assert_eq!(err, Err(Error::Unauthorized.into()));
    }

    #[test]
    fn owner_can_authorize_new_recorder() {
        let env = odra_test::env();
        let mut reg = ReceiptRegistry::deploy(&env, NoArgs);
        let second_gateway = env.get_account(1);
        reg.authorize(second_gateway);

        env.set_caller(second_gateway);
        reg.record("g2".into(), "".into(), "01a".into(), "01b".into(), U256::from(1u64), "s".into(), "t".into(), "tx".into());
        assert!(reg.is_anchored("g2".into()));
    }
}

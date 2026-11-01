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
//! registry and may authorize additional recorder accounts. A receipt records
//! what an authorized recorder asserted; check its `tx_hash` on-chain to
//! confirm the settlement itself.
//!
//! # Parent links
//!
//! `record` rejects an empty `payment_id` (the empty string marks a root
//! receipt's `parent_id`) and a receipt that names itself as its parent. It
//! does not require `parent_id` to be anchored already, on purpose: a gateway
//! runs a tool before it settles the call, so the downstream purchases the
//! tool makes are settled and anchored before their parent, and a parent whose
//! own settlement fails is never anchored at all. Readers that rebuild a
//! cascade must treat a `parent_id` that is not anchored (yet) as an
//! unresolved link.
//!
//! For the same reason the links can form a cycle: `A` may name a parent `B`
//! that is not anchored yet, and `B` may later name `A`. Only the one-receipt
//! cycle (`SelfParent`) is rejected, so readers that walk parent links must
//! remember the ids they have visited and stop at a repeat.
//!
//! # Ownership
//!
//! Ownership moves in two steps, as in odra-modules' `Ownable2Step`: the owner
//! proposes an account with `transfer_ownership`, and the transfer completes
//! only when that account calls `accept_ownership`. Completing it revokes the
//! previous owner's recorder right and grants one to the new owner, so a
//! rotated key cannot keep writing receipts.
//!
//! # Storage layout
//!
//! Odra derives storage keys from field positions, so new fields go at the end
//! of [`ReceiptRegistry`] and an in-place upgrade keeps existing state.

use odra::casper_types::U256;
use odra::prelude::*;
use odra_modules::access::events::{OwnershipTransferStarted, OwnershipTransferred};

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

/// `recorder` was granted the right to anchor receipts.
#[odra::event]
pub struct RecorderAuthorized {
    pub recorder: Address,
}

/// `recorder` lost the right to anchor receipts.
#[odra::event]
pub struct RecorderRevoked {
    pub recorder: Address,
}

#[odra::odra_error]
pub enum Error {
    /// A receipt with this payment id was already anchored.
    AlreadyAnchored = 1,
    /// Caller is neither the owner nor an authorized recorder.
    Unauthorized = 2,
    /// The requested receipt does not exist.
    NotFound = 3,
    /// Caller is not the account proposed by `transfer_ownership`, or no
    /// transfer is pending.
    NotPendingOwner = 4,
    /// `payment_id` is empty; the empty string is reserved for a root
    /// receipt's `parent_id`.
    EmptyPaymentId = 5,
    /// `parent_id` equals `payment_id`.
    SelfParent = 6,
}

/// Semantic version of the registry logic, returned by `version()`. Bump it
/// with every logic change so anyone can see which revision a package runs.
///
/// 2.0.0: two-step ownership (`transfer_ownership` now only proposes),
/// saturating `count`/`total_volume`, `record` input checks, recorder events.
///
/// Only the testnet demo registry (`hash-764ed719…`) is upgradable in place.
/// The testnet anchoring registry (`hash-bdf8422b…`) and the mainnet registry
/// (`hash-f86bef35…`) are locked packages: they keep the logic they were
/// installed with until a new package is installed and gateways point at it.
pub const REGISTRY_VERSION: &str = "2.0.0";

#[odra::module(
    events = [
        ReceiptAnchored,
        RecorderAuthorized,
        RecorderRevoked,
        OwnershipTransferStarted,
        OwnershipTransferred
    ],
    errors = Error
)]
pub struct ReceiptRegistry {
    owner: Var<Address>,
    recorders: Mapping<Address, bool>,
    receipts: Mapping<String, Receipt>,
    exists: Mapping<String, bool>,
    count: Var<u64>,
    /// Lifetime sum of all anchored amounts (added in v1.1.0 — safe because
    /// upgrades preserve existing storage and new Vars default to zero).
    total_volume: Var<U256>,
    /// Account proposed by `transfer_ownership` that has not accepted yet
    /// (added in v2.0.0 at the end of the struct, for the same reason).
    pending_owner: Var<Option<Address>>,
}

#[odra::module]
impl ReceiptRegistry {
    /// Deploy the registry. The caller becomes the owner and an authorized recorder.
    pub fn init(&mut self) {
        let caller = self.env().caller();
        self.owner.set(caller);
        self.set_recorder(caller, true);
        self.count.set(0);
        self.env().emit_event(OwnershipTransferred {
            previous_owner: None,
            new_owner: Some(caller),
        });
    }

    /// Authorize another account (e.g. a second gateway) to anchor receipts.
    pub fn authorize(&mut self, recorder: Address) {
        self.assert_owner();
        self.set_recorder(recorder, true);
    }

    /// Revoke a recorder's authorization.
    pub fn revoke(&mut self, recorder: Address) {
        self.assert_owner();
        self.set_recorder(recorder, false);
    }

    /// Propose `new_owner` as the next owner (e.g. to rotate a compromised or
    /// lost operator key). Nothing changes until `new_owner` calls
    /// `accept_ownership`; until then the current owner keeps every right and
    /// may replace the proposal or withdraw it with `cancel_ownership_transfer`.
    pub fn transfer_ownership(&mut self, new_owner: Address) {
        self.assert_owner();
        self.pending_owner.set(Some(new_owner));
        self.env().emit_event(OwnershipTransferStarted {
            previous_owner: Some(self.owner()),
            new_owner: Some(new_owner),
        });
    }

    /// Withdraw a pending ownership proposal. Only the owner may call. Emits
    /// `OwnershipTransferStarted` with `new_owner: None`, the signal
    /// OpenZeppelin's Ownable2Step gives when the zero address is proposed.
    pub fn cancel_ownership_transfer(&mut self) {
        self.assert_owner();
        self.pending_owner.set(None);
        self.env().emit_event(OwnershipTransferStarted {
            previous_owner: Some(self.owner()),
            new_owner: None,
        });
    }

    /// Complete the ownership transfer. Only the account proposed by
    /// `transfer_ownership` may call. The previous owner loses its recorder
    /// right and the new owner gains one; other recorders are untouched.
    pub fn accept_ownership(&mut self) {
        let caller = self.env().caller();
        if self.pending_owner() != Some(caller) {
            self.env().revert(Error::NotPendingOwner);
        }
        let previous_owner = self.owner();
        self.pending_owner.set(None);
        self.owner.set(caller);
        if previous_owner != caller {
            self.set_recorder(previous_owner, false);
        }
        self.set_recorder(caller, true);
        self.env().emit_event(OwnershipTransferred {
            previous_owner: Some(previous_owner),
            new_owner: Some(caller),
        });
    }

    /// Anchor a settled payment receipt.
    ///
    /// Reverts with `Unauthorized` unless the caller is an authorized recorder,
    /// with `EmptyPaymentId` for an empty `payment_id`, with `SelfParent` when
    /// `parent_id == payment_id`, and with `AlreadyAnchored` for a duplicate
    /// id. `parent_id` may name a receipt that is not anchored yet (see the
    /// module docs). The `count` and `total_volume` aggregates saturate
    /// instead of overflowing, so no `amount` can make later calls fail.
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
        if payment_id.is_empty() {
            self.env().revert(Error::EmptyPaymentId);
        }
        if parent_id == payment_id {
            self.env().revert(Error::SelfParent);
        }
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
        // Both aggregates saturate. A plain `+` panics on overflow (U256
        // always, u64 with overflow checks on), and once a recorder had pushed
        // the total close to the maximum every later `record` would fail, so a
        // locked package could never anchor again (finding M17).
        self.count
            .set(self.count.get_or_default().saturating_add(1));
        self.total_volume
            .set(self.total_volume.get_or_default().saturating_add(amount));
        self.env().emit_event(ReceiptAnchored {
            payment_id,
            parent_id,
            payee,
            amount,
        });
    }

    /// Total number of anchored receipts (saturates at `u64::MAX`).
    pub fn count(&self) -> u64 {
        self.count.get_or_default()
    }

    /// Lifetime sum of all anchored payment amounts (raw token units).
    ///
    /// Saturates at `U256::MAX`: once it gets there it stays there and
    /// `record` keeps working. Amounts are what recorders asserted, summed
    /// across every token they anchor, so read this as an activity indicator,
    /// not an accounting total.
    pub fn total_volume(&self) -> U256 {
        self.total_volume.get_or_default()
    }

    /// Semantic version of the deployed registry logic.
    pub fn version(&self) -> String {
        REGISTRY_VERSION.to_string()
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

    /// The account proposed by `transfer_ownership` that has not accepted yet.
    pub fn pending_owner(&self) -> Option<Address> {
        self.pending_owner.get().flatten()
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

    /// Set `account`'s recorder right, emitting an event only when it changes.
    fn set_recorder(&mut self, account: Address, authorized: bool) {
        if self.recorders.get_or_default(&account) == authorized {
            return;
        }
        self.recorders.set(&account, authorized);
        if authorized {
            self.env()
                .emit_event(RecorderAuthorized { recorder: account });
        } else {
            self.env().emit_event(RecorderRevoked { recorder: account });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::casper_types::U256;
    use odra::host::{Deployer, NoArgs};

    /// Anchor a receipt whose only interesting fields are its ids and amount.
    fn try_anchor(
        reg: &mut ReceiptRegistryHostRef,
        payment_id: &str,
        parent_id: &str,
        amount: U256,
    ) -> OdraResult<()> {
        reg.try_record(
            payment_id.into(),
            parent_id.into(),
            "01a".into(),
            "01b".into(),
            amount,
            "s".into(),
            "t".into(),
            "tx".into(),
        )
    }

    fn anchor(reg: &mut ReceiptRegistryHostRef, payment_id: &str, parent_id: &str, amount: U256) {
        try_anchor(reg, payment_id, parent_id, amount).expect("record should succeed");
    }

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
        assert_eq!(reg.total_volume(), U256::from(5_000_000_000u64));
        assert_eq!(reg.version(), "2.0.0");

        let r = reg.get("pay-root".into());
        assert_eq!(r.parent_id, "");
        assert_eq!(r.amount, U256::from(5_000_000_000u64));
        assert_eq!(r.tool, "analyze_portfolio");
    }

    #[test]
    fn init_emits_ownership_and_recorder_events() {
        let env = odra_test::env();
        let deployer = env.get_account(0);
        let reg = ReceiptRegistry::deploy(&env, NoArgs);

        assert_eq!(reg.owner(), deployer);
        assert_eq!(reg.pending_owner(), None);
        assert!(reg.is_recorder(deployer));
        assert!(env.emitted_event(
            &reg,
            OwnershipTransferred {
                previous_owner: None,
                new_owner: Some(deployer),
            }
        ));
        assert!(env.emitted_event(&reg, RecorderAuthorized { recorder: deployer }));
    }

    #[test]
    fn links_cascade_children_to_parent() {
        let env = odra_test::env();
        let mut reg = ReceiptRegistry::deploy(&env, NoArgs);

        reg.record(
            "root".into(),
            "".into(),
            "01a".into(),
            "01b".into(),
            U256::from(10u64),
            "analyst".into(),
            "analyze".into(),
            "tx0".into(),
        );
        reg.record(
            "child-1".into(),
            "root".into(),
            "01b".into(),
            "01c".into(),
            U256::from(1u64),
            "data".into(),
            "get_cspr".into(),
            "tx1".into(),
        );
        reg.record(
            "child-2".into(),
            "root".into(),
            "01b".into(),
            "01c".into(),
            U256::from(2u64),
            "data".into(),
            "get_yields".into(),
            "tx2".into(),
        );

        assert_eq!(reg.count(), 3);
        assert_eq!(reg.get("child-1".into()).parent_id, "root");
        assert_eq!(reg.get("child-2".into()).parent_id, "root");
    }

    #[test]
    fn rejects_duplicate_payment_id() {
        let env = odra_test::env();
        let mut reg = ReceiptRegistry::deploy(&env, NoArgs);
        reg.record(
            "dup".into(),
            "".into(),
            "01a".into(),
            "01b".into(),
            U256::from(1u64),
            "s".into(),
            "t".into(),
            "tx".into(),
        );

        let err = reg.try_record(
            "dup".into(),
            "".into(),
            "01a".into(),
            "01b".into(),
            U256::from(1u64),
            "s".into(),
            "t".into(),
            "tx".into(),
        );
        assert_eq!(err, Err(Error::AlreadyAnchored.into()));
    }

    #[test]
    fn get_reverts_for_an_unknown_payment_id() {
        let env = odra_test::env();
        let mut reg = ReceiptRegistry::deploy(&env, NoArgs);
        anchor(&mut reg, "known", "", U256::one());

        assert_eq!(reg.try_get("unknown".into()), Err(Error::NotFound.into()));
        assert!(!reg.is_anchored("unknown".into()));
    }

    #[test]
    fn only_authorized_can_record() {
        let env = odra_test::env();
        let mut reg = ReceiptRegistry::deploy(&env, NoArgs);
        let intruder = env.get_account(1);

        env.set_caller(intruder);
        let err = reg.try_record(
            "x".into(),
            "".into(),
            "01a".into(),
            "01b".into(),
            U256::from(1u64),
            "s".into(),
            "t".into(),
            "tx".into(),
        );
        assert_eq!(err, Err(Error::Unauthorized.into()));
    }

    #[test]
    fn owner_can_authorize_new_recorder() {
        let env = odra_test::env();
        let mut reg = ReceiptRegistry::deploy(&env, NoArgs);
        let second_gateway = env.get_account(1);
        reg.authorize(second_gateway);
        assert!(env.emitted_event(
            &reg,
            RecorderAuthorized {
                recorder: second_gateway
            }
        ));

        env.set_caller(second_gateway);
        reg.record(
            "g2".into(),
            "".into(),
            "01a".into(),
            "01b".into(),
            U256::from(1u64),
            "s".into(),
            "t".into(),
            "tx".into(),
        );
        assert!(reg.is_anchored("g2".into()));
    }

    #[test]
    fn owner_can_revoke_a_recorder() {
        let env = odra_test::env();
        let mut reg = ReceiptRegistry::deploy(&env, NoArgs);
        let gateway = env.get_account(1);
        reg.authorize(gateway);
        reg.revoke(gateway);
        assert!(!reg.is_recorder(gateway));
        assert!(env.emitted_event(&reg, RecorderRevoked { recorder: gateway }));

        env.set_caller(gateway);
        assert_eq!(
            try_anchor(&mut reg, "late", "", U256::one()),
            Err(Error::Unauthorized.into())
        );
        // Recorders cannot manage other recorders.
        assert_eq!(reg.try_authorize(gateway), Err(Error::Unauthorized.into()));
    }

    // M17: an overflowing `total_volume` used to panic, which made every later
    // `record` fail on a package that cannot be upgraded.
    #[test]
    fn total_volume_saturates_instead_of_bricking_record() {
        let env = odra_test::env();
        let mut reg = ReceiptRegistry::deploy(&env, NoArgs);

        anchor(&mut reg, "near-max", "", U256::MAX - U256::from(5u64));
        anchor(&mut reg, "overflowing", "", U256::from(10u64));
        assert_eq!(reg.total_volume(), U256::MAX);

        // The registry keeps anchoring after the aggregate saturates.
        anchor(&mut reg, "after-saturation", "", U256::MAX);
        assert_eq!(reg.total_volume(), U256::MAX);
        assert_eq!(reg.count(), 3);
        assert_eq!(reg.get("after-saturation".into()).amount, U256::MAX);
    }

    #[test]
    fn rejects_empty_payment_id() {
        let env = odra_test::env();
        let mut reg = ReceiptRegistry::deploy(&env, NoArgs);

        assert_eq!(
            try_anchor(&mut reg, "", "", U256::one()),
            Err(Error::EmptyPaymentId.into())
        );
        assert_eq!(
            try_anchor(&mut reg, "", "root", U256::one()),
            Err(Error::EmptyPaymentId.into())
        );
        assert_eq!(reg.count(), 0);
        assert!(!reg.is_anchored("".into()));
    }

    #[test]
    fn rejects_a_receipt_that_is_its_own_parent() {
        let env = odra_test::env();
        let mut reg = ReceiptRegistry::deploy(&env, NoArgs);

        assert_eq!(
            try_anchor(&mut reg, "loop", "loop", U256::one()),
            Err(Error::SelfParent.into())
        );
        assert!(!reg.is_anchored("loop".into()));
    }

    // Deliberately allowed: the gateway settles the purchases a tool makes
    // before the tool call itself, so children are anchored first.
    #[test]
    fn accepts_a_child_anchored_before_its_parent() {
        let env = odra_test::env();
        let mut reg = ReceiptRegistry::deploy(&env, NoArgs);

        anchor(&mut reg, "child", "parent", U256::one());
        assert!(!reg.is_anchored("parent".into()));
        anchor(&mut reg, "parent", "", U256::from(10u64));

        assert_eq!(reg.get("child".into()).parent_id, "parent");
        assert!(reg.is_anchored("parent".into()));
    }

    #[test]
    fn transfer_ownership_only_proposes() {
        let env = odra_test::env();
        let mut reg = ReceiptRegistry::deploy(&env, NoArgs);
        let owner = env.get_account(0);
        let next = env.get_account(1);

        reg.transfer_ownership(next);
        assert_eq!(reg.owner(), owner);
        assert_eq!(reg.pending_owner(), Some(next));
        assert!(!reg.is_recorder(next));
        assert!(env.emitted_event(
            &reg,
            OwnershipTransferStarted {
                previous_owner: Some(owner),
                new_owner: Some(next),
            }
        ));

        // The proposed owner has no rights before it accepts.
        env.set_caller(next);
        assert_eq!(reg.try_authorize(next), Err(Error::Unauthorized.into()));
        assert_eq!(
            try_anchor(&mut reg, "early", "", U256::one()),
            Err(Error::Unauthorized.into())
        );
    }

    #[test]
    fn accept_ownership_rotates_owner_and_recorder() {
        let env = odra_test::env();
        let mut reg = ReceiptRegistry::deploy(&env, NoArgs);
        let old_owner = env.get_account(0);
        let next = env.get_account(1);
        let gateway = env.get_account(2);
        reg.authorize(gateway);

        reg.transfer_ownership(next);
        env.set_caller(next);
        reg.accept_ownership();

        assert_eq!(reg.owner(), next);
        assert_eq!(reg.pending_owner(), None);
        assert!(reg.is_recorder(next));
        assert!(!reg.is_recorder(old_owner));
        assert!(reg.is_recorder(gateway));
        assert!(env.emitted_event(
            &reg,
            OwnershipTransferred {
                previous_owner: Some(old_owner),
                new_owner: Some(next),
            }
        ));
        assert!(env.emitted_event(
            &reg,
            RecorderRevoked {
                recorder: old_owner
            }
        ));
        assert!(env.emitted_event(&reg, RecorderAuthorized { recorder: next }));

        // The new owner can anchor and administer.
        anchor(&mut reg, "by-new-owner", "", U256::one());
        reg.revoke(gateway);
        assert!(!reg.is_recorder(gateway));

        // The rotated-out key can do neither.
        env.set_caller(old_owner);
        assert_eq!(
            try_anchor(&mut reg, "by-old-owner", "", U256::one()),
            Err(Error::Unauthorized.into())
        );
        assert_eq!(
            reg.try_authorize(old_owner),
            Err(Error::Unauthorized.into())
        );
        assert_eq!(
            reg.try_transfer_ownership(old_owner),
            Err(Error::Unauthorized.into())
        );
    }

    #[test]
    fn only_the_proposed_account_can_accept() {
        let env = odra_test::env();
        let mut reg = ReceiptRegistry::deploy(&env, NoArgs);
        let owner = env.get_account(0);
        let next = env.get_account(1);
        let stranger = env.get_account(2);

        // Nothing is pending yet.
        env.set_caller(next);
        assert_eq!(
            reg.try_accept_ownership(),
            Err(Error::NotPendingOwner.into())
        );

        env.set_caller(owner);
        reg.transfer_ownership(next);
        env.set_caller(stranger);
        assert_eq!(
            reg.try_accept_ownership(),
            Err(Error::NotPendingOwner.into())
        );
        // Only the owner can propose.
        assert_eq!(
            reg.try_transfer_ownership(stranger),
            Err(Error::Unauthorized.into())
        );
        assert_eq!(reg.pending_owner(), Some(next));
        assert_eq!(reg.owner(), owner);
    }

    #[test]
    fn owner_can_replace_or_cancel_a_proposal() {
        let env = odra_test::env();
        let mut reg = ReceiptRegistry::deploy(&env, NoArgs);
        let owner = env.get_account(0);
        let first = env.get_account(1);
        let second = env.get_account(2);

        reg.transfer_ownership(first);
        reg.transfer_ownership(second);
        env.set_caller(first);
        assert_eq!(
            reg.try_accept_ownership(),
            Err(Error::NotPendingOwner.into())
        );

        env.set_caller(owner);
        reg.cancel_ownership_transfer();
        assert_eq!(reg.pending_owner(), None);
        assert!(env.emitted_event(
            &reg,
            OwnershipTransferStarted {
                previous_owner: Some(owner),
                new_owner: None,
            }
        ));

        env.set_caller(second);
        assert_eq!(
            reg.try_accept_ownership(),
            Err(Error::NotPendingOwner.into())
        );
        assert_eq!(
            reg.try_cancel_ownership_transfer(),
            Err(Error::Unauthorized.into())
        );
        assert_eq!(reg.owner(), owner);
    }

    #[test]
    fn accepting_a_self_proposal_keeps_the_owner_a_recorder() {
        let env = odra_test::env();
        let mut reg = ReceiptRegistry::deploy(&env, NoArgs);
        let owner = env.get_account(0);

        reg.transfer_ownership(owner);
        reg.accept_ownership();
        assert_eq!(reg.owner(), owner);
        assert_eq!(reg.pending_owner(), None);
        assert!(reg.is_recorder(owner));
    }
}

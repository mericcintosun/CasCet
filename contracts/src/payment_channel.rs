//! Prepaid payment channels for high-frequency agent traffic.
//!
//! Writing every micropayment on-chain is wasteful when an agent calls a paid
//! MCP tool hundreds of times. Instead the agent opens a channel with a single
//! CEP-18 deposit, then authorizes usage OFF-CHAIN by signing monotonically
//! increasing vouchers (`channel_id || cumulative_amount`). The gateway (payee)
//! redeems the latest voucher on-chain whenever it wants its funds; the sender
//! reclaims whatever is left after the channel expires. Two on-chain writes
//! (open + close/redeem) cover thousands of calls.
//!
//! Voucher signatures are verified in-contract with Casper's native
//! `verify_signature`, so the channel needs no trusted intermediary.

use odra::casper_types::bytesrepr::{Bytes, ToBytes};
use odra::casper_types::{PublicKey, U256};
use odra::prelude::*;
use odra::ContractRef;

/// CEP-18 surface the channel needs (pull deposit in, push redeemed out).
#[odra::external_contract]
pub trait ChannelToken {
    fn transfer(&mut self, recipient: Address, amount: U256);
    fn transfer_from(&mut self, owner: Address, recipient: Address, amount: U256);
}

#[odra::odra_type]
pub struct Channel {
    pub sender: Address,
    pub payee: Address,
    pub token: Address,
    pub deposit: U256,
    pub redeemed: U256,
    pub expiration: u64,
    pub closed: bool,
}

#[odra::event]
pub struct ChannelOpened {
    pub channel_id: u64,
    pub sender: Address,
    pub payee: Address,
    pub deposit: U256,
}

#[odra::event]
pub struct VoucherRedeemed {
    pub channel_id: u64,
    pub cumulative: U256,
    pub paid: U256,
}

#[odra::event]
pub struct ChannelClosed {
    pub channel_id: u64,
    pub refunded: U256,
}

#[odra::odra_error]
pub enum Error {
    /// The provided public key does not correspond to the caller.
    SenderKeyMismatch = 1,
    /// The channel id is unknown.
    UnknownChannel = 2,
    /// The channel is already closed.
    ChannelClosed = 3,
    /// The voucher signature did not verify against the sender's key.
    InvalidVoucher = 4,
    /// Cumulative amount is not greater than what was already redeemed.
    NonMonotonic = 5,
    /// Cumulative amount exceeds the channel deposit.
    OverDeposit = 6,
    /// Only the sender may perform this action.
    NotSender = 7,
    /// The channel has not expired yet.
    NotExpired = 8,
    /// duration_ms is below the minimum or would overflow the block time.
    InvalidDuration = 9,
}

#[odra::module(events = [ChannelOpened, VoucherRedeemed, ChannelClosed], errors = Error)]
pub struct PaymentChannel {
    channels: Mapping<u64, Channel>,
    sender_keys: Mapping<u64, PublicKey>,
    exists: Mapping<u64, bool>,
    next_id: Var<u64>,
}

#[odra::module]
impl PaymentChannel {
    pub fn init(&mut self) {
        self.next_id.set(0);
    }

    /// Open a channel funded by pulling `deposit` CEP-18 tokens from the caller
    /// (who must have approved this contract). `sender_public_key` must belong
    /// to the caller — it is used later to verify off-chain vouchers.
    pub fn open(
        &mut self,
        sender_public_key: PublicKey,
        payee: Address,
        token: Address,
        deposit: U256,
        duration_ms: u64,
    ) -> u64 {
        let sender = self.env().caller();
        if Address::from(sender_public_key.clone()) != sender {
            self.env().revert(Error::SenderKeyMismatch);
        }
        // Reject zero/dust durations and any duration that would overflow u64 and
        // wrap `expiration` into the past — that would make the channel instantly
        // closable and let the sender rug a payee that already rendered service.
        if duration_ms < MIN_CHANNEL_DURATION_MS {
            self.env().revert(Error::InvalidDuration);
        }
        let expiration = self
            .env()
            .get_block_time()
            .checked_add(duration_ms)
            .unwrap_or_revert_with(&self.env(), Error::InvalidDuration);
        ChannelTokenContractRef::new(self.env(), token).transfer_from(
            sender,
            self.env().self_address(),
            deposit,
        );

        let id = self.next_id.get_or_default();
        self.next_id.set(id + 1);
        let channel = Channel {
            sender,
            payee,
            token,
            deposit,
            redeemed: U256::zero(),
            expiration,
            closed: false,
        };
        self.channels.set(&id, channel);
        self.sender_keys.set(&id, sender_public_key);
        self.exists.set(&id, true);
        self.env().emit_event(ChannelOpened {
            channel_id: id,
            sender,
            payee,
            deposit,
        });
        id
    }

    /// Redeem a signed voucher. `cumulative` is the total the sender has
    /// authorized so far; the payee is paid the delta since the last redeem.
    pub fn redeem(&mut self, channel_id: u64, cumulative: U256, signature: Bytes) {
        let mut channel = self.load(channel_id);
        if channel.closed {
            self.env().revert(Error::ChannelClosed);
        }
        let key = self
            .sender_keys
            .get(&channel_id)
            .unwrap_or_revert_with(&self.env(), Error::UnknownChannel);
        let contract = contract_hash_bytes(&self.env().self_address());
        let message = Bytes::from(voucher_message(contract, channel_id, &cumulative));
        if !self.env().verify_signature(&message, &signature, &key) {
            self.env().revert(Error::InvalidVoucher);
        }
        if cumulative <= channel.redeemed {
            self.env().revert(Error::NonMonotonic);
        }
        if cumulative > channel.deposit {
            self.env().revert(Error::OverDeposit);
        }
        let paid = cumulative - channel.redeemed;
        channel.redeemed = cumulative;
        let payee = channel.payee;
        let token = channel.token;
        self.channels.set(&channel_id, channel);
        ChannelTokenContractRef::new(self.env(), token).transfer(payee, paid);
        self.env().emit_event(VoucherRedeemed {
            channel_id,
            cumulative,
            paid,
        });
    }

    /// After expiry the sender reclaims the unredeemed remainder and closes the
    /// channel. Callable only by the sender.
    pub fn close(&mut self, channel_id: u64) {
        let mut channel = self.load(channel_id);
        if channel.closed {
            self.env().revert(Error::ChannelClosed);
        }
        if self.env().caller() != channel.sender {
            self.env().revert(Error::NotSender);
        }
        if self.env().get_block_time() < channel.expiration {
            self.env().revert(Error::NotExpired);
        }
        let refund = channel.deposit - channel.redeemed;
        channel.closed = true;
        let sender = channel.sender;
        let token = channel.token;
        self.channels.set(&channel_id, channel);
        if !refund.is_zero() {
            ChannelTokenContractRef::new(self.env(), token).transfer(sender, refund);
        }
        self.env().emit_event(ChannelClosed {
            channel_id,
            refunded: refund,
        });
    }

    /// Full channel state.
    pub fn get_channel(&self, channel_id: u64) -> Channel {
        self.load(channel_id)
    }

    /// Amount still redeemable by the payee right now.
    pub fn redeemable(&self, channel_id: u64) -> U256 {
        let channel = self.load(channel_id);
        channel.deposit - channel.redeemed
    }

    pub fn channel_count(&self) -> u64 {
        self.next_id.get_or_default()
    }

    fn load(&self, channel_id: u64) -> Channel {
        if !self.exists.get_or_default(&channel_id) {
            self.env().revert(Error::UnknownChannel);
        }
        self.channels
            .get(&channel_id)
            .unwrap_or_revert_with(&self.env(), Error::UnknownChannel)
    }
}

/// Domain-separation tag baked into every voucher so a signature is bound to
/// this contract module and cannot be reinterpreted by another verifier.
const VOUCHER_DOMAIN: &[u8] = b"CASCET_PAYMENT_CHANNEL_VOUCHER_V2";

/// Minimum channel duration (ms). Rejects zero/dust windows that would let a
/// sender `close` and rug a payee before it can redeem.
pub const MIN_CHANNEL_DURATION_MS: u64 = 1_000;

/// Canonical voucher message:
/// `DOMAIN || contract package hash (32 bytes) || channel_id (LE u64) || cumulative (U256 bytes)`.
/// Binding the contract package hash prevents cross-deployment / cross-chain
/// replay: a testnet voucher can never be redeemed on the mainnet deployment
/// (or a fork, or a re-created channel that reuses an id), even with a colliding
/// channel id and a reused sender key. Signer and contract must build this identically.
///
/// `cumulative` uses Casper bytesrepr: one length byte, then the value in
/// little-endian with trailing zero bytes dropped (400 encodes as `02 90 01`,
/// zero as `00`). The `voucher_message_layout_is_stable` test pins the layout.
pub fn voucher_message(contract: [u8; 32], channel_id: u64, cumulative: &U256) -> Vec<u8> {
    let mut msg = Vec::with_capacity(VOUCHER_DOMAIN.len() + 32 + 8 + 32);
    msg.extend_from_slice(VOUCHER_DOMAIN);
    msg.extend_from_slice(&contract);
    msg.extend_from_slice(&channel_id.to_le_bytes());
    msg.extend_from_slice(&cumulative.to_bytes().unwrap_or_default());
    msg
}

/// Extract the 32-byte hash from a contract/account Address.
fn contract_hash_bytes(addr: &Address) -> [u8; 32] {
    match addr {
        Address::Contract(h) => h.value(),
        Address::Account(h) => h.value(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::demo_token::DemoTokenHostRef;
    use crate::test_util::deploy_demo_token;
    use odra::casper_types::U256;
    use odra::host::{Deployer, HostEnv, NoArgs};

    /// Account 1 is the sender (funded with 10,000 tokens by account 0, which
    /// holds the supply) and account 2 the payee. Vouchers are signed with the
    /// test environment's own account keys, so the same tests run on OdraVM and
    /// on the Casper execution engine.
    struct Party {
        sender: Address,
        public_key: PublicKey,
        payee: Address,
        token: DemoTokenHostRef,
    }

    fn party(env: &HostEnv) -> Party {
        let sender = env.get_account(1);
        env.set_caller(env.get_account(0));
        let mut token = deploy_demo_token(env, 1_000_000);
        token.transfer(sender, U256::from(10_000u64));
        Party {
            sender,
            public_key: env.public_key(&sender),
            payee: env.get_account(2),
            token,
        }
    }

    /// The sender approves and opens a channel with a 10 s lifetime.
    fn open(
        env: &HostEnv,
        p: &mut Party,
        channel: &mut PaymentChannelHostRef,
        deposit: u64,
    ) -> u64 {
        env.set_caller(p.sender);
        p.token.approve(channel.address(), U256::from(deposit));
        channel.open(
            p.public_key.clone(),
            p.payee,
            p.token.address(),
            U256::from(deposit),
            10_000,
        )
    }

    /// Sign `message` with `signer`'s key, as an off-chain signer would.
    fn sign_as(env: &HostEnv, signer: Address, message: Vec<u8>) -> Bytes {
        env.sign_message(&Bytes::from(message), &signer)
    }

    /// A valid voucher from the sender for `channel_id` on `channel`.
    fn voucher(
        env: &HostEnv,
        p: &Party,
        channel: &PaymentChannelHostRef,
        channel_id: u64,
        cumulative: u64,
    ) -> Bytes {
        let contract = contract_hash_bytes(&channel.address());
        let message = voucher_message(contract, channel_id, &U256::from(cumulative));
        sign_as(env, p.sender, message)
    }

    #[test]
    fn open_redeem_and_close() {
        let env = odra_test::env();
        let mut p = party(&env);
        let mut channel = PaymentChannel::deploy(&env, NoArgs);
        let id = open(&env, &mut p, &mut channel, 1_000);
        assert_eq!(channel.redeemable(id), U256::from(1_000u64));

        // Off-chain the sender signs a voucher for cumulative 400; the payee
        // redeems it.
        env.set_caller(p.payee);
        channel.redeem(id, U256::from(400u64), voucher(&env, &p, &channel, id, 400));
        assert_eq!(p.token.balance_of(p.payee), U256::from(400u64));
        assert_eq!(channel.redeemable(id), U256::from(600u64));

        // A second, larger voucher pays only the delta.
        channel.redeem(id, U256::from(650u64), voucher(&env, &p, &channel, id, 650));
        assert_eq!(p.token.balance_of(p.payee), U256::from(650u64));

        // After expiry the sender reclaims the remaining 350.
        env.advance_block_time(20_000);
        env.set_caller(p.sender);
        channel.close(id);
        assert_eq!(p.token.balance_of(p.sender), U256::from(10_000u64 - 650));
    }

    #[test]
    fn rejects_forged_voucher() {
        let env = odra_test::env();
        let mut p = party(&env);
        let mut channel = PaymentChannel::deploy(&env, NoArgs);
        let id = open(&env, &mut p, &mut channel, 1_000);

        // Another account signs a correctly built voucher.
        let attacker = env.get_account(3);
        let contract = contract_hash_bytes(&channel.address());
        let cumulative = U256::from(400u64);
        let forged = sign_as(&env, attacker, voucher_message(contract, id, &cumulative));

        env.set_caller(p.payee);
        assert_eq!(
            channel.try_redeem(id, cumulative, forged),
            Err(Error::InvalidVoucher.into())
        );
    }

    #[test]
    fn cannot_close_before_expiry() {
        let env = odra_test::env();
        let mut p = party(&env);
        let mut channel = PaymentChannel::deploy(&env, NoArgs);
        let id = open(&env, &mut p, &mut channel, 1_000);

        assert_eq!(channel.try_close(id), Err(Error::NotExpired.into()));
    }

    // Off-chain signers depend on this exact layout; changing it silently
    // would invalidate every voucher they produce.
    #[test]
    fn voucher_message_layout_is_stable() {
        let mut expected = b"CASCET_PAYMENT_CHANNEL_VOUCHER_V2".to_vec();
        expected.extend_from_slice(&[0xab; 32]);
        expected.extend_from_slice(&[7, 0, 0, 0, 0, 0, 0, 0]);
        expected.extend_from_slice(&[2, 0x90, 0x01]);
        assert_eq!(
            voucher_message([0xab; 32], 7, &U256::from(400u64)),
            expected
        );

        let zero = voucher_message([0; 32], 0, &U256::zero());
        assert_eq!(zero.len(), VOUCHER_DOMAIN.len() + 32 + 8 + 1);
        assert_eq!(zero.last(), Some(&0));
    }

    // C1 regression: a voucher names the channel contract's package hash, so
    // it cannot be replayed on another deployment that has a channel with the
    // same id, sender key and payee (e.g. testnet -> mainnet).
    #[test]
    fn voucher_is_bound_to_one_channel_contract() {
        let env = odra_test::env();
        let mut p = party(&env);
        let mut channel_a = PaymentChannel::deploy(&env, NoArgs);
        let mut channel_b = PaymentChannel::deploy(&env, NoArgs);
        let id_a = open(&env, &mut p, &mut channel_a, 1_000);
        let id_b = open(&env, &mut p, &mut channel_b, 1_000);
        assert_eq!(id_a, id_b);

        let for_a = voucher(&env, &p, &channel_a, id_a, 400);
        env.set_caller(p.payee);
        assert_eq!(
            channel_b.try_redeem(id_b, U256::from(400u64), for_a.clone()),
            Err(Error::InvalidVoucher.into())
        );
        channel_a.redeem(id_a, U256::from(400u64), for_a.clone());
        assert_eq!(
            channel_b.try_redeem(id_b, U256::from(400u64), for_a),
            Err(Error::InvalidVoucher.into())
        );
        assert_eq!(p.token.balance_of(p.payee), U256::from(400u64));
        assert_eq!(channel_b.redeemable(id_b), U256::from(1_000u64));
    }

    #[test]
    fn voucher_is_bound_to_its_channel_id() {
        let env = odra_test::env();
        let mut p = party(&env);
        let mut channel = PaymentChannel::deploy(&env, NoArgs);
        let first = open(&env, &mut p, &mut channel, 1_000);
        let second = open(&env, &mut p, &mut channel, 1_000);

        let for_first = voucher(&env, &p, &channel, first, 400);
        env.set_caller(p.payee);
        assert_eq!(
            channel.try_redeem(second, U256::from(400u64), for_first),
            Err(Error::InvalidVoucher.into())
        );
    }

    // Pre-July vouchers signed `channel_id || cumulative` with no domain tag
    // or contract hash; neither that nor any other variant may verify.
    #[test]
    fn vouchers_in_other_formats_are_rejected() {
        let env = odra_test::env();
        let mut p = party(&env);
        let mut channel = PaymentChannel::deploy(&env, NoArgs);
        let id = open(&env, &mut p, &mut channel, 1_000);
        let cumulative = U256::from(400u64);
        let contract = contract_hash_bytes(&channel.address());
        let tail = |msg: &mut Vec<u8>| {
            msg.extend_from_slice(&id.to_le_bytes());
            msg.extend_from_slice(&cumulative.to_bytes().unwrap());
        };

        let mut legacy_v1 = Vec::new();
        tail(&mut legacy_v1);
        let mut no_domain = contract.to_vec();
        tail(&mut no_domain);
        let mut other_domain = b"CASCET_PAYMENT_CHANNEL_VOUCHER_V1".to_vec();
        other_domain.extend_from_slice(&contract);
        tail(&mut other_domain);

        env.set_caller(p.payee);
        for message in [legacy_v1, no_domain, other_domain] {
            assert_eq!(
                channel.try_redeem(id, cumulative, sign_as(&env, p.sender, message)),
                Err(Error::InvalidVoucher.into())
            );
        }
        assert_eq!(p.token.balance_of(p.payee), U256::zero());
    }

    #[test]
    fn malformed_signature_bytes_are_rejected() {
        let env = odra_test::env();
        let mut p = party(&env);
        let mut channel = PaymentChannel::deploy(&env, NoArgs);
        let id = open(&env, &mut p, &mut channel, 1_000);

        env.set_caller(p.payee);
        for garbage in [vec![], vec![1u8, 2, 3], vec![0u8; 65]] {
            assert!(channel
                .try_redeem(id, U256::from(400u64), Bytes::from(garbage))
                .is_err());
        }
        assert_eq!(p.token.balance_of(p.payee), U256::zero());
        assert_eq!(channel.redeemable(id), U256::from(1_000u64));
    }

    #[test]
    fn redeem_is_monotonic_and_capped_by_the_deposit() {
        let env = odra_test::env();
        let mut p = party(&env);
        let mut channel = PaymentChannel::deploy(&env, NoArgs);
        let id = open(&env, &mut p, &mut channel, 1_000);

        // Anyone may submit a voucher; the funds always go to the payee.
        env.set_caller(env.get_account(5));
        channel.redeem(id, U256::from(400u64), voucher(&env, &p, &channel, id, 400));
        assert_eq!(p.token.balance_of(p.payee), U256::from(400u64));

        for stale in [400, 300] {
            assert_eq!(
                channel.try_redeem(
                    id,
                    U256::from(stale),
                    voucher(&env, &p, &channel, id, stale)
                ),
                Err(Error::NonMonotonic.into())
            );
        }
        assert_eq!(
            channel.try_redeem(
                id,
                U256::from(1_001u64),
                voucher(&env, &p, &channel, id, 1_001)
            ),
            Err(Error::OverDeposit.into())
        );
        channel.redeem(
            id,
            U256::from(1_000u64),
            voucher(&env, &p, &channel, id, 1_000),
        );
        assert_eq!(p.token.balance_of(p.payee), U256::from(1_000u64));
        assert_eq!(channel.redeemable(id), U256::zero());
    }

    // C4 regression: zero/dust durations and durations that would overflow
    // the expiration (wrapping it into the past) are rejected.
    #[test]
    fn open_rejects_dust_and_overflowing_durations() {
        let env = odra_test::env();
        let mut p = party(&env);
        let mut channel = PaymentChannel::deploy(&env, NoArgs);
        env.advance_block_time(5_000);

        env.set_caller(p.sender);
        p.token.approve(channel.address(), U256::from(1_000u64));
        for duration in [0, MIN_CHANNEL_DURATION_MS - 1, u64::MAX] {
            assert_eq!(
                channel.try_open(
                    p.public_key.clone(),
                    p.payee,
                    p.token.address(),
                    U256::from(1_000u64),
                    duration,
                ),
                Err(Error::InvalidDuration.into())
            );
        }
        let id = channel.open(
            p.public_key.clone(),
            p.payee,
            p.token.address(),
            U256::from(1_000u64),
            MIN_CHANNEL_DURATION_MS,
        );
        assert_eq!(
            channel.get_channel(id).expiration,
            env.block_time() + MIN_CHANNEL_DURATION_MS
        );
    }

    #[test]
    fn open_requires_the_callers_own_public_key() {
        let env = odra_test::env();
        let mut p = party(&env);
        let mut channel = PaymentChannel::deploy(&env, NoArgs);
        let other_key = env.public_key(&env.get_account(3));

        env.set_caller(p.sender);
        p.token.approve(channel.address(), U256::from(1_000u64));
        assert_eq!(
            channel.try_open(
                other_key,
                p.payee,
                p.token.address(),
                U256::from(1_000u64),
                10_000,
            ),
            Err(Error::SenderKeyMismatch.into())
        );
    }

    #[test]
    fn close_is_sender_only_after_expiry_and_final() {
        let env = odra_test::env();
        let mut p = party(&env);
        let mut channel = PaymentChannel::deploy(&env, NoArgs);
        let id = open(&env, &mut p, &mut channel, 1_000);

        env.set_caller(p.payee);
        channel.redeem(id, U256::from(250u64), voucher(&env, &p, &channel, id, 250));

        // Closable from the expiration instant, by the sender only.
        env.advance_block_time(10_000);
        assert_eq!(channel.try_close(id), Err(Error::NotSender.into()));
        env.set_caller(p.sender);
        channel.close(id);
        assert_eq!(p.token.balance_of(p.sender), U256::from(10_000u64 - 250));
        assert!(env.emitted_event(
            &channel,
            ChannelClosed {
                channel_id: id,
                refunded: U256::from(750u64),
            }
        ));

        // Payee + refund == deposit, and a closed channel stays closed.
        assert_eq!(p.token.balance_of(channel.address()), U256::zero());
        assert_eq!(channel.try_close(id), Err(Error::ChannelClosed.into()));
        env.set_caller(p.payee);
        assert_eq!(
            channel.try_redeem(id, U256::from(500u64), voucher(&env, &p, &channel, id, 500)),
            Err(Error::ChannelClosed.into())
        );
    }

    #[test]
    fn unknown_channel_ids_are_rejected() {
        let env = odra_test::env();
        let p = party(&env);
        let mut channel = PaymentChannel::deploy(&env, NoArgs);

        assert_eq!(channel.try_close(3), Err(Error::UnknownChannel.into()));
        assert_eq!(
            channel.try_redeem(3, U256::one(), voucher(&env, &p, &channel, 3, 1)),
            Err(Error::UnknownChannel.into())
        );
        assert_eq!(
            channel.try_get_channel(3),
            Err(Error::UnknownChannel.into())
        );
    }
}

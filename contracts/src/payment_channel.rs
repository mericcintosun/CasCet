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

use odra::prelude::*;
use odra::casper_types::bytesrepr::{Bytes, ToBytes};
use odra::casper_types::{PublicKey, U256};
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
        ChannelTokenContractRef::new(self.env(), token).transfer_from(sender, self.env().self_address(), deposit);

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
        self.env().emit_event(ChannelOpened { channel_id: id, sender, payee, deposit });
        id
    }

    /// Redeem a signed voucher. `cumulative` is the total the sender has
    /// authorized so far; the payee is paid the delta since the last redeem.
    pub fn redeem(&mut self, channel_id: u64, cumulative: U256, signature: Bytes) {
        let mut channel = self.load(channel_id);
        if channel.closed {
            self.env().revert(Error::ChannelClosed);
        }
        let key = self.sender_keys.get(&channel_id).unwrap_or_revert_with(&self.env(), Error::UnknownChannel);
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
        self.env().emit_event(VoucherRedeemed { channel_id, cumulative, paid });
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
        self.env().emit_event(ChannelClosed { channel_id, refunded: refund });
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
        self.channels.get(&channel_id).unwrap_or_revert_with(&self.env(), Error::UnknownChannel)
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
    use odra::casper_types::{crypto, SecretKey, U256};
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
    fn open_redeem_and_close() {
        let env = odra_test::env();

        // Sender keypair (we hold the secret to sign vouchers).
        let secret = SecretKey::generate_ed25519().unwrap();
        let sender_pk = PublicKey::from(&secret);
        let sender: Address = sender_pk.clone().into();
        let payee = env.get_account(2);

        let mut token = deploy_token(&env, 1_000_000);
        // Fund the sender and let them act.
        env.set_caller(env.get_account(0));
        token.transfer(&sender, &U256::from(10_000u64));

        let mut channel = PaymentChannel::deploy(&env, odra::host::NoArgs);

        // Sender approves the channel to pull the deposit, then opens.
        env.set_caller(sender);
        token.approve(&channel.address(), &U256::from(1_000u64));
        let id = channel.open(sender_pk.clone(), payee, token.address(), U256::from(1_000u64), 10_000);
        assert_eq!(channel.redeemable(id), U256::from(1_000u64));

        // Off-chain: sender signs a voucher for cumulative 400.
        let contract = contract_hash_bytes(&channel.address());
        let cumulative = U256::from(400u64);
        let msg = voucher_message(contract, id, &cumulative);
        let sig = crypto::sign(&msg, &secret, &sender_pk);
        let sig_bytes = Bytes::from(sig.to_bytes().unwrap());

        // Payee redeems it.
        env.set_caller(payee);
        channel.redeem(id, cumulative, sig_bytes);
        assert_eq!(token.balance_of(&payee), U256::from(400u64));
        assert_eq!(channel.redeemable(id), U256::from(600u64));

        // A second, larger voucher pays only the delta.
        let cumulative2 = U256::from(650u64);
        let sig2 = crypto::sign(&voucher_message(contract, id, &cumulative2), &secret, &sender_pk);
        channel.redeem(id, cumulative2, Bytes::from(sig2.to_bytes().unwrap()));
        assert_eq!(token.balance_of(&payee), U256::from(650u64));

        // After expiry the sender reclaims the remaining 350.
        env.advance_block_time(20_000);
        env.set_caller(sender);
        channel.close(id);
        assert_eq!(token.balance_of(&sender), U256::from(10_000u64 - 650u64));
    }

    #[test]
    fn rejects_forged_voucher() {
        let env = odra_test::env();
        let secret = SecretKey::generate_ed25519().unwrap();
        let sender_pk = PublicKey::from(&secret);
        let sender: Address = sender_pk.clone().into();
        let payee = env.get_account(2);

        let mut token = deploy_token(&env, 1_000_000);
        env.set_caller(env.get_account(0));
        token.transfer(&sender, &U256::from(10_000u64));
        let mut channel = PaymentChannel::deploy(&env, odra::host::NoArgs);
        env.set_caller(sender);
        token.approve(&channel.address(), &U256::from(1_000u64));
        let id = channel.open(sender_pk.clone(), payee, token.address(), U256::from(1_000u64), 10_000);

        // Wrong signer forges a voucher.
        let attacker = SecretKey::generate_ed25519().unwrap();
        let attacker_pk = PublicKey::from(&attacker);
        let cumulative = U256::from(400u64);
        let contract = contract_hash_bytes(&channel.address());
        let forged = crypto::sign(&voucher_message(contract, id, &cumulative), &attacker, &attacker_pk);

        env.set_caller(payee);
        let err = channel.try_redeem(id, cumulative, Bytes::from(forged.to_bytes().unwrap()));
        assert_eq!(err, Err(Error::InvalidVoucher.into()));
    }

    #[test]
    fn cannot_close_before_expiry() {
        let env = odra_test::env();
        let secret = SecretKey::generate_ed25519().unwrap();
        let sender_pk = PublicKey::from(&secret);
        let sender: Address = sender_pk.clone().into();
        let payee = env.get_account(2);

        let mut token = deploy_token(&env, 1_000_000);
        env.set_caller(env.get_account(0));
        token.transfer(&sender, &U256::from(10_000u64));
        let mut channel = PaymentChannel::deploy(&env, odra::host::NoArgs);
        env.set_caller(sender);
        token.approve(&channel.address(), &U256::from(1_000u64));
        let id = channel.open(sender_pk, payee, token.address(), U256::from(1_000u64), 10_000);

        assert_eq!(channel.try_close(id), Err(Error::NotExpired.into()));
    }
}

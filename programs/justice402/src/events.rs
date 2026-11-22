use anchor_lang::prelude::*;
use crate::state::DisputeStatus;

#[event]
pub struct DisputeOpened {
    pub receipt_hash: [u8; 32],
    pub buyer: Pubkey,
    pub provider: Pubkey,
    pub price: u64,
    pub claim_amount: u64,
    pub opened_at: i64,
}

#[event]
pub struct DisputeResolved {
    pub receipt_hash: [u8; 32],
    pub buyer: Pubkey,
    pub provider: Pubkey,
    pub status: DisputeStatus,
    pub ruling_hash: [u8; 32],
    pub payout: u64,
    pub resolved_at: i64,
}

#[event]
pub struct ProviderRegistered {
    pub provider: Pubkey,
    pub bond: u64,
    pub registered_at: i64,
}

#[event]
pub struct BondToppedUp {
    pub provider: Pubkey,
    pub amount: u64,
    pub total_bond: u64,
}

#[event]
pub struct WithdrawRequested {
    pub provider: Pubkey,
    pub requested_at: i64,
}

#[event]
pub struct BondWithdrawn {
    pub provider: Pubkey,
    pub amount: u64,
    pub remaining_bond: u64,
}

use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};

pub const RECEIPT_VERSION: u8 = 1;
pub const RECEIPT_CANONICAL_LEN: usize = 217;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum DisputeStatus {
    Open,
    BuyerWins,
    ProviderWins,
    TimedOut,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Ruling {
    BuyerWins,
    ProviderWins,
}

#[account]
#[derive(Default, Debug)]
pub struct Config {
    pub arbiter: Pubkey,              // 32
    pub usdc_mint: Pubkey,            // 32
    pub dispute_window: i64,          // 8 (seconds)
    pub resolve_timeout: i64,         // 8 (seconds)
    pub withdraw_delay: i64,          // 8 (seconds)
    pub per_ruling_payout_cap: u64,   // 8
    pub vault_bump: u8,               // 1
    pub bump: u8,                     // 1
}

impl Config {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1;
}

#[account]
#[derive(Default, Debug)]
pub struct Provider {
    pub wallet: Pubkey,               // 32
    pub bond: u64,                    // 8
    pub locked: u64,                  // 8
    pub withdraw_requested_at: i64,   // 8
    pub bump: u8,                     // 1
}

impl Provider {
    pub const LEN: usize = 8 + 32 + 8 + 8 + 8 + 1;
}

#[account]
#[derive(Default, Debug)]
pub struct Dispute {
    pub receipt_hash: [u8; 32],       // 32
    pub buyer: Pubkey,                // 32
    pub provider: Pubkey,             // 32
    pub price: u64,                   // 8
    pub claim_amount: u64,            // 8
    pub status: DisputeStatus,        // 1
    pub opened_at: i64,               // 8
    pub evidence_hash: [u8; 32],      // 32
    pub ruling_hash: [u8; 32],        // 32
    pub bump: u8,                     // 1
}

impl Dispute {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 8 + 32 + 32 + 1;
}

impl Default for DisputeStatus {
    fn default() -> Self {
        DisputeStatus::Open
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub version: u8,
    pub provider: Pubkey,
    pub buyer: Pubkey,
    pub request_hash: [u8; 32],
    pub response_hash: [u8; 32],
    pub payment_reference: [u8; 64],
    pub price: u64,
    pub timestamp: i64,
    pub nonce: u64,
}

impl Receipt {
    pub fn to_canonical_bytes(&self) -> [u8; RECEIPT_CANONICAL_LEN] {
        let mut bytes = [0u8; RECEIPT_CANONICAL_LEN];
        bytes[0] = self.version;
        bytes[1..33].copy_from_slice(self.provider.as_ref());
        bytes[33..65].copy_from_slice(self.buyer.as_ref());
        bytes[65..97].copy_from_slice(&self.request_hash);
        bytes[97..129].copy_from_slice(&self.response_hash);
        bytes[129..193].copy_from_slice(&self.payment_reference);
        bytes[193..201].copy_from_slice(&self.price.to_le_bytes());
        bytes[201..209].copy_from_slice(&self.timestamp.to_le_bytes());
        bytes[209..217].copy_from_slice(&self.nonce.to_le_bytes());
        bytes
    }

    pub fn hash(&self) -> [u8; 32] {
        let canonical = self.to_canonical_bytes();
        let mut hasher = Sha256::new();
        hasher.update(&canonical);
        hasher.finalize().into()
    }
}

use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};

pub const RECEIPT_VERSION: u8 = 1;
pub const RECEIPT_CANONICAL_LEN: usize = 249;

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
    pub arbiter: Pubkey,                  // 32
    pub usdc_mint: Pubkey,                // 32
    pub dispute_window: i64,              // 8 (seconds)
    pub resolve_timeout: i64,             // 8 (seconds)
    pub withdraw_delay: i64,              // 8 (seconds)
    pub per_ruling_payout_cap: u64,       // 8
    pub dispute_deposit: u64,             // 8 (buyer deposit in token base units)
    pub max_open_disputes_per_buyer: u32, // 4 (cap per buyer per provider)
    pub vault_bump: u8,                   // 1
    pub bump: u8,                         // 1
}

impl Config {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 4 + 1 + 1; // 118
}

#[account]
#[derive(Default, Debug)]
pub struct Provider {
    pub wallet: Pubkey,               // 32
    pub bond: u64,                    // 8
    pub locked: u64,                  // 8
    pub withdraw_requested_at: i64,   // 8
    pub spec_hash: [u8; 32],          // 32 (immutable commitment to off-chain /spec)
    pub open_disputes: u64,           // 8
    pub disputes_buyer_won: u64,      // 8
    pub disputes_provider_won: u64,   // 8
    pub disputes_timed_out: u64,      // 8
    pub total_slashed: u64,           // 8
    pub bump: u8,                     // 1
}

impl Provider {
    pub const LEN: usize = 8 + 32 + 8 + 8 + 8 + 32 + 8 + 8 + 8 + 8 + 8 + 1; // 137
}

#[account]
#[derive(Default, Debug)]
pub struct BuyerRecord {
    pub open_disputes: u32,           // 4
    pub bump: u8,                     // 1
}

impl BuyerRecord {
    pub const LEN: usize = 8 + 4 + 1; // 13
}

#[account]
#[derive(Default, Debug)]
pub struct Dispute {
    pub receipt_hash: [u8; 32],       // 32
    pub buyer: Pubkey,                // 32
    pub provider: Pubkey,             // 32
    pub spec_hash: [u8; 32],          // 32
    pub price: u64,                   // 8
    pub claim_amount: u64,            // 8
    pub deposit_amount: u64,          // 8
    pub status: DisputeStatus,        // 1
    pub opened_at: i64,               // 8
    pub evidence_hash: [u8; 32],      // 32
    pub ruling_hash: [u8; 32],        // 32
    pub bump: u8,                     // 1
}

impl Dispute {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 1 + 8 + 32 + 32 + 1; // 242
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
    pub spec_hash: [u8; 32],
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
        bytes[65..97].copy_from_slice(&self.spec_hash);
        bytes[97..129].copy_from_slice(&self.request_hash);
        bytes[129..161].copy_from_slice(&self.response_hash);
        bytes[161..225].copy_from_slice(&self.payment_reference);
        bytes[225..233].copy_from_slice(&self.price.to_le_bytes());
        bytes[233..241].copy_from_slice(&self.timestamp.to_le_bytes());
        bytes[241..249].copy_from_slice(&self.nonce.to_le_bytes());
        bytes
    }

    pub fn hash(&self) -> [u8; 32] {
        let canonical = self.to_canonical_bytes();
        let mut hasher = Sha256::new();
        hasher.update(&canonical);
        hasher.finalize().into()
    }
}

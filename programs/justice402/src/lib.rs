use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

pub use errors::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("2kqYmJMLeSUQ9pgwpJuewNhjr4CMkw3dE9phTpFKNJoJ");

#[program]
pub mod justice402 {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        arbiter: Pubkey,
        dispute_window: i64,
        resolve_timeout: i64,
        withdraw_delay: i64,
        per_ruling_payout_cap: u64,
    ) -> Result<()> {
        handle_initialize(
            ctx,
            arbiter,
            dispute_window,
            resolve_timeout,
            withdraw_delay,
            per_ruling_payout_cap,
        )
    }

    pub fn register_provider(
        ctx: Context<RegisterProvider>,
        bond_amount: u64,
    ) -> Result<()> {
        handle_register_provider(ctx, bond_amount)
    }

    pub fn top_up(
        ctx: Context<TopUp>,
        amount: u64,
    ) -> Result<()> {
        handle_top_up(ctx, amount)
    }

    pub fn open_dispute(
        ctx: Context<OpenDispute>,
        receipt: Receipt,
        evidence_hash: [u8; 32],
    ) -> Result<()> {
        handle_open_dispute(ctx, receipt, evidence_hash)
    }

    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        ruling: Ruling,
        ruling_hash: [u8; 32],
    ) -> Result<()> {
        handle_resolve_dispute(ctx, ruling, ruling_hash)
    }

    pub fn claim_timeout(ctx: Context<ClaimTimeout>) -> Result<()> {
        handle_claim_timeout(ctx)
    }

    pub fn request_withdraw(ctx: Context<RequestWithdraw>) -> Result<()> {
        handle_request_withdraw(ctx)
    }

    pub fn withdraw_bond(
        ctx: Context<WithdrawBond>,
        amount: u64,
    ) -> Result<()> {
        handle_withdraw_bond(ctx, amount)
    }
}

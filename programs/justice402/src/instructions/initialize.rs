use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use crate::state::Config;
use crate::errors::JusticeError;

pub const MAX_DISPUTE_WINDOW: i64 = 365 * 24 * 60 * 60; // 1 year max
pub const MAX_RESOLVE_TIMEOUT: i64 = 30 * 24 * 60 * 60;  // 30 days max
pub const MAX_WITHDRAW_DELAY: i64 = 365 * 24 * 60 * 60;  // 1 year max
pub const MAX_OPEN_DISPUTES_CAP: u32 = 100;
pub const MAX_DISPUTE_DEPOSIT: u64 = 1_000_000_000; // 1000 USDC max deposit (6 decimals)

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = Config::LEN,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, Config>,

    /// CHECK: USDC SPL mint address
    pub usdc_mint: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        seeds = [b"vault", config.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = vault,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handle_initialize(
    ctx: Context<Initialize>,
    arbiter: Pubkey,
    dispute_window: i64,
    resolve_timeout: i64,
    withdraw_delay: i64,
    per_ruling_payout_cap: u64,
    dispute_deposit: u64,
    max_open_disputes_per_buyer: u32,
) -> Result<()> {
    require!(arbiter != Pubkey::default(), JusticeError::InvalidConfig);
    require!(dispute_window > 0 && dispute_window <= MAX_DISPUTE_WINDOW, JusticeError::InvalidConfig);
    require!(resolve_timeout > 0 && resolve_timeout <= MAX_RESOLVE_TIMEOUT, JusticeError::InvalidConfig);
    require!(withdraw_delay >= 0 && withdraw_delay <= MAX_WITHDRAW_DELAY, JusticeError::InvalidConfig);
    require!(per_ruling_payout_cap > 0, JusticeError::InvalidConfig);
    require!(dispute_deposit > 0 && dispute_deposit <= MAX_DISPUTE_DEPOSIT, JusticeError::InvalidConfig);
    require!(max_open_disputes_per_buyer > 0 && max_open_disputes_per_buyer <= MAX_OPEN_DISPUTES_CAP, JusticeError::InvalidConfig);

    let config = &mut ctx.accounts.config;
    config.arbiter = arbiter;
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.dispute_window = dispute_window;
    config.resolve_timeout = resolve_timeout;
    config.withdraw_delay = withdraw_delay;
    config.per_ruling_payout_cap = per_ruling_payout_cap;
    config.dispute_deposit = dispute_deposit;
    config.max_open_disputes_per_buyer = max_open_disputes_per_buyer;
    config.vault_bump = ctx.bumps.vault;
    config.bump = ctx.bumps.config;

    Ok(())
}

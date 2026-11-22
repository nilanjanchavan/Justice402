use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::state::Config;
use crate::errors::JusticeError;

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

    pub usdc_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        seeds = [b"vault", config.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = vault,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

pub const MAX_DISPUTE_WINDOW: i64 = 365 * 24 * 3600; // 1 year
pub const MAX_RESOLVE_TIMEOUT: i64 = 30 * 24 * 3600; // 30 days
pub const MAX_WITHDRAW_DELAY: i64 = 365 * 24 * 3600;  // 1 year

pub fn handle_initialize(
    ctx: Context<Initialize>,
    arbiter: Pubkey,
    dispute_window: i64,
    resolve_timeout: i64,
    withdraw_delay: i64,
    per_ruling_payout_cap: u64,
) -> Result<()> {
    require!(dispute_window > 0 && dispute_window <= MAX_DISPUTE_WINDOW, JusticeError::InvalidConfig);
    require!(resolve_timeout > 0 && resolve_timeout <= MAX_RESOLVE_TIMEOUT, JusticeError::InvalidConfig);
    require!(withdraw_delay > 0 && withdraw_delay <= MAX_WITHDRAW_DELAY, JusticeError::InvalidConfig);
    require!(per_ruling_payout_cap > 0, JusticeError::InvalidConfig);

    let config = &mut ctx.accounts.config;
    config.arbiter = arbiter;
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.dispute_window = dispute_window;
    config.resolve_timeout = resolve_timeout;
    config.withdraw_delay = withdraw_delay;
    config.per_ruling_payout_cap = per_ruling_payout_cap;
    config.vault_bump = ctx.bumps.vault;
    config.bump = ctx.bumps.config;

    Ok(())
}


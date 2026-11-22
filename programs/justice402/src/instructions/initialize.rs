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

pub fn handle_initialize(
    ctx: Context<Initialize>,
    arbiter: Pubkey,
    dispute_window: i64,
    resolve_timeout: i64,
    withdraw_delay: i64,
    per_ruling_payout_cap: u64,
) -> Result<()> {
    require!(dispute_window > 0, JusticeError::InvalidConfig);
    require!(resolve_timeout > 0, JusticeError::InvalidConfig);
    require!(withdraw_delay > 0, JusticeError::InvalidConfig);
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


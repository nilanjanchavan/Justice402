use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{Config, Provider};
use crate::events::BondWithdrawn;
use crate::errors::JusticeError;

#[derive(Accounts)]
pub struct WithdrawBond<'info> {
    pub provider_wallet: Signer<'info>,

    #[account(
        mut,
        seeds = [b"provider", provider_wallet.key().as_ref()],
        bump = provider.bump,
        constraint = provider.wallet == provider_wallet.key() @ JusticeError::WrongSigner,
    )]
    pub provider: Account<'info, Provider>,

    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"vault", config.key().as_ref()],
        bump = config.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = provider_wallet,
    )]
    pub provider_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_withdraw_bond(
    ctx: Context<WithdrawBond>,
    amount: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let provider = &mut ctx.accounts.provider;

    require!(provider.locked == 0, JusticeError::BondLocked);
    require!(provider.open_disputes == 0, JusticeError::ActiveDisputesPending);
    require!(provider.withdraw_requested_at > 0, JusticeError::WithdrawNotRequested);

    let unlock_time = provider.withdraw_requested_at
        .checked_add(ctx.accounts.config.withdraw_delay)
        .ok_or(JusticeError::MathOverflow)?;
    require!(clock.unix_timestamp >= unlock_time, JusticeError::WithdrawDelayNotElapsed);

    require!(amount <= provider.bond, JusticeError::InsufficientWithdrawBalance);
    require!(amount > 0, JusticeError::InvalidConfig);

    // Transfer bond from vault to provider token account
    let config_key = ctx.accounts.config.key();
    let vault_bump = ctx.accounts.config.vault_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"vault",
        config_key.as_ref(),
        &[vault_bump],
    ]];

    let cpi_accounts = Transfer {
        from: ctx.accounts.vault.to_account_info(),
        to: ctx.accounts.provider_token_account.to_account_info(),
        authority: ctx.accounts.vault.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        cpi_accounts,
        signer_seeds,
    );
    token::transfer(cpi_ctx, amount)?;

    provider.bond = provider.bond
        .checked_sub(amount)
        .ok_or(JusticeError::MathOverflow)?;

    if provider.bond == 0 {
        provider.withdraw_requested_at = 0;
    }

    emit!(BondWithdrawn {
        provider: provider.wallet,
        amount,
        remaining_bond: provider.bond,
    });

    Ok(())
}

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{Config, Provider};
use crate::events::BondToppedUp;
use crate::errors::JusticeError;

#[derive(Accounts)]
pub struct TopUp<'info> {
    #[account(mut)]
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

pub fn handle_top_up(
    ctx: Context<TopUp>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, JusticeError::InvalidConfig);

    let cpi_accounts = Transfer {
        from: ctx.accounts.provider_token_account.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.provider_wallet.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
    token::transfer(cpi_ctx, amount)?;

    let provider = &mut ctx.accounts.provider;
    provider.bond = provider.bond.checked_add(amount).ok_or(JusticeError::MathOverflow)?;

    emit!(BondToppedUp {
        provider: provider.wallet,
        amount,
        total_bond: provider.bond,
    });

    Ok(())
}

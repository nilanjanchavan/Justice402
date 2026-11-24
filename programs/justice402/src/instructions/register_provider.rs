use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{Config, Provider};
use crate::events::ProviderRegistered;

#[derive(Accounts)]
pub struct RegisterProvider<'info> {
    #[account(mut)]
    pub provider_wallet: Signer<'info>,

    #[account(
        init,
        payer = provider_wallet,
        space = Provider::LEN,
        seeds = [b"provider", provider_wallet.key().as_ref()],
        bump,
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
    pub system_program: Program<'info, System>,
}

pub fn handle_register_provider(
    ctx: Context<RegisterProvider>,
    bond_amount: u64,
    spec_hash: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let provider = &mut ctx.accounts.provider;
    provider.wallet = ctx.accounts.provider_wallet.key();
    provider.bond = 0;
    provider.locked = 0;
    provider.withdraw_requested_at = 0;
    provider.spec_hash = spec_hash;
    provider.open_disputes = 0;
    provider.disputes_buyer_won = 0;
    provider.disputes_provider_won = 0;
    provider.total_slashed = 0;
    provider.bump = ctx.bumps.provider;

    if bond_amount > 0 {
        let cpi_accounts = Transfer {
            from: ctx.accounts.provider_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.provider_wallet.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
        token::transfer(cpi_ctx, bond_amount)?;
        provider.bond = bond_amount;
    }

    emit!(ProviderRegistered {
        provider: provider.wallet,
        bond: provider.bond,
        spec_hash,
        registered_at: clock.unix_timestamp,
    });

    Ok(())
}

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{Config, Dispute, DisputeStatus, Provider, Ruling};
use crate::events::DisputeResolved;
use crate::errors::JusticeError;

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    pub arbiter: Signer<'info>,

    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"dispute", dispute.receipt_hash.as_ref()],
        bump = dispute.bump,
    )]
    pub dispute: Account<'info, Dispute>,

    #[account(
        mut,
        seeds = [b"provider", provider.wallet.as_ref()],
        bump = provider.bump,
    )]
    pub provider: Account<'info, Provider>,

    #[account(
        mut,
        seeds = [b"vault", config.key().as_ref()],
        bump = config.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = config.usdc_mint,
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_resolve_dispute(
    ctx: Context<ResolveDispute>,
    ruling: Ruling,
    ruling_hash: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;

    require_keys_eq!(ctx.accounts.arbiter.key(), ctx.accounts.config.arbiter, JusticeError::UnauthorizedArbiter);
    require!(ctx.accounts.dispute.status == DisputeStatus::Open, JusticeError::DisputeNotOpen);
    require_keys_eq!(ctx.accounts.dispute.provider, ctx.accounts.provider.wallet, JusticeError::WrongSigner);

    let timeout_deadline = ctx.accounts.dispute.opened_at
        .checked_add(ctx.accounts.config.resolve_timeout)
        .ok_or(JusticeError::MathOverflow)?;
    require!(clock.unix_timestamp < timeout_deadline, JusticeError::ResolveTimeoutElapsed);

    let dispute = &mut ctx.accounts.dispute;
    let provider = &mut ctx.accounts.provider;
    let claim_amount = dispute.claim_amount;
    let payout: u64;

    match ruling {
        Ruling::BuyerWins => {
            require_keys_eq!(
                ctx.accounts.buyer_token_account.owner,
                dispute.buyer,
                JusticeError::UnauthorizedBuyer
            );
            payout = claim_amount;

            // Transfer payout to buyer from vault
            let config_key = ctx.accounts.config.key();
            let vault_bump = ctx.accounts.config.vault_bump;
            let signer_seeds: &[&[&[u8]]] = &[&[
                b"vault",
                config_key.as_ref(),
                &[vault_bump],
            ]];

            let cpi_accounts = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.buyer_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                cpi_accounts,
                signer_seeds,
            );
            token::transfer(cpi_ctx, payout)?;

            provider.bond = provider.bond
                .checked_sub(payout)
                .ok_or(JusticeError::MathOverflow)?;
            provider.locked = provider.locked
                .checked_sub(claim_amount)
                .ok_or(JusticeError::MathOverflow)?;

            dispute.status = DisputeStatus::BuyerWins;
        }
        Ruling::ProviderWins => {
            payout = 0;

            provider.locked = provider.locked
                .checked_sub(claim_amount)
                .ok_or(JusticeError::MathOverflow)?;

            dispute.status = DisputeStatus::ProviderWins;
        }
    }

    dispute.ruling_hash = ruling_hash;

    emit!(DisputeResolved {
        receipt_hash: dispute.receipt_hash,
        buyer: dispute.buyer,
        provider: dispute.provider,
        status: dispute.status,
        ruling_hash,
        payout,
        resolved_at: clock.unix_timestamp,
    });

    Ok(())
}

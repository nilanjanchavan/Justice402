use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{BuyerRecord, Config, Dispute, DisputeStatus, Provider};
use crate::events::DisputeResolved;
use crate::errors::JusticeError;

#[derive(Accounts)]
pub struct ClaimTimeout<'info> {
    /// Permissionless caller: anyone (buyer, keeper, provider) can trigger timeout refund after deadline
    pub caller: Signer<'info>,

    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [b"dispute", dispute.receipt_hash.as_ref()],
        bump = dispute.bump,
    )]
    pub dispute: Box<Account<'info, Dispute>>,

    #[account(
        mut,
        seeds = [b"provider", provider.wallet.as_ref()],
        bump = provider.bump,
    )]
    pub provider: Box<Account<'info, Provider>>,

    #[account(
        mut,
        seeds = [b"buyer_record", provider.wallet.as_ref(), dispute.buyer.as_ref()],
        bump = buyer_record.bump,
    )]
    pub buyer_record: Box<Account<'info, BuyerRecord>>,

    #[account(
        mut,
        seeds = [b"vault", config.key().as_ref()],
        bump = config.vault_bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = dispute.buyer,
    )]
    pub buyer_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_claim_timeout(ctx: Context<ClaimTimeout>) -> Result<()> {
    let clock = Clock::get()?;

    require!(ctx.accounts.dispute.status == DisputeStatus::Open, JusticeError::DisputeNotOpen);
    require_keys_eq!(ctx.accounts.provider.wallet, ctx.accounts.dispute.provider, JusticeError::WrongSigner);

    let timeout_deadline = ctx.accounts.dispute.opened_at
        .checked_add(ctx.accounts.config.resolve_timeout)
        .ok_or(JusticeError::MathOverflow)?;
    require!(clock.unix_timestamp >= timeout_deadline, JusticeError::TimeoutNotReached);

    let dispute = &mut ctx.accounts.dispute;
    let provider = &mut ctx.accounts.provider;
    let buyer_record = &mut ctx.accounts.buyer_record;

    // Refund price (claim_amount) + returned deposit (no compensation)
    let payout = dispute.claim_amount
        .checked_add(dispute.deposit_amount)
        .ok_or(JusticeError::MathOverflow)?;

    provider.open_disputes = provider.open_disputes
        .checked_sub(1)
        .ok_or(JusticeError::MathOverflow)?;

    buyer_record.open_disputes = buyer_record.open_disputes
        .checked_sub(1)
        .ok_or(JusticeError::MathOverflow)?;

    // Transfer refund from vault to buyer
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
        .checked_sub(dispute.claim_amount)
        .ok_or(JusticeError::MathOverflow)?;
    provider.locked = provider.locked
        .checked_sub(dispute.claim_amount)
        .ok_or(JusticeError::MathOverflow)?;

    // Increment disputes_timed_out; do NOT increment disputes_buyer_won or total_slashed
    provider.disputes_timed_out = provider.disputes_timed_out
        .checked_add(1)
        .ok_or(JusticeError::MathOverflow)?;

    dispute.status = DisputeStatus::TimedOut;

    emit!(DisputeResolved {
        receipt_hash: dispute.receipt_hash,
        buyer: dispute.buyer,
        provider: dispute.provider,
        status: DisputeStatus::TimedOut,
        ruling_hash: [0u8; 32],
        payout,
        resolved_at: clock.unix_timestamp,
    });

    Ok(())
}

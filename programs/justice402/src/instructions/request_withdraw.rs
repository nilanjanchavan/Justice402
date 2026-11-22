use anchor_lang::prelude::*;
use crate::state::Provider;
use crate::events::WithdrawRequested;
use crate::errors::JusticeError;

#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
    pub provider_wallet: Signer<'info>,

    #[account(
        mut,
        seeds = [b"provider", provider_wallet.key().as_ref()],
        bump = provider.bump,
        constraint = provider.wallet == provider_wallet.key() @ JusticeError::WrongSigner,
    )]
    pub provider: Account<'info, Provider>,
}

pub fn handle_request_withdraw(ctx: Context<RequestWithdraw>) -> Result<()> {
    let clock = Clock::get()?;
    let provider = &mut ctx.accounts.provider;

    require!(provider.locked == 0, JusticeError::BondLocked);

    provider.withdraw_requested_at = clock.unix_timestamp;

    emit!(WithdrawRequested {
        provider: provider.wallet,
        requested_at: provider.withdraw_requested_at,
    });

    Ok(())
}

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use solana_instructions_sysvar::{
    load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_SYSVAR_ID,
};
use crate::state::{
    BuyerRecord, Config, Dispute, DisputeStatus, Provider, Receipt,
    RECEIPT_CANONICAL_LEN, RECEIPT_VERSION,
};
use crate::events::DisputeOpened;
use crate::errors::JusticeError;

pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
pub const MAX_PERMITTED_CLOCK_SKEW: i64 = 60; // 60 seconds permitted clock drift

#[derive(Accounts)]
#[instruction(receipt: Receipt, evidence_hash: [u8; 32])]
pub struct OpenDispute<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"provider", provider.wallet.as_ref()],
        bump = provider.bump,
    )]
    pub provider: Box<Account<'info, Provider>>,

    #[account(
        init_if_needed,
        payer = buyer,
        space = BuyerRecord::LEN,
        seeds = [b"buyer_record", provider.wallet.as_ref(), buyer.key().as_ref()],
        bump,
    )]
    pub buyer_record: Box<Account<'info, BuyerRecord>>,

    #[account(
        init,
        payer = buyer,
        space = Dispute::LEN,
        seeds = [b"dispute", receipt.hash().as_ref()],
        bump,
    )]
    pub dispute: Box<Account<'info, Dispute>>,

    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [b"vault", config.key().as_ref()],
        bump = config.vault_bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = buyer,
    )]
    pub buyer_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: Instructions sysvar account checked by address and loader
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_open_dispute(
    ctx: Context<OpenDispute>,
    receipt: Receipt,
    evidence_hash: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;

    // 1. Validate basic receipt structure
    require!(receipt.version == RECEIPT_VERSION, JusticeError::InvalidReceipt);
    require_keys_eq!(ctx.accounts.buyer.key(), receipt.buyer, JusticeError::UnauthorizedBuyer);
    require_keys_eq!(ctx.accounts.provider.wallet, receipt.provider, JusticeError::WrongSigner);
    require!(receipt.spec_hash == ctx.accounts.provider.spec_hash, JusticeError::SpecHashMismatch);

    // 2. Validate dispute window and reject future-dated receipts exceeding clock skew
    let max_future_time = clock.unix_timestamp
        .checked_add(MAX_PERMITTED_CLOCK_SKEW)
        .ok_or(JusticeError::MathOverflow)?;
    require!(receipt.timestamp <= max_future_time, JusticeError::InvalidReceipt);

    let expiry = receipt.timestamp
        .checked_add(ctx.accounts.config.dispute_window)
        .ok_or(JusticeError::MathOverflow)?;
    require!(clock.unix_timestamp <= expiry, JusticeError::WindowExpired);

    // Validate that opened_at + resolve_timeout produces a representable deadline
    clock.unix_timestamp
        .checked_add(ctx.accounts.config.resolve_timeout)
        .ok_or(JusticeError::MathOverflow)?;

    // 3. Enforce maximum open disputes cap per buyer per provider
    let buyer_record = &mut ctx.accounts.buyer_record;
    require!(
        buyer_record.open_disputes < ctx.accounts.config.max_open_disputes_per_buyer,
        JusticeError::TooManyOpenDisputes
    );

    // 4. Validate and introspect Ed25519 signature verification instruction
    let canonical_bytes = receipt.to_canonical_bytes();
    verify_ed25519_introspection(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &canonical_bytes,
        ctx.accounts.provider.wallet.as_ref(),
    )?;

    // 5. Transfer dispute deposit from buyer to program vault
    let deposit_amount = ctx.accounts.config.dispute_deposit;
    if deposit_amount > 0 {
        let cpi_accounts = Transfer {
            from: ctx.accounts.buyer_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.buyer.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
        token::transfer(cpi_ctx, deposit_amount)?;
    }

    // 6. Calculate claim amount and lock provider bond
    let claim_amount = std::cmp::min(receipt.price, ctx.accounts.config.per_ruling_payout_cap);
    let provider = &mut ctx.accounts.provider;
    let available_bond = provider.bond
        .checked_sub(provider.locked)
        .ok_or(JusticeError::MathOverflow)?;
    require!(available_bond >= claim_amount, JusticeError::InsufficientBond);

    provider.locked = provider.locked
        .checked_add(claim_amount)
        .ok_or(JusticeError::MathOverflow)?;

    provider.open_disputes = provider.open_disputes
        .checked_add(1)
        .ok_or(JusticeError::MathOverflow)?;

    buyer_record.open_disputes = buyer_record.open_disputes
        .checked_add(1)
        .ok_or(JusticeError::MathOverflow)?;
    buyer_record.bump = ctx.bumps.buyer_record;

    // 7. Initialize Dispute record
    let receipt_hash = receipt.hash();
    let dispute = &mut ctx.accounts.dispute;
    dispute.receipt_hash = receipt_hash;
    dispute.buyer = ctx.accounts.buyer.key();
    dispute.provider = provider.wallet;
    dispute.spec_hash = receipt.spec_hash;
    dispute.price = receipt.price;
    dispute.claim_amount = claim_amount;
    dispute.deposit_amount = deposit_amount;
    dispute.status = DisputeStatus::Open;
    dispute.opened_at = clock.unix_timestamp;
    dispute.evidence_hash = evidence_hash;
    dispute.ruling_hash = [0u8; 32];
    dispute.bump = ctx.bumps.dispute;

    emit!(DisputeOpened {
        receipt_hash,
        buyer: dispute.buyer,
        provider: dispute.provider,
        spec_hash: dispute.spec_hash,
        price: dispute.price,
        claim_amount: dispute.claim_amount,
        deposit_amount: dispute.deposit_amount,
        opened_at: dispute.opened_at,
    });

    Ok(())
}

fn verify_ed25519_introspection(
    instructions_sysvar: &AccountInfo,
    expected_message: &[u8; RECEIPT_CANONICAL_LEN],
    expected_signer: &[u8],
) -> Result<()> {
    let current_index = load_current_index_checked(instructions_sysvar)?;

    let mut last_error: Option<Error> = None;
    let mut verified = false;

    for idx in 0..current_index {
        let ix = match load_instruction_at_checked(idx as usize, instructions_sysvar) {
            Ok(ix) => ix,
            Err(_) => continue,
        };

        if ix.program_id == ED25519_PROGRAM_ID {
            match verify_single_ed25519_data(&ix.data, expected_message, expected_signer) {
                Ok(_) => {
                    verified = true;
                    break;
                }
                Err(err) => {
                    last_error = Some(err);
                }
            }
        }
    }

    if verified {
        return Ok(());
    }

    if let Some(err) = last_error {
        return Err(err);
    }

    err!(JusticeError::MissingEd25519Instruction)
}

fn verify_single_ed25519_data(
    data: &[u8],
    expected_message: &[u8],
    expected_signer: &[u8],
) -> Result<()> {
    require!(data.len() >= 16, JusticeError::InvalidEd25519Data);

    let num_signatures = data[0];
    require!(num_signatures == 1, JusticeError::InvalidEd25519Data);

    let sig_offset = u16::from_le_bytes([data[2], data[3]]) as usize;
    let sig_ix_idx = u16::from_le_bytes([data[4], data[5]]);

    let pubkey_offset = u16::from_le_bytes([data[6], data[7]]) as usize;
    let pubkey_ix_idx = u16::from_le_bytes([data[8], data[9]]);

    let msg_offset = u16::from_le_bytes([data[10], data[11]]) as usize;
    let msg_size = u16::from_le_bytes([data[12], data[13]]) as usize;
    let msg_ix_idx = u16::from_le_bytes([data[14], data[15]]);

    require!(sig_ix_idx == u16::MAX, JusticeError::InvalidEd25519Offset);
    require!(pubkey_ix_idx == u16::MAX, JusticeError::InvalidEd25519Offset);
    require!(msg_ix_idx == u16::MAX, JusticeError::InvalidEd25519Offset);

    let sig_end = sig_offset.checked_add(64).ok_or(JusticeError::InvalidEd25519Offset)?;
    require!(sig_end <= data.len(), JusticeError::InvalidEd25519Offset);

    let pubkey_end = pubkey_offset.checked_add(32).ok_or(JusticeError::InvalidEd25519Offset)?;
    require!(pubkey_end <= data.len(), JusticeError::InvalidEd25519Offset);

    let msg_end = msg_offset.checked_add(msg_size).ok_or(JusticeError::InvalidEd25519Offset)?;
    require!(msg_end <= data.len(), JusticeError::InvalidEd25519Offset);

    require!(msg_size == expected_message.len(), JusticeError::InvalidReceipt);

    let extracted_pubkey = &data[pubkey_offset..pubkey_end];
    require!(extracted_pubkey == expected_signer, JusticeError::WrongSigner);

    let extracted_msg = &data[msg_offset..msg_end];
    require!(extracted_msg == expected_message, JusticeError::WrongMessage);

    Ok(())
}

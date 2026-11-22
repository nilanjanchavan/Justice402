use anchor_lang::prelude::*;
use solana_instructions_sysvar::{
    load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_SYSVAR_ID,
};
use crate::state::{Config, Dispute, DisputeStatus, Provider, Receipt, RECEIPT_CANONICAL_LEN, RECEIPT_VERSION};
use crate::events::DisputeOpened;
use crate::errors::JusticeError;

pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

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
    pub provider: Account<'info, Provider>,

    #[account(
        init,
        payer = buyer,
        space = Dispute::LEN,
        seeds = [b"dispute", receipt.hash().as_ref()],
        bump,
    )]
    pub dispute: Account<'info, Dispute>,

    pub config: Account<'info, Config>,

    /// CHECK: Instructions sysvar account checked by address and loader
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

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

    // 2. Validate dispute window
    let expiry = receipt.timestamp
        .checked_add(ctx.accounts.config.dispute_window)
        .ok_or(JusticeError::MathOverflow)?;
    require!(clock.unix_timestamp <= expiry, JusticeError::WindowExpired);

    // 3. Validate and introspect Ed25519 signature verification instruction
    let canonical_bytes = receipt.to_canonical_bytes();
    verify_ed25519_introspection(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &canonical_bytes,
        ctx.accounts.provider.wallet.as_ref(),
    )?;

    // 4. Calculate claim amount and lock provider bond
    let claim_amount = std::cmp::min(receipt.price, ctx.accounts.config.per_ruling_payout_cap);
    let provider = &mut ctx.accounts.provider;
    let available_bond = provider.bond
        .checked_sub(provider.locked)
        .ok_or(JusticeError::MathOverflow)?;
    require!(available_bond >= claim_amount, JusticeError::InsufficientBond);

    provider.locked = provider.locked
        .checked_add(claim_amount)
        .ok_or(JusticeError::MathOverflow)?;

    // 5. Initialize Dispute record
    let receipt_hash = receipt.hash();
    let dispute = &mut ctx.accounts.dispute;
    dispute.receipt_hash = receipt_hash;
    dispute.buyer = ctx.accounts.buyer.key();
    dispute.provider = provider.wallet;
    dispute.price = receipt.price;
    dispute.claim_amount = claim_amount;
    dispute.status = DisputeStatus::Open;
    dispute.opened_at = clock.unix_timestamp;
    dispute.evidence_hash = evidence_hash;
    dispute.ruling_hash = [0u8; 32];
    dispute.bump = ctx.bumps.dispute;

    emit!(DisputeOpened {
        receipt_hash,
        buyer: dispute.buyer,
        provider: dispute.provider,
        price: dispute.price,
        claim_amount: dispute.claim_amount,
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

    let mut verified = false;
    for idx in 0..current_index {
        let ix = match load_instruction_at_checked(idx as usize, instructions_sysvar) {
            Ok(ix) => ix,
            Err(_) => continue,
        };

        if ix.program_id == ED25519_PROGRAM_ID {
            verify_single_ed25519_data(&ix.data, expected_message, expected_signer)?;
            verified = true;
            break;
        }
    }

    require!(verified, JusticeError::MissingEd25519Instruction);
    Ok(())
}

fn verify_single_ed25519_data(
    data: &[u8],
    expected_message: &[u8],
    expected_signer: &[u8],
) -> Result<()> {
    // Ed25519 instruction header is 16 bytes for 1 signature
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

    // Validate that offsets point strictly inside this instruction's own data (index == u16::MAX)
    require!(sig_ix_idx == u16::MAX, JusticeError::InvalidEd25519Offset);
    require!(pubkey_ix_idx == u16::MAX, JusticeError::InvalidEd25519Offset);
    require!(msg_ix_idx == u16::MAX, JusticeError::InvalidEd25519Offset);

    // Validate buffer boundaries
    let sig_end = sig_offset.checked_add(64).ok_or(JusticeError::InvalidEd25519Offset)?;
    require!(sig_end <= data.len(), JusticeError::InvalidEd25519Offset);

    let pubkey_end = pubkey_offset.checked_add(32).ok_or(JusticeError::InvalidEd25519Offset)?;
    require!(pubkey_end <= data.len(), JusticeError::InvalidEd25519Offset);

    let msg_end = msg_offset.checked_add(msg_size).ok_or(JusticeError::InvalidEd25519Offset)?;
    require!(msg_end <= data.len(), JusticeError::InvalidEd25519Offset);

    // Validate message length matches receipt canonical length
    require!(msg_size == expected_message.len(), JusticeError::InvalidReceipt);

    // Validate signer public key matches provider
    let extracted_pubkey = &data[pubkey_offset..pubkey_end];
    require!(extracted_pubkey == expected_signer, JusticeError::WrongSigner);

    // Validate message payload matches canonical receipt bytes
    let extracted_msg = &data[msg_offset..msg_end];
    require!(extracted_msg == expected_message, JusticeError::WrongMessage);

    Ok(())
}

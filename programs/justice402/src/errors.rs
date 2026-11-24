use anchor_lang::prelude::*;

#[error_code]
pub enum JusticeError {
    #[msg("Calculation overflowed")]
    MathOverflow,

    #[msg("Invalid configuration parameter")]
    InvalidConfig,

    #[msg("Dispute window has expired")]
    WindowExpired,

    #[msg("Only the buyer named in the receipt can open a dispute")]
    UnauthorizedBuyer,

    #[msg("Receipt signer does not match provider wallet")]
    WrongSigner,

    #[msg("Ed25519 signature verified message does not match canonical receipt")]
    WrongMessage,

    #[msg("Missing required Ed25519 signature verification instruction in transaction")]
    MissingEd25519Instruction,

    #[msg("Invalid Ed25519 instruction data layout or length")]
    InvalidEd25519Data,

    #[msg("Ed25519 instruction offset points outside instruction data")]
    InvalidEd25519Offset,

    #[msg("Receipt length or version invalid")]
    InvalidReceipt,

    #[msg("Insufficient bond available to open dispute")]
    InsufficientBond,

    #[msg("Caller is not the configured arbiter")]
    UnauthorizedArbiter,

    #[msg("Dispute is already resolved")]
    DisputeAlreadyResolved,

    #[msg("Dispute is not in Open status")]
    DisputeNotOpen,

    #[msg("Resolve timeout has not yet elapsed")]
    TimeoutNotReached,

    #[msg("Resolve timeout has elapsed; dispute can only be settled via claim_timeout")]
    ResolveTimeoutElapsed,

    #[msg("Cannot withdraw while funds are locked in active disputes")]
    BondLocked,

    #[msg("Cannot withdraw while disputes are open")]
    ActiveDisputesPending,

    #[msg("Receipt spec hash does not match provider registered spec hash")]
    SpecHashMismatch,

    #[msg("Withdraw delay has not elapsed since request")]
    WithdrawDelayNotElapsed,

    #[msg("Withdrawal has not been requested")]
    WithdrawNotRequested,

    #[msg("Requested amount exceeds available unreserved bond")]
    InsufficientWithdrawBalance,

    #[msg("Maximum open disputes per buyer exceeded for this provider")]
    TooManyOpenDisputes,
}

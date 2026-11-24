# Justice402: Smart Contract Code Walkthrough

This document provides a line-by-line architectural breakdown of the **Justice402** Solana Anchor program located in `programs/justice402`. It details account structures, validation constraints, arithmetic safety checks, potential failure modes, and direct mappings to our integration test suite (`tests/justice402.ts`).

---

## 1. On-Chain State Layout (`programs/justice402/src/state.rs`)

Justice402 manages five core account structures:

```
┌────────────────────────────────────────────────────────┐
│                   Config Account                       │
│ seeds = [b"config"]                                    │
│ - arbiter: Pubkey            - usdc_mint: Pubkey       │
│ - dispute_window: i64        - resolve_timeout: i64    │
│ - withdraw_delay: i64        - per_ruling_payout_cap: u64│
│ - dispute_deposit: u64       - max_open_disputes: u32  │
└────────────────────────────────────────────────────────┘
                           │
        ┌──────────────────┴──────────────────┐
        ▼                                     ▼
┌───────────────────────────────┐   ┌───────────────────────────────┐
│       Program Vault ATA       │   │        Provider Account       │
│ seeds = [b"vault", config]    │   │ seeds = [b"provider", wallet] │
│ - TokenAccount (USDC)         │   │ - bond: u64, locked: u64      │
│ - Authority: Vault PDA        │   │ - spec_hash: [u8; 32]         │
└───────────────────────────────┘   │ - track record counters       │
                                    └───────────────────────────────┘
                                                      │
                       ┌──────────────────────────────┴──────────────────────────────┐
                       ▼                                                             ▼
        ┌───────────────────────────────┐                             ┌───────────────────────────────┐
        │      BuyerRecord Account      │                             │        Dispute Account        │
        │ seeds = [b"buyer_record",     │                             │ seeds = [b"dispute",          │
        │          provider, buyer]     │                             │          receipt_hash]        │
        │ - open_disputes: u32          │                             │ - price, claim_amount, deposit│
        └───────────────────────────────┘                             │ - status, opened_at, evidence │
                                                                      └───────────────────────────────┘
```

### 1. `Config` (PDA: `[b"config"]`, Size: 118 bytes)
- Singleton system configuration initialized once by the deployer admin.
- `arbiter` (32 bytes): Dedicated public key authorized to resolve disputes.
- `usdc_mint` (32 bytes): Permitted SPL token mint for bonds and payouts.
- `dispute_window` (8 bytes): Maximum time in seconds after receipt timestamp during which a dispute may be opened.
- `resolve_timeout` (8 bytes): Window in seconds from `opened_at` allocated to the arbiter. After this, timeout refund is unlocked.
- `withdraw_delay` (8 bytes): Mandatory timelock between calling `request_withdraw` and executing `withdraw_bond`.
- `per_ruling_payout_cap` (8 bytes): Upper bound on bond payout per dispute.
- `dispute_deposit` (8 bytes): Deposit required from buyer to open a dispute (discourages griefing/spam).
- `max_open_disputes_per_buyer` (4 bytes): Limit on concurrent open disputes a single buyer can have against one provider.
- `vault_bump`, `bump` (2 bytes): Canonical PDA bumps.

### 2. `Provider` (PDA: `[b"provider", provider_wallet]`, Size: 137 bytes)
- Stored per provider identity.
- `wallet` (32 bytes): Provider signer public key.
- `bond` (8 bytes): Total staked USDC currently held in the vault.
- `locked` (8 bytes): Portions of the bond locked in active disputes (`bond - locked = available`).
- `withdraw_requested_at` (8 bytes): Timestamp when withdrawal countdown started (0 if no request active).
- `spec_hash` (32 bytes): SHA-256 hash of the off-chain immutable OpenAPI/JSON service specification (`/spec`).
- `open_disputes` (8 bytes): Total count of currently active disputes against this provider.
- `disputes_buyer_won` (8 bytes): Count of resolved disputes where buyer was refunded.
- `disputes_provider_won` (8 bytes): Count of resolved disputes where provider was exonerated.
- `disputes_timed_out` (8 bytes): Count of disputes resolved via permissionless timeout.
- `total_slashed` (8 bytes): Cumulative base units of USDC slashed from this provider's bond.
- `bump` (1 byte): Canonical PDA bump.

### 3. `BuyerRecord` (PDA: `[b"buyer_record", provider_wallet, buyer_wallet]`, Size: 13 bytes)
- Prevents sybil/concurrency attacks where a buyer tries to exhaust a provider's bond with concurrent false disputes.
- `open_disputes` (4 bytes): Active disputes by this buyer against this provider.
- `bump` (1 byte): Canonical PDA bump.

### 4. `Dispute` (PDA: `[b"dispute", receipt_hash]`, Size: 242 bytes)
- Created when a dispute is accepted on-chain.
- `receipt_hash` (32 bytes): SHA-256 digest of the 249-byte canonical receipt.
- `buyer` (32 bytes): Buyer wallet address.
- `provider` (32 bytes): Provider wallet address.
- `spec_hash` (32 bytes): Snapshot of provider's spec_hash at dispute opening.
- `price` (8 bytes): Cost paid for the API call from receipt.
- `claim_amount` (8 bytes): `min(price, per_ruling_payout_cap)`.
- `deposit_amount` (8 bytes): Dispute deposit transferred from buyer to vault.
- `status` (1 byte enum): `Open (0)`, `BuyerWins (1)`, `ProviderWins (2)`, `TimedOut (3)`.
- `opened_at` (8 bytes): Timestamp of dispute opening.
- `evidence_hash` (32 bytes): SHA-256 hash of the buyer's evidence bundle (request, response, violation proof).
- `ruling_hash` (32 bytes): SHA-256 hash of arbiter's audit justification.
- `bump` (1 byte): Canonical PDA bump.

---

## 2. Instruction Breakdown & Audits

### 2.1 `initialize` (`programs/justice402/src/instructions/initialize.rs`)
- **Purpose**: Creates the global `Config` account and the program `Vault` SPL Token Account.
- **Signers**: `admin` (pays rent and signs).
- **Accounts**:
  - `config`: `init, seeds = [b"config"], space = Config::LEN`
  - `usdc_mint`: Unchecked SPL mint account.
  - `vault`: `init, seeds = [b"vault", config.key().as_ref()], token::mint = usdc_mint, token::authority = vault`
- **Validation Constraints**:
  - `arbiter != Pubkey::default()` (prevents unroutable disputes).
  - `0 < dispute_window <= 365 days`.
  - `0 < resolve_timeout <= 30 days`.
  - `0 <= withdraw_delay <= 365 days`.
  - `per_ruling_payout_cap > 0`.
  - `0 < dispute_deposit <= 1,000 USDC`.
  - `0 < max_open_disputes_per_buyer <= 100`.
- **Test Coverage**: `tests/justice402.ts` Test 1 ("initializes global config and vault").

---

### 2.2 `register_provider` (`programs/justice402/src/instructions/register_provider.rs`)
- **Purpose**: Onboards a provider, commits to their service `spec_hash`, and deposits initial bond.
- **Signers**: `provider_wallet`.
- **Accounts**:
  - `provider`: `init, seeds = [b"provider", provider_wallet.key().as_ref()], space = Provider::LEN`.
  - `vault`: Program token vault.
  - `provider_token_account`: Provider's token account (`token::authority = provider_wallet`).
- **Validation Constraints**:
  - `require!(spec_hash != [0u8; 32], JusticeError::InvalidConfig)` (prevents uncommitted or empty specs).
  - All track record counters initialized to zero.
  - Initial bond transferred via CPI `token::transfer` if `bond_amount > 0`.
- **Emitted Events**: `ProviderRegistered`.
- **Test Coverage**: Test 2 ("registers a provider with bond and spec hash"), Test 2b ("rejects zero spec_hash").

---

### 2.3 `top_up` (`programs/justice402/src/instructions/top_up.rs`)
- **Purpose**: Adds additional bond funds to an existing provider account.
- **Signers**: `provider_wallet`.
- **Constraints**:
  - `provider.wallet == provider_wallet.key()`.
  - `amount > 0`.
  - `checked_add` math safety.
  - **Security Rule**: If `withdraw_requested_at > 0`, it resets to `0`. A provider cannot initiate a withdrawal, top up more funds, and immediately withdraw them without restarting the delay timer.
- **Emitted Events**: `BondToppedUp`.
- **Test Coverage**: Test 3 ("provider can top up bond").

---

### 2.4 `open_dispute` (`programs/justice402/src/instructions/open_dispute.rs`)
- **Purpose**: Verifies receipt signature and validity, locks bond collateral, collects buyer deposit, and opens dispute.
- **Signers**: `buyer`.
- **Accounts**:
  - `buyer`: Signer and payer.
  - `provider`: Mutable PDA `[b"provider", provider.wallet]`.
  - `buyer_record`: `init_if_needed, seeds = [b"buyer_record", provider.wallet, buyer]`.
  - `dispute`: `init, seeds = [b"dispute", receipt.hash()]`.
  - `config`: Program config.
  - `vault`: Program vault.
  - `buyer_token_account`: Buyer's USDC token account (`token::authority = buyer`).
  - `instructions_sysvar`: Solana Instructions Sysvar (`address = sysvar::instructions::ID`).
- **Validation Logic**:
  1. **Receipt Integrity**:
     - `receipt.version == RECEIPT_VERSION (1)`.
     - `receipt.buyer == buyer.key()`.
     - `receipt.provider == provider.wallet`.
     - `receipt.spec_hash == provider.spec_hash` (enforces exact spec binding).
  2. **Timestamp & Window**:
     - Future timestamp bound: `receipt.timestamp <= clock.unix_timestamp + 60s` (bounds clock drift).
     - Expiry check: `clock.unix_timestamp <= receipt.timestamp + dispute_window`.
     - Math overflow check: verifies `opened_at + resolve_timeout` is representable.
  3. **Anti-Griefing Limit**:
     - `buyer_record.open_disputes < config.max_open_disputes_per_buyer`.
  4. **Ed25519 Introspection**:
     - Calls `verify_ed25519_introspection`.
     - Scans transaction instructions preceding this instruction via `instructions_sysvar`.
     - Verifies program ID is `Ed25519SigVerify111111111111111111111111111`.
     - Verifies data length, single signature layout (`num_signatures == 1`), instruction offsets (`0xFFFF` self-contained data).
     - Verifies message matches canonical 249-byte receipt bytes.
     - Verifies public key matches `provider.wallet`.
  5. **Deposit Collection**:
     - Transfers `config.dispute_deposit` from `buyer_token_account` to `vault` via CPI.
  6. **Bond Reservation**:
     - `claim_amount = min(receipt.price, config.per_ruling_payout_cap)`.
     - Verifies `provider.bond - provider.locked >= claim_amount`.
     - `provider.locked += claim_amount`.
     - `provider.open_disputes += 1`.
     - `buyer_record.open_disputes += 1`.
  7. **Dispute Account Storage**: Stores metadata, sets `status = DisputeStatus::Open`.
- **Emitted Events**: `DisputeOpened`.
- **Test Coverage**:
  - Test 4: Successfully opens dispute.
  - Test 5: Rejects unauthorized buyer.
  - Test 6: Rejects wrong signer/provider.
  - Test 7: Rejects modified receipt message bytes.
  - Test 8: Rejects missing Ed25519 instruction.
  - Test 9: Rejects malformed Ed25519 instruction offsets.
  - Test 10: Rejects invalid receipt length/version.
  - Test 11: Rejects expired dispute window.
  - Test 12: Rejects receipt dated too far into future (>60s).
  - Test 13: Rejects dispute when provider has insufficient bond.
  - Test 22: Rejects spec_hash mismatch.
  - Test 24: Enforces max open disputes cap per buyer.

---

### 2.5 `resolve_dispute` (`programs/justice402/src/instructions/resolve_dispute.rs`)
- **Purpose**: Arbiter renders a definitive ruling (`BuyerWins` or `ProviderWins`).
- **Signers**: `arbiter` (`arbiter.key() == config.arbiter`).
- **Accounts**:
  - `dispute`: Mutable dispute account.
  - `provider`: Mutable provider account.
  - `buyer_record`: Mutable buyer record account.
  - `vault`: Program token vault.
  - `buyer_token_account`: Buyer's USDC token account (`owner == dispute.buyer`).
- **Validation Constraints**:
  - `dispute.status == DisputeStatus::Open`.
  - `dispute.provider == provider.wallet`.
  - Timeliness check: `clock.unix_timestamp < dispute.opened_at + config.resolve_timeout`. If the timeout has expired, the arbiter cannot unilaterally resolve; settlement must occur via `claim_timeout`.
- **Settlement Logic**:
  - Decrements `provider.open_disputes` and `buyer_record.open_disputes`.
  - **`Ruling::BuyerWins`**:
    - Buyer receives refund: `payout = claim_amount + deposit_amount`.
    - Vault transfers `payout` to `buyer_token_account` using PDA signer seeds `[b"vault", config.key()]`.
    - `provider.bond -= claim_amount`.
    - `provider.locked -= claim_amount`.
    - `provider.disputes_buyer_won += 1`.
    - `provider.total_slashed += claim_amount`.
    - `dispute.status = DisputeStatus::BuyerWins`.
  - **`Ruling::ProviderWins`**:
    - No payout transferred; buyer deposit is forfeited (retained in vault, unlocking provider bond).
    - `provider.locked -= claim_amount`.
    - `provider.disputes_provider_won += 1`.
    - `dispute.status = DisputeStatus::ProviderWins`.
- **Emitted Events**: `DisputeResolved`.
- **Test Coverage**:
  - Test 14: Arbiter resolves with `BuyerWins` (refund paid, bond slashed, counters updated).
  - Test 15: Arbiter resolves with `ProviderWins` (deposit forfeited, locked released).
  - Test 16: Rejects non-arbiter unauthorized caller.
  - Test 21: Rejects double resolution of already-settled dispute.

---

### 2.6 `claim_timeout` (`programs/justice402/src/instructions/claim_timeout.rs`)
- **Purpose**: Permissionless timeout settlement if arbiter is unresponsive after `resolve_timeout`.
- **Signers**: `caller` (anyone—buyer, provider, or keeper bot).
- **Accounts**:
  - `caller`: Signer.
  - `buyer_token_account`: Buyer's token account (`token::authority = dispute.buyer`).
  - `dispute`, `provider`, `buyer_record`, `vault`, `config`.
- **Validation Constraints**:
  - `dispute.status == DisputeStatus::Open`.
  - `dispute.provider == provider.wallet`.
  - `clock.unix_timestamp >= dispute.opened_at + config.resolve_timeout`.
- **Settlement Logic**:
  - `payout = claim_amount + deposit_amount`.
  - Transferred to `buyer_token_account` via vault PDA signer.
  - `provider.locked -= claim_amount` (bond is NOT slashed; provider bond was reserved for buyer refund, but provider does not suffer additional punitive slashing because arbiter failed to rule).
  - `provider.open_disputes -= 1`.
  - `buyer_record.open_disputes -= 1`.
  - `provider.disputes_timed_out += 1`.
  - `dispute.status = DisputeStatus::TimedOut`.
- **Emitted Events**: `DisputeResolved`.
- **Test Coverage**:
  - Test 17: Buyer triggers timeout refund after deadline.
  - Test 17b: Permissionless third party triggers timeout refund.
  - Test 23: Rejects premature timeout claim before deadline.

---

### 2.7 `request_withdraw` (`programs/justice402/src/instructions/request_withdraw.rs`)
- **Purpose**: Initiates timelock delay for withdrawing staked bond.
- **Signers**: `provider_wallet`.
- **Validation Constraints**:
  - `provider.wallet == provider_wallet.key()`.
  - `provider.locked == 0` (no bond locked in disputes).
  - `provider.open_disputes == 0` (no disputes pending resolution).
- **State Change**: `provider.withdraw_requested_at = clock.unix_timestamp`.
- **Emitted Events**: `WithdrawRequested`.
- **Test Coverage**:
  - Test 18: Rejects request if bond is locked in dispute.
  - Test 18b: Rejects request if `open_disputes > 0` even with 0 locked amount.

---

### 2.8 `withdraw_bond` (`programs/justice402/src/instructions/withdraw_bond.rs`)
- **Purpose**: Completes withdrawal of unlocked bond to provider's wallet after delay.
- **Signers**: `provider_wallet`.
- **Validation Constraints**:
  - `provider.locked == 0` and `provider.open_disputes == 0`.
  - `provider.withdraw_requested_at > 0` (withdrawal was requested).
  - Timelock check: `clock.unix_timestamp >= provider.withdraw_requested_at + config.withdraw_delay`.
  - `0 < amount <= provider.bond`.
- **Execution**:
  - Transfers `amount` from vault to `provider_token_account` via vault PDA signer.
  - `provider.bond -= amount`.
  - If `provider.bond == 0`, clears `withdraw_requested_at = 0`.
- **Emitted Events**: `BondWithdrawn`.
- **Test Coverage**:
  - Test 19: Rejects withdrawal before timelock delay has elapsed.
  - Test 20: Successfully withdraws bond after timelock.

---

## 3. Test Coverage Matrix

| Test ID | Test Description | Targeted Instruction | Verified Constraint |
|---|---|---|---|
| 1 | Config & Vault initialization | `initialize` | Canonical PDAs, parameter ranges |
| 2 | Provider registration | `register_provider` | Spec hash commitment, bond deposit CPI |
| 2b | Reject zero spec_hash | `register_provider` | `spec_hash != [0u8; 32]` |
| 3 | Bond top-up | `top_up` | Balance math, withdraw request reset |
| 4 | Open valid dispute | `open_dispute` | Ed25519 verify, bond lock, deposit CPI |
| 5 | Unauthorized buyer | `open_dispute` | `buyer.key() == receipt.buyer` |
| 6 | Wrong signer / provider | `open_dispute` | `provider.wallet == receipt.provider` |
| 7 | Modified message bytes | `open_dispute` | Ed25519 canonical message match |
| 8 | Missing Ed25519 ix | `open_dispute` | Introspection detects missing pre-instruction |
| 9 | Malformed offsets | `open_dispute` | Introspection bounds checking |
| 10 | Invalid version / length | `open_dispute` | `receipt.version == 1` & 249-byte length |
| 11 | Expired dispute window | `open_dispute` | `clock <= timestamp + dispute_window` |
| 12 | Future-dated receipt | `open_dispute` | Max clock drift skew (+60s) |
| 13 | Insufficient bond | `open_dispute` | `provider.bond - provider.locked >= claim` |
| 14 | Arbiter BuyerWins | `resolve_dispute` | Refund CPI, bond slash, track record +1 |
| 15 | Arbiter ProviderWins | `resolve_dispute` | Forfeit deposit, unlock bond, track record +1 |
| 16 | Unauthorized arbiter | `resolve_dispute` | `arbiter == config.arbiter` |
| 17 | Buyer claim timeout | `claim_timeout` | Timed out refund, bond unlocked |
| 17b | Permissionless timeout | `claim_timeout` | Independent keeper signer can settle |
| 18 | Withdraw blocked by lock | `request_withdraw` | `provider.locked == 0` |
| 18b | Withdraw blocked by count| `request_withdraw` | `provider.open_disputes == 0` |
| 19 | Premature withdraw | `withdraw_bond` | Timelock delay enforcement |
| 20 | Successful withdraw | `withdraw_bond` | Vault CPI payout to provider |
| 21 | Double resolution block | `resolve_dispute` | `dispute.status == DisputeStatus::Open` |
| 22 | Spec hash mismatch | `open_dispute` | `receipt.spec_hash == provider.spec_hash` |
| 23 | Premature timeout claim | `claim_timeout` | `now >= opened_at + resolve_timeout` |
| 24 | Max open disputes cap | `open_dispute` | `buyer_record.open_disputes < cap` |

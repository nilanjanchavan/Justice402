# Justice402: Live Devnet Demo Execution Proof

This document provides a verifiable execution log of the Justice402 protocol running against **Solana Devnet**. Technical reviewers can verify each on-chain transaction directly on Solana Explorer without running a local validator or signing transactions.

- **Cluster**: `Solana Devnet`
- **Program ID**: [`2kqYmJMLeSUQ9pgwpJuewNhjr4CMkw3dE9phTpFKNJoJ`](https://explorer.solana.com/address/2kqYmJMLeSUQ9pgwpJuewNhjr4CMkw3dE9phTpFKNJoJ?cluster=devnet)
- **Buyer Wallet**: `FsCLHjhVcrkuhw3K4KUrLNY6T3fuwTu415AnkdGkcJZH`
- **Provider (Lying)**: `7xEEM6fkvmS4p3B8Erxw6o1ynuCQLbXBGDaZiAtGveAv`
- **Dispute PDA**: `8vKYbW2QoAueFkPnYqSj59ZxC3VLW3DU4K7DBExjf98M`

---

## Step-by-Step Execution Record

### Step 1: Pre-Flight Trust Verification
- **Status**: `SUCCESS`
- **Action**: Buyer agent reads the provider's on-chain trust account (`Provider` PDA) before spending funds.
- **On-Chain State**:
  - `bond`: 100,000,000 base units (100 USDC)
  - `locked`: 0 USDC
  - `disputes_buyer_won`: 0
  - `spec_hash`: `098199b45785055b4bca45873a1112423c8a9f4c39f09e25d61486bc9e81b67f`
- **Buyer Decision**: Bond is sufficient, loss rate is 0%, service spec is valid. Spending approved.

---

### Step 2: Honest Service Purchase (Real x402 Payment)
- **Status**: `SUCCESS`
- **Action**: Real HTTP request to honest endpoint using x402 SVM payment facilitator.
- **Price Paid**: 0.05 USDC (instant settlement).
- **Response**:
  ```json
  {
    "city": "SolanaBeach",
    "temperature": 24.5,
    "humidity": 55,
    "observedAt": 1795523999
  }
  ```
- **Receipt Verification**: Valid Ed25519 signature from provider wallet; data complies with registered schema and numeric ranges. No dispute needed.

---

### Step 3: Malicious Response & On-Chain Dispute Opening
- **Status**: `SUCCESS`
- **Action**: Real HTTP request to lying endpoint using x402 payment.
- **Provider Response**:
  ```json
  {
    "city": "SolanaBeach",
    "temperature": 9999,
    "humidity": -50,
    "observedAt": 1795523999
  }
  ```
- **Off-Chain Audit**: Buyer detects `temperature: 9999` exceeds allowed maximum of `60°C`.
- **On-Chain Transaction**: `open_dispute` accompanied by `Ed25519SigVerify` instruction sysvar introspection.
- **Transaction Signature**: [`4qu7KSYr9ZzGhmZnUBj96SMe2sUGVdSWeZsPCp8okZuT8gotfL3vYH1qXKodRVhuwzgbCk5As7aDAzfDK6N4dh6N`](https://explorer.solana.com/tx/4qu7KSYr9ZzGhmZnUBj96SMe2sUGVdSWeZsPCp8okZuT8gotfL3vYH1qXKodRVhuwzgbCk5As7aDAzfDK6N4dh6N?cluster=devnet)
- **State Changes**:
  - 5 USDC claim locked from provider bond (`provider.locked = 5,000,000`).
  - 1 USDC buyer deposit transferred into program vault.
  - `provider.open_disputes` incremented to 1.
  - `Dispute` PDA created in `Open` status.

---

### Step 4: Human Arbiter Resolution on Devnet
- **Status**: `SUCCESS`
- **Action**: Dedicated arbiter wallet runs `npm run arbiter -- --dispute 8vKYbW2QoAueFkPnYqSj59ZxC3VLW3DU4K7DBExjf98M`.
- **Off-Chain Verification**: Arbiter CLI asserts `sha256(provider.spec) == spec_hash`, executes JSON schema validator, confirms range breach.
- **On-Chain Transaction**: `resolve_dispute` with `Ruling::BuyerWins`.
- **Transaction Signature**: [`3wVZMr2gDT4goWYsvL2pzzdzDXE2eBmuDbns7KsvwvMdFFQ5Hh1MVYLrK6VLBdbxBzXGVXKffL57rK6E6FhqoY7c`](https://explorer.solana.com/tx/3wVZMr2gDT4goWYsvL2pzzdzDXE2eBmuDbns7KsvwvMdFFQ5Hh1MVYLrK6VLBdbxBzXGVXKffL57rK6E6FhqoY7c?cluster=devnet)

---

### Step 5: Refund Settlement & Provider Slashed
- **Status**: `SUCCESS`
- **Outcome**:
  - **Buyer Payout**: 6 USDC (5 USDC purchase refund + 1 USDC deposit returned) transferred directly from Vault PDA to buyer's ATA.
  - **Provider Bond**: Slashed by 5 USDC (`remaining_bond: 95 USDC`).
  - **Track Record Updated**:
    - `disputes_buyer_won`: `1`
    - `total_slashed`: `5,000,000 units`
    - `open_disputes`: `0`
    - `locked`: `0`
- **Future Buyer Impact**: Any buyer agent evaluating this provider will see their 100% loss rate and automatically refuse purchases.

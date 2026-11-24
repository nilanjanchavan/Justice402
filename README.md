# Justice402: Insurance for x402 Payments on Solana

Justice402 is an on-chain insurance layer for HTTP [x402](https://x402.org) payment-required API services on Solana.

---

## 1. Product Definition & Architecture

**Justice402 is insurance for x402 payments, not escrow.**

Payments settle normally and instantly over x402 with no custom scheme, mediator, or custodial escrow holding buyer funds during the request. 

- **Instant Settlement**: Buyers pay providers directly via standard x402 V2 payment flows (using USDC or SPL tokens on Solana).
- **Bonded Staking**: Providers stake an on-chain insurance bond in the Justice402 Solana program and commit to a verifiable service specification (`spec_hash`).
- **Provider-Signed Receipts**: Every HTTP response carries an Ed25519 signature over a canonical, 249-byte serialized receipt linking the buyer, provider, query parameters, response hash, service spec hash, timestamp, and nonce.
- **Dispute Window**: If a response violates the specification (corrupted data, out-of-bounds metrics, schema failure, or staleness), the buyer can open an on-chain dispute within a configurable window (e.g. 60 seconds).
- **Arbiter Ruling & Slashed Bond**: When an arbiter rules in favor of the buyer, the buyer is refunded directly out of the provider's bonded stake, and the provider's on-chain track record is updated with slashed metrics.
- **Arbiter Order**: A **HUMAN arbiter wallet** acts first as the deterministic authoritative judge. In Phase 3, an **AI arbiter** is introduced to automate evaluations, with the human arbiter retained as the trusted fallback.

### Trust Assumptions
> [!IMPORTANT]
> - **The Arbiter is a Trusted Party**: The arbiter has authority to resolve disputes (`BuyerWins` or `ProviderWins`).
> - **Arbiter Liveness is a Trust Assumption**: If the arbiter becomes unresponsive, the dispute enters a timeout state. Once the timeout elapses, the buyer can claim a full refund permissionlessly via `claim_timeout`.

---

## 2. Timeout & Deposit Policy

To prevent denial-of-service and griefing attacks against bonded providers:

1. **Dispute Deposit**:
   - Buyers pay a small configurable dispute deposit (default: 1 USDC) upon calling `open_dispute`.
   - **Buyer Wins**: The deposit is returned to the buyer along with the refund (`claim_amount + deposit_amount`).
   - **Timeout**: The deposit is returned to the buyer along with the refund (`claim_amount + deposit_amount`).
   - **Provider Wins**: The deposit is forfeited to the provider and added to `provider.bond`.

2. **Timeout Counter & Policy**:
   - `claim_timeout` refunds the buyer's query price and deposit without punitive damages or compensation.
   - `claim_timeout` increments `disputes_timed_out`. It does **NOT** increment `disputes_buyer_won` or `total_slashed` on the provider's track record.

3. **Open Dispute Cap**:
   - Open disputes per buyer per provider are capped on-chain (configurable, default: 3) tracked in a `BuyerRecord` PDA (`[b"buyer_record", provider_wallet, buyer]`).
   - Opening an active dispute beyond the cap is rejected with `TooManyOpenDisputes`.

4. **Permissionless Settlement**:
   - Anyone (buyer, provider, or third-party keeper/caller) can call `claim_timeout` after the deadline has elapsed. The caller does not need to be the buyer, but the payout destination is strictly constrained to the buyer's token account.

---

## 3. Account Layout & Safe Upgrade Path

The Justice402 Anchor program stores state in PDA accounts:
- `Config`: Program parameters (arbiter, dispute window, timeout, payout cap, dispute deposit, max open disputes).
- `Provider`: Provider stake bond, locked funds, `spec_hash`, and dispute track record counters (`open_disputes`, `disputes_buyer_won`, `disputes_provider_won`, `disputes_timed_out`, `total_slashed`).
- `BuyerRecord`: Per-buyer-per-provider active dispute count (`open_disputes`).
- `Dispute`: On-chain dispute state, claim amount, deposit amount, and ruling details.

### Upgrade Path
- For the MVP and hackathon deployment, changes to account layouts (such as adding `spec_hash`, counters, or `BuyerRecord` PDA) require redeployment to a fresh Program ID.
- In a production mainnet upgrade, zero-copy versioned account discriminators or an explicit migration instruction invoking Solana's `realloc` account resizing CPI would be used to migrate existing account data in-place without breaking deserialization.

---

## 4. Stack Architecture & `@solana/kit` Isolation

`@x402/svm@2.32.0` mandates `@solana/kit: >=8.0.0` as a peer dependency. `@solana/kit` v8 is the modular, web-standard Solana SDK. 

Because `@x402/svm` requires `@solana/kit` v8 APIs, while Anchor 1.x / 1.2.x client tooling uses legacy `@solana/web3.js` v1 (`Keypair`, `PublicKey`, `Transaction`), having both SDKs in the same package leads to type conflicts. 

Justice402 isolates `@x402/svm` inside `packages/x402-svm`. It communicates with the rest of the monorepo exclusively via standard JSON and primitive `Uint8Array` byte arrays, maintaining complete SDK isolation.

---

## 5. Testing & Verification

### Run Full Test Suite (Receipt, Program, and E2E)
```bash
anchor test --validator legacy --skip-build
```

### Run Verifier Unit Tests
```bash
npx mocha -r ts-node/register tests/verifier.spec.ts
```

### Real x402 Devnet Payment Test
```bash
npm run x402:devnet
```
This script executes a real x402 V2 payment request against Solana devnet via `ExactSvmScheme` (`@x402/svm`). It prints HTTP status codes, challenges, and inspects the `PAYMENT-RESPONSE` settlement header.

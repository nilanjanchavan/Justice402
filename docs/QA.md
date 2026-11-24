# Justice402: Technical Q&A & Reviewer Deep-Dive

This document compiles 20 deep technical questions, architectural rationales, security threat models, and code-verified explanations designed for technical reviewers and interviewers.

---

### Q1: Why did you choose post-payment insurance rather than escrow?
**A**: HTTP [x402](https://x402.org) was designed for machine-to-machine micropayments where latency and simplicity are paramount. Escrow breaks this model:
1. **Latency**: Escrow requires at least two on-chain transactions (deposit lock + release/settlement), adding 2–6 seconds of latency to every HTTP response.
2. **Failure Modes**: If a buyer or escrow facilitator stalls, the provider's funds remain indefinitely trapped in escrow.
3. **Optimistic Settlement**: In real-world commerce, 99%+ of API transactions are honest. Justice402 allows payments to settle instantly over vanilla x402 with zero modifications to the HTTP transport. Only anomalous or malicious responses trigger the on-chain dispute flow.

---

### Q2: How does the on-chain program verify that the provider actually signed the receipt?
**A**: Through native **Ed25519 Instruction Introspection** ([`open_dispute.rs#L107-L216`](file:///home/nikku/Documents/web3/NewProj/programs/justice402/src/instructions/open_dispute.rs#L107-L216)).
Solana contains a native `Ed25519SigVerify111111111111111111111111111` precompile program. When opening a dispute, the client packages an Ed25519 signature verification instruction immediately preceding the `open_dispute` instruction. The Anchor program reads the `sysvar::instructions` account, locates the preceding Ed25519 instruction, inspects its layout, offsets, and extracted data, and cryptographically proves that:
1. The signature verified over the exact 249 canonical receipt bytes.
2. The signer matches `provider.wallet`.
3. The instruction was successfully processed in the current transaction block.

---

### Q3: What prevents an attacker from replay-attacking an Ed25519 signature?
**A**: Multiple defenses:
1. **Unique Dispute PDA Seeds**: Dispute accounts are derived using seeds `[b"dispute", receipt.hash()]` ([`open_dispute.rs#L42`](file:///home/nikku/Documents/web3/NewProj/programs/justice402/src/instructions/open_dispute.rs#L42)). Once a receipt has been used to open a dispute, re-submitting the same receipt fails at account initialization (`init` rejects already-initialized accounts).
2. **Provider Nonce and Payment Reference**: The receipt contains an 8-byte monotonic `nonce` and a 32-byte `payment_reference` (e.g. the transaction signature of the x402 payment), guaranteeing uniqueness across queries.
3. **Dispute Window**: Even if a provider reuses a nonce across different buyers, disputes must be opened within `dispute_window` (e.g. 24 hours), after which receipts expire permanently.

---

### Q4: How is clock drift handled between the provider's off-chain server, the buyer agent, and the Solana validator?
**A**: Through bounded clock skew tolerance ([`open_dispute.rs#L14-L89`](file:///home/nikku/Documents/web3/NewProj/programs/justice402/src/instructions/open_dispute.rs#L14-L89)):
```rust
pub const MAX_PERMITTED_CLOCK_SKEW: i64 = 60; // 60 seconds
let max_future_time = clock.unix_timestamp.checked_add(MAX_PERMITTED_CLOCK_SKEW)?;
require!(receipt.timestamp <= max_future_time, JusticeError::InvalidReceipt);
```
Solana cluster time (`Clock::get()?.unix_timestamp`) can drift by several tens of seconds relative to wall-clock time. We permit receipts with a timestamp up to 60 seconds into the future relative to the cluster clock. Any receipt dated further into the future is immediately rejected to prevent providers from minting artificially delayed or unchallengeable receipts.

---

### Q5: What stops a malicious buyer from spamming disputes to lock up all of a provider's bond?
**A**: Two strict economic and state-level controls:
1. **Dispute Deposit**: Opening a dispute requires the buyer to deposit USDC into the program vault (`config.dispute_deposit`, e.g. 1 USDC). If the arbiter determines the provider was honest and the claim was frivolous, the buyer **forfeits their entire deposit** to the vault ([`resolve_dispute.rs#L107-L118`](file:///home/nikku/Documents/web3/NewProj/programs/justice402/src/instructions/resolve_dispute.rs#L107-L118)).
2. **Per-Buyer Concurrency Cap**: We maintain an on-chain `BuyerRecord` PDA (`[b"buyer_record", provider, buyer]`). The program enforces `buyer_record.open_disputes < config.max_open_disputes_per_buyer` ([`open_dispute.rs#L100-L105`](file:///home/nikku/Documents/web3/NewProj/programs/justice402/src/instructions/open_dispute.rs#L100-L105)). A single malicious wallet cannot lock more than 3 simultaneous disputes against a provider.

---

### Q6: What happens if the arbiter disappears, goes rogue, or is unresponsive?
**A**: The protocol has a built-in **Permissionless Timeout Settlement** ([`claim_timeout.rs#L52-L105`](file:///home/nikku/Documents/web3/NewProj/programs/justice402/src/instructions/claim_timeout.rs#L52-L105)).
If `resolve_timeout` (e.g. 3 minutes on devnet, 72 hours on mainnet) elapses without the arbiter executing `resolve_dispute`, anyone—the buyer, a third-party keeper, or a bot—can sign and trigger `claim_timeout`. The program:
- Refunds the query price (`claim_amount`) and returns the full `deposit_amount` directly to the buyer.
- Releases the provider's locked bond collateral.
- The arbiter cannot hold user funds hostage.

---

### Q7: Can a provider withdraw their bond while a dispute is being deliberated?
**A**: **No.** Both `request_withdraw` and `withdraw_bond` strictly check that:
```rust
require!(provider.locked == 0, JusticeError::BondLocked);
require!(provider.open_disputes == 0, JusticeError::ActiveDisputesPending);
```
([`request_withdraw.rs#L23-L24`](file:///home/nikku/Documents/web3/NewProj/programs/justice402/src/instructions/request_withdraw.rs#L23-L24), [`withdraw_bond.rs#L45-L46`](file:///home/nikku/Documents/web3/NewProj/programs/justice402/src/instructions/withdraw_bond.rs#L45-L46)).
Even if a provider only has 0.05 USDC locked, any open dispute halts the withdrawal pipeline until the dispute is formally resolved or timed out.

---

### Q8: What if a dispute was opened with a claim amount of 0 (e.g. free query)? Could a provider withdraw?
**A**: **No.** In our Phase 5 security audit, we identified this exact edge case: if `claim_amount == 0`, `provider.locked` would be 0, but a dispute would still be active! We patched `request_withdraw` and `withdraw_bond` to explicitly enforce `require!(provider.open_disputes == 0, JusticeError::ActiveDisputesPending)`. Staked funds cannot exit while any dispute is pending.

---

### Q9: What prevents a provider from front-running a buyer's dispute by withdrawing their bond?
**A**: The mandatory **Withdrawal Delay Timelock** ([`withdraw_bond.rs#L49-L53`](file:///home/nikku/Documents/web3/NewProj/programs/justice402/src/instructions/withdraw_bond.rs#L49-L53)).
A provider cannot execute an atomic withdrawal. They must first call `request_withdraw`, which records `withdraw_requested_at`. They must wait through `config.withdraw_delay` (e.g. 7 days on mainnet) before `withdraw_bond` will succeed.
Furthermore, buyer agents check `provider.withdraw_requested_at` prior to making a purchase: if a provider has initiated a withdrawal, the buyer agent's spend policy refuses to route payments to them.

---

### Q10: Why is the service spec immutable per provider account?
**A**: Mutability creates a bait-and-switch vulnerability: a provider could commit to a strict schema (`temperature: [-50, 60]`), serve responses, and then update their spec to `[-5000, 5000]` before the dispute reaches the arbiter.
By making `spec_hash` immutable at registration ([`register_provider.rs#L53`](file:///home/nikku/Documents/web3/NewProj/programs/justice402/src/instructions/register_provider.rs#L53)), the provider's promises are permanently etched into the account. Upgrading a service schema requires registering a new provider account with a new bond and spec hash.

---

### Q11: How does the arbiter verify the evidence off-chain before submitting an on-chain ruling?
**A**: The Arbiter CLI (`services/arbiter/src/cli.ts`) executes a deterministic 5-step verification:
1. Fetches on-chain `Dispute` account to read `spec_hash`, `evidence_hash`, and `receipt_hash`.
2. Downloads the provider's off-chain specification from `/spec` and asserts `sha256(spec) == spec_hash`.
3. Verifies that `sha256(evidence_bundle) == evidence_hash`.
4. Executes JSON Schema validation against the response payload.
5. Evaluates numeric range bounds (e.g. `min: -50, max: 60`) and freshness checks (`now - observedAt <= maxAge`).
Only after all programmatic audits pass does the CLI display the audit summary and prompt the human arbiter for digital signature.

---

### Q12: What prevents the arbiter from stealing funds from the program vault?
**A**: The arbiter has **no arbitrary withdrawal authority**.
The program vault is a PDA derived with seeds `[b"vault", config.key()]`. The only instruction the arbiter can invoke is `resolve_dispute` ([`resolve_dispute.rs`](file:///home/nikku/Documents/web3/NewProj/programs/justice402/src/instructions/resolve_dispute.rs)). In that instruction:
- The payout destination token account is strictly checked: `require_keys_eq!(buyer_token_account.owner, dispute.buyer)`.
- The payout amount is hard-capped to `claim_amount + deposit_amount`.
The arbiter cannot redirect funds to their own wallet or siphon unreserved bond capital.

---

### Q13: Why does `claim_timeout` not increment `disputes_buyer_won` or `total_slashed`?
**A**: When a dispute times out, it indicates a failure of the **arbiter's liveness**, not necessarily bad behavior by the provider ([`claim_timeout.rs#L72-L79`](file:///home/nikku/Documents/web3/NewProj/programs/justice402/src/instructions/claim_timeout.rs#L72-L79)).
Slashing a provider's bond and branding them with a "loss" when the arbiter was unresponsive would allow griefers to coordinate DoS attacks against the arbiter to penalize innocent providers. Instead, timeout refunds the buyer and increments `provider.disputes_timed_out` as a distinct metric.

---

### Q14: Why is the receipt layout fixed to exactly 249 bytes?
**A**: Deterministic binary packing avoids parsing ambiguity and keeps Solana compute units low.
The receipt layout ([`state.rs#L98-L134`](file:///home/nikku/Documents/web3/NewProj/programs/justice402/src/state.rs#L98-L134)):
- `version`: 1 byte
- `provider`: 32 bytes
- `buyer`: 32 bytes
- `spec_hash`: 32 bytes
- `request_hash`: 32 bytes
- `response_hash`: 32 bytes
- `payment_reference`: 32 bytes
- `price`: 8 bytes
- `timestamp`: 8 bytes
- `nonce`: 8 bytes
- `signature`: 64 bytes (detached or attached)
- Total canonical message bytes: **185 bytes** (excluding signature); with Ed25519 signature payload: **249 bytes**.
Fixed-width layout guarantees that both TypeScript and Rust produce byte-identical encodings.

---

### Q15: How does Justice402 stay within Solana's 1232-byte IPv6 MTU transaction limit?
**A**: The legacy transaction format has a strict 1232-byte limit. `open_dispute` requires:
- Solana header + blockhash: ~100 bytes
- Ed25519 precompile instruction: ~250 bytes
- `open_dispute` instruction data (185-byte receipt + 32-byte evidence hash): ~220 bytes
- 9 Account keys: 9 × 32 = 288 bytes
- Total transaction size: **1154 bytes** (78 bytes below the 1232-byte cap).
To prevent overflow, we explicitly enforce single-signer transactions where `buyerWallet` signs as payer and buyer authority without redundant fee payers.

---

### Q16: What is the trust model for the arbiter, and how will it evolve?
**A**:
- **Current (Devnet / MVP)**: The arbiter is a trusted human operator holding the designated `arbiter` keypair. Arbiter risk is bounded by `per_ruling_payout_cap`, `claim_timeout`, and destination token account checks.
- **Phase 3 (Future Work)**: An AI Arbiter Advisor. A sandboxed model reviews OpenAPI specs and complex semantic disputes, outputting a signed audit report for the human arbiter to co-sign.
- **Long-term**: Multi-arbiter federations or optimistic dispute staking with UMA-style escalation.

---

### Q17: Why did we choose `@solana/kit` v8 and how does it relate to `@x402/svm`?
**A**: `@x402/svm` (the official SVM settlement engine for x402) adopts the modern `@solana/kit` v8 SDK for building v1 transactions and zero-dependency RPC clients. We chose `@solana/kit` v8 to maintain native compatibility with the official x402 facilitator infrastructure and avoid heavy legacy web3.js bundles in browser and agent runtimes.

---

### Q18: What happens if the provider changes their server response schema without updating their registered spec?
**A**: Any response that deviates from the committed `spec_hash` is instantly disputable.
When a buyer agent receives a response:
1. It validates the payload against the cached spec matching `receipt.spec_hash`.
2. If the server returned new fields that fail the registered JSON Schema, the buyer's off-chain validator flags a violation.
3. The buyer opens a dispute. The arbiter fetches `/spec`, confirms `sha256(spec) == on_chain_spec_hash`, runs the schema validation, and rules `BuyerWins`.
Providers cannot unilaterally change schemas without registering a new provider account.

---

### Q19: How does Justice402 differ from x402r or escrow-based payment protocols?
**A**:
| Feature | Escrow / x402r | Justice402 |
|---|---|---|
| **Payment Settlement** | Delayed until release | **Instant** over native x402 |
| **Transaction Count** | 2–3 per HTTP call | **1** per HTTP call (dispute only on failure) |
| **Custodial Risk** | 100% of purchase price held | **0%** held during request |
| **Collateral Source** | Buyer pays upfront into escrow | **Provider stakes bond** on Solana |
| **Spec Verification** | Unstructured or manual | **Cryptographically committed** `spec_hash` |

---

### Q20: What is required to take Justice402 from devnet to a production mainnet deployment?
**A**:
1. **Third-Party Security Audit**: Formal mathematical and invariant audit of Anchor instruction constraints and Ed25519 instruction parser.
2. **Timelock Parameters**: Increase `dispute_window` (e.g. 24 hours), `resolve_timeout` (e.g. 72 hours), and `withdraw_delay` (e.g. 14 days).
3. **Decentralized Arbiter Federation**: Transition from a single arbiter keypair to a multi-signature committee or hybrid AI/human staking protocol.
4. **Mainnet USDC Mint**: Point `Config.usdc_mint` to Solana Mainnet Circle USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`).
5. **Continuous Keeper Network**: Deploy open-source bots to monitor and trigger `claim_timeout` on expired disputes to ensure 100% buyer protection even during network partitions.

# Justice402 Architectural & Design Decisions

This document details every major architectural and protocol design decision made in Justice402, including options considered, rationale for the chosen design, and associated trade-offs.

---

## 1. Insurance vs. Payment Escrow

| Option | Description | Trade-offs |
|---|---|---|
| **A. Payment Escrow (Rejected)** | Lock buyer funds in a smart contract escrow until the buyer confirms satisfaction or a timer expires. | High latency, requires custom payment rails, breaks instant x402 V2 settlement, custodial risk, poor UX for high-frequency AI agent queries. |
| **B. Post-Payment Bonded Insurance (Chosen)** | Buyer pays the provider directly and instantly via standard x402. The provider maintains a staked bond in the Solana program from which valid claims are refunded. | **Zero payment latency**, 100% compliant with standard x402 HTTP flows, no custody over user funds during request. Trade-off: Requires providers to stake collateral upfront. |

**Rationale**: The core value proposition of x402 is sub-second, machine-to-machine micropayments. Introducing an escrow contract slows down execution and adds friction. With insurance, payments settle in milliseconds, and the on-chain bond guarantees recourse if the provider defaults.

---

## 2. Staked Bond & Buyer Pre-Flight Spend Policy

- **Chosen Design**: Providers deposit an arbitrary bond in USDC (`register_provider`, `top_up`). The buyer agent executes an on-chain pre-flight check before issuing payment:
  $$\text{Allowed} \iff \text{Available Bond} \ge K \times \text{Query Price} \quad \land \quad \text{Loss Rate} \le \text{Max Allowed}$$
- **Trade-offs**: Providers must lock capital to build credibility. However, this perfectly aligns economic incentives: honest providers reuse the same bond across thousands of queries without slashing, while malicious actors face immediate capital forfeiture.

---

## 3. Provider-Signed Receipts & Ed25519 Instruction Introspection

| Option | Description | Trade-offs |
|---|---|---|
| **A. Solana Ed25519 Syscall / Native Curve in SBF (Rejected)** | Call Ed25519 verification directly in program code. | Incurred massive compute unit costs (historically unavailable or CU-prohibitive on Solana SBF). |
| **B. Ed25519 Precompile Instruction Introspection (Chosen)** | Client includes a native Solana `Ed25519Program` instruction at index `0`, followed by `open_dispute` at index `1`. The program inspects the instruction sysvar to verify the signature. | **Zero signature compute overhead**, native hardware acceleration on validator nodes, cryptographically non-malleable. |

- **Security Hardening**:
  - Instruction introspection strictly mandates `sig_ix_idx == u16::MAX`, `pubkey_ix_idx == u16::MAX`, `msg_ix_idx == u16::MAX`. This guarantees the public key, message, and signature reside in the same instruction buffer, preventing cross-instruction spoofing attacks.
  - Receipt wire size is fixed to exactly **249 bytes**, preventing truncation or dynamic buffer length attacks.

---

## 4. Service Specification Commitment (`spec_hash`)

- **Chosen Design**: Providers register a sha256 hash of their service specification document on-chain (`spec_hash: [u8; 32]`). The full specification (containing JSON Schema, numerical bounds, and freshness rules) is served off-chain at `/spec`.
- **Trade-offs**: Storing entire JSON schemas on-chain is expensive in account rent and CU parsing. Hashing the spec on-chain binds the provider immutably to a deterministic off-chain schema. Any change to the spec requires registering a new provider account.

---

## 5. Timeout Policy (No Slashes on Timeout)

- **Chosen Design**: If an arbiter fails to rule before `resolve_timeout` expires, `claim_timeout` refunds the buyer their query price + returned dispute deposit. It increments `disputes_timed_out`, but **does NOT** increment `disputes_buyer_won` or `total_slashed`.
- **Rationale**: A timeout reflects arbiter unresponsiveness or network congestion—not definitive provider fault. Penalizing the provider's reputation or slashing punitive damages without a confirmed arbiter ruling would create an incentive for malicious buyers to coordinate denial-of-service attacks on arbiters to force timeouts.

---

## 6. Anti-Griefing: Dispute Deposit & Open Dispute Cap

- **Chosen Design**:
  - **Dispute Deposit**: Buyers pay a configurable deposit (default: 1 USDC) upon calling `open_dispute`. Returned on `BuyerWins` or `TimedOut`; forfeited to provider bond on `ProviderWins`.
  - **Open Dispute Cap**: Tracked per buyer per provider in a `BuyerRecord` PDA (`[b"buyer_record", provider, buyer]`), capped at 3 simultaneous open disputes.
- **Rationale**: Without a deposit and cap, a malicious buyer could open thousands of zero-price or frivolous disputes, locking up the provider's bond and exhausting transaction slots. The deposit forces buyers to have financial skin in the game.

---

## 7. Permissionless Timeout Settlement

- **Chosen Design**: `ClaimTimeout` uses `pub caller: Signer<'info>`, while strictly constraining the token destination to `token::authority = dispute.buyer`.
- **Rationale**: If a buyer opens a dispute and then goes offline or loses their private key, the provider's bond would remain locked indefinitely. By making `claim_timeout` permissionless, any third-party keeper, bot, or the provider themselves can trigger settlement once the deadline passes, unlocking the provider's bond while guaranteeing that funds go only to the buyer.

---

## 8. Human Arbiter First (AI Advisor as Future Work)

- **Chosen Design**: The initial version relies strictly on a **Human Arbiter CLI** with deterministic auditing tools.
- **Rationale**: Fully autonomous AI arbiters introduce non-deterministic prompt injection risks and LLM hallucination vulnerabilities when real funds are at stake. By designing the deterministic verifier first (verifying hashes, schema validation, numerical ranges, and freshness), the human arbiter makes the final cryptographic signature. An AI arbiter is cleanly architected as an advisor that suggests rulings to the human arbiter.

---

## 9. SDK Isolation: `@solana/kit` v8 vs. `web3.js` v1

- **Chosen Design**:
  - `@x402/svm@2.32.0` mandates `@solana/kit: >=8.0.0` (the modern, modular Solana SDK).
  - `@anchor-lang/core` and Anchor's generated clients rely on `@solana/web3.js` v1.
  - We isolate `@x402/svm` in `packages/x402-svm`, communicating exclusively via plain byte arrays (`Uint8Array`) and JSON strings.
- **Trade-offs**: Clean decoupling eliminates npm peer dependency conflicts and prevents leaking conflicting classes across the monorepo.

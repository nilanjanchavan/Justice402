# Justice402: Live Demo Presentation Script

**Target Audience**: Club Reviewer, Technical Interviewer, or Hackathon Judge.  
**Duration**: 2.5 to 3.0 minutes.  
**Key Focus**: Working live demo on Solana Devnet, real x402 payments, cryptographic guarantees, zero simulated shortcuts.

---

## Preparation & Prerequisites (Before Starting)

Have three browser tabs and one terminal window open side-by-side:
1. **Tab 1**: Next.js Dashboard (`http://localhost:3000` or hosted Vercel URL).
2. **Tab 2**: Solana Explorer Devnet (`https://explorer.solana.com/?cluster=devnet`).
3. **Tab 3**: GitHub Repo (`https://github.com/nilanjanchavan/Justice402`).
4. **Terminal**: Split pane:
   - Pane A (Left): Runner script (`npm run demo:devnet`).
   - Pane B (Right): Arbiter CLI ready (`npm run arbiter`).

---

## Presentation Timeline

```mermaid
journey
    title 3-Minute Live Demo Flow
    section Act 1: The Problem (0:00 - 0:40)
      Explain x402 instant settlement: 5: Presenter
      Explain agent vulnerability to bad data: 5: Presenter
      Distinguish Insurance vs Escrow: 5: Presenter
    section Act 2: Happy Path (0:40 - 1:15)
      Inspect on-chain provider bond & spec_hash: 4: Presenter
      Make real x402 payment to honest API: 5: Runner
      Validate receipt cryptography: 4: Buyer Agent
    section Act 3: Violation & Dispute (1:15 - 2:05)
      Call lying API returning out-of-range data: 4: Runner
      Detect spec schema violation: 5: Buyer Agent
      Submit on-chain open_dispute transaction: 5: Program
    section Act 4: Arbiter & Refund (2:05 - 2:45)
      Inspect dispute on Dashboard & CLI: 5: Arbiter
      Confirm ruling BuyerWins on-chain: 5: Arbiter
      Show bond slashed and buyer refunded: 5: Presenter
```

---

## Act 1: The Problem & Solution (0:00 - 0:45)

**[Screen: Show Dashboard Home Page or Architecture Diagram in README]**

> **Speaker**:  
> "Hi everyone. Over the last year, autonomous AI agents have begun paying for web services using HTTP **x402** micropayments. Under x402, an agent requests data, receives a 402 Payment Required status, submits a Solana transaction, and gets the response. Settlement is instant and irreversible.
>
> But here is the critical vulnerability: **What happens when an API charges the agent and returns a hallucination, corrupted data, or numbers completely out of spec?**
>
> Escrow is the intuitive answer, but escrow breaks the core promise of x402: escrow introduces multi-second settlement delays, high latency, and centralized custody.
>
> We built **Justice402**: **Insurance for x402 payments, not escrow.**  
> API providers register on Solana, stake a USDC bond, and commit to an immutable SHA-256 hash of their service specification. Every API response carries a provider-signed receipt. Payments settle instantly. If a response violates the spec, the buyer opens an on-chain dispute, and an arbiter refunds the buyer directly from the provider's bond."

---

## Act 2: Happy Path & Service Spec Commitment (0:45 - 1:15)

**[Screen: Switch to Terminal Left Pane. Run `npm run demo:devnet` or point to Live Providers in Dashboard]**

> **Speaker**:  
> "Let's see this live on Solana Devnet.  
> First, our autonomous buyer agent queries the on-chain registry for registered weather providers. It sees `Provider A` has a 10 USDC bond staked, 0 dispute losses, and has committed to a service specification at `spec_hash`.
>
> The buyer agent executes a real HTTP call to `Provider A`'s `/weather` endpoint. It pays 0.05 USDC over x402. The honest provider responds with:  
> `temperature: 22°C, observedAt: 1732450000`.
>
> Along with the JSON payload, the provider signs a canonical 249-byte receipt header. The buyer validates the Ed25519 signature and confirms the data complies with the schema. The transaction is complete. Zero escrow delays."

---

## Act 3: Spec Violation & On-Chain Dispute Opening (1:15 - 2:05)

**[Screen: Terminal Left Pane starts Stage 2 (Lying Provider), then prints the Open Dispute Devnet Explorer link]**

> **Speaker**:  
> "Now, the buyer agent calls `Provider B`, a malicious weather provider.  
> The agent pays 0.05 USDC over x402. But `Provider B` returns:  
> `temperature: 9999°C` — an out-of-range value that violates the registered specification!
>
> The buyer agent detects this violation off-chain in less than 2 milliseconds. It compiles the request, response, and receipt into an evidence hash.
>
> Next, the buyer invokes our Anchor program's `open_dispute` instruction on Solana Devnet.  
> Notice something crucial here: **Justice402 does not rely on oracles or trusted relayer bridges.** The transaction includes a native Solana Ed25519 instruction immediately followed by `open_dispute`. Our on-chain program uses instruction sysvar introspection to verify the provider's signature right on the validator!
>
> The contract automatically locks 0.05 USDC of the provider's bond and collects a 1 USDC dispute deposit to prevent buyer spam. Here is the live transaction on Solana Explorer."

**[Screen: Click the Solana Explorer Devnet link printed in terminal or dashboard. Show the Instruction: `open_dispute` and `Ed25519SigVerify` in the transaction history]**

---

## Act 4: Arbiter Ruling & On-Chain Settlement (2:05 - 2:45)

**[Screen: Switch to Terminal Right Pane (Arbiter CLI) or Dashboard Live Disputes tab]**

> **Speaker**:  
> "Now let's switch hats to the arbiter. In Justice402, the arbiter is an explicit, trusted role—for this MVP, a human arbiter running our CLI auditing tool.
>
> The arbiter CLI fetches the dispute from Solana Devnet. It fetches the provider's `/spec`, verifies that `sha256(spec)` matches the immutable on-chain `spec_hash`, and automatically runs the schema validators.
>
> The CLI displays:  
> `VIOLATION CONFIRMED: temperature 9999 is outside allowed range [-50, 60]`.
>
> The human arbiter reviews the cryptographic evidence and hits 'Y' to sign the ruling on Devnet.
>
> Our Anchor program executes `resolve_dispute`:  
> 1. The 0.05 USDC refund plus the 1 USDC deposit are returned to the buyer's wallet.  
> 2. The provider's bond is slashed.  
> 3. The provider's on-chain track record is permanently updated: `disputes_buyer_won + 1`.  
>
> Future buyers reading this provider's trust score will immediately see their 100% dispute loss rate and refuse to do business with them."

---

## Conclusion & Wrap-Up (2:45 - 3:00)

**[Screen: Return to Dashboard Overview or Architecture Diagram]**

> **Speaker**:  
> "To summarize:
> - **Instant payments**: x402 operates at native wire speed without escrow delays.
> - **Cryptographic accountability**: Every response is signed and bound to an immutable specification.
> - **Trust-minimized recourse**: On-chain Ed25519 introspection, permissionless timeout refunds if the arbiter ever goes offline, and economic anti-griefing deposits.
>
> Everything you just saw is live on Solana Devnet, reproducible with `npm run demo:devnet`, and documented down to the exact instruction line numbers in our repository. Thank you!"

---

## Anticipated Reviewer Q&A Follow-ups

1. **"What happens if the arbiter disappears or goes offline?"**  
   *Answer*: "We implemented a permissionless `claim_timeout` instruction. If the arbiter fails to rule within `resolve_timeout` (e.g. 3 minutes on devnet), *any* caller can execute `claim_timeout` to immediately refund the buyer's payment and deposit from the reserved bond."

2. **"Can a provider withdraw their bond to escape a dispute?"**  
   *Answer*: "No. Withdrawals require a two-step timelocked process (`request_withdraw` followed by `withdraw_delay`). The program strictly forbids starting or completing a withdrawal if `locked > 0` or `open_disputes > 0`."

3. **"Why not use an AI arbiter right now?"**  
   *Answer*: "Prompts can be jailbroken and models hallucinate. For financial settlement, human authority is the safest first step. In our roadmap, we design an AI arbiter as an advisory copilot that prepares audits for human confirmation, not an autonomous signer."

# Justice402 Canonical Receipt Specification

## 1. Overview
The Justice402 accountability layer requires every paid API response from an x402 provider to include a cryptographically signed receipt. The receipt commits the provider to:
- The exact request parameters (`request_hash`)
- The exact response served (`response_hash`)
- The provider's immutable service specification commitment (`spec_hash`)
- The buyer wallet paying for the response (`buyer`)
- The provider wallet receiving the payment and bonding collateral (`provider`)
- The agreed price in USDC base units (`price`)
- The creation time (`timestamp`)
- An optional transaction signature reference (`payment_reference`)
- A replay-prevention nonce (`nonce`)

## 2. Fixed Canonical Byte Layout (249 Bytes)

The receipt is serialized into a strict 249-byte canonical buffer. No variable-length fields or dynamic encodings (e.g. JSON or CBOR) are used for the signature preimage, ensuring zero ambiguity across Rust and TypeScript implementations.

| Field | Type | Size (Bytes) | Byte Offset | Endianness | Description |
|---|---|---|---|---|---|
| `version` | `u8` | 1 | 0..1 | N/A | Protocol receipt format version (currently `1`) |
| `provider` | `[u8; 32]` | 32 | 1..33 | N/A | Provider Solana public key (32 bytes) |
| `buyer` | `[u8; 32]` | 32 | 33..65 | N/A | Buyer Solana public key (32 bytes) |
| `spec_hash` | `[u8; 32]` | 32 | 65..97 | N/A | SHA-256 hash of off-chain service specification (`/spec`) |
| `request_hash` | `[u8; 32]` | 32 | 97..129 | N/A | SHA-256 hash of canonical request data |
| `response_hash` | `[u8; 32]` | 32 | 129..161 | N/A | SHA-256 hash of raw response bytes |
| `payment_reference` | `[u8; 64]` | 64 | 161..225 | N/A | Solana transaction signature (64 bytes raw, 0-padded if absent) |
| `price` | `u64` | 8 | 225..233 | Little-Endian | Agreed payment amount in token base units (e.g., micro-USDC) |
| `timestamp` | `i64` | 8 | 233..241 | Little-Endian | Unix timestamp (seconds) when the receipt was signed |
| `nonce` | `u64` | 8 | 241..249 | Little-Endian | Provider-generated unique nonce |

Total Length: **249 bytes**

## 3. Cryptographic Hashes & Signatures

### Receipt Hash
$$\text{receipt\_hash} = \text{SHA-256}(\text{canonical\_bytes})$$
The `receipt_hash` is 32 bytes and is used as the seed for on-chain Dispute accounts:
`["dispute", receipt_hash]`

### Provider Signature
The provider signs the 249 `canonical_bytes` with their Ed25519 private key:
$$\text{signature} = \text{Ed25519Sign}(\text{provider\_key}, \text{canonical\_bytes})$$

## 4. Service Specification Commitment (`spec_hash`)
Providers commit to a service specification when registering their on-chain account (`register_provider`). For the hackathon, this commitment is immutable for the lifetime of that provider account. Every signed receipt emitted by the provider must include this identical `spec_hash`. The `open_dispute` instruction enforces on-chain that:
$$\text{receipt.spec\_hash} == \text{provider.spec\_hash}$$
The spec document itself is hosted off-chain at `/spec` as a JSON document containing a plain language description, JSON schema, valid numerical ranges, and freshness rules. Its SHA-256 hash must match `spec_hash`.

## 5. Known SDK Limitations
In x402 V2, the settlement transaction signature is provided in the `PAYMENT-RESPONSE` header when the facilitator settles the transaction. If the client SDK or custom flow does not expose the raw transaction signature at receipt creation time (e.g. upfront receipt generation before settlement confirmation), the 64-byte `payment_reference` field is zero-filled. The contract validates provider authenticity via the Ed25519 signature over all canonical bytes regardless of whether `payment_reference` is set or zeroed.

## 6. Test Vectors
See `tests/receipt_vectors.json` for deterministic test vectors shared between Rust unit tests and TypeScript tests.

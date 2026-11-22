# Justice402 Canonical Receipt Specification

## 1. Overview
The Justice402 accountability layer requires every paid API response from an x402 provider to include a cryptographically signed receipt. The receipt commits the provider to:
- The exact request parameters (`request_hash`)
- The exact response served (`response_hash`)
- The buyer wallet paying for the response (`buyer`)
- The provider wallet receiving the payment and bonding collateral (`provider`)
- The agreed price in USDC base units (`price`)
- The creation time (`timestamp`)
- An optional transaction signature reference (`payment_reference`)
- A replay-prevention nonce (`nonce`)

## 2. Fixed Canonical Byte Layout (217 Bytes)

The receipt is serialized into a strict 217-byte canonical buffer. No variable-length fields or dynamic encodings (e.g. JSON or CBOR) are used for the signature preimage, ensuring zero ambiguity across Rust and TypeScript implementations.

| Field | Type | Size (Bytes) | Byte Offset | Endianness | Description |
|---|---|---|---|---|---|
| `version` | `u8` | 1 | 0..1 | N/A | Protocol receipt format version (currently `1`) |
| `provider` | `[u8; 32]` | 32 | 1..33 | N/A | Provider Solana public key (32 bytes) |
| `buyer` | `[u8; 32]` | 32 | 33..65 | N/A | Buyer Solana public key (32 bytes) |
| `request_hash` | `[u8; 32]` | 32 | 65..97 | N/A | SHA-256 hash of canonical request data |
| `response_hash` | `[u8; 32]` | 32 | 97..129 | N/A | SHA-256 hash of raw response bytes |
| `payment_reference` | `[u8; 64]` | 64 | 129..193 | N/A | Solana transaction signature (64 bytes raw, 0-padded if absent) |
| `price` | `u64` | 8 | 193..201 | Little-Endian | Agreed payment amount in token base units (e.g., micro-USDC) |
| `timestamp` | `i64` | 8 | 201..209 | Little-Endian | Unix timestamp (seconds) when the receipt was signed |
| `nonce` | `u64` | 8 | 209..217 | Little-Endian | Provider-generated unique nonce |

Total Length: **217 bytes**

## 3. Cryptographic Hashes & Signatures

### Receipt Hash
$$\text{receipt\_hash} = \text{SHA-256}(\text{canonical\_bytes})$$
The `receipt_hash` is 32 bytes and is used as the seed for on-chain Dispute accounts:
`["dispute", receipt_hash]`

### Provider Signature
The provider signs the 217 `canonical_bytes` with their Ed25519 private key:
$$\text{signature} = \text{Ed25519Sign}(\text{provider\_key}, \text{canonical\_bytes})$$

## 4. Known SDK Limitations
In x402 V2, the settlement transaction signature is provided in the `PAYMENT-RESPONSE` header when the facilitator settles the transaction. If the client SDK or custom flow does not expose the raw transaction signature at receipt creation time (e.g. upfront receipt generation before settlement confirmation), the 64-byte `payment_reference` field is zero-filled. The contract validates provider authenticity via the Ed25519 signature over all canonical bytes regardless of whether `payment_reference` is set or zeroed.

## 5. Test Vectors
See `tests/receipt_vectors.json` for deterministic test vectors shared between Rust unit tests and TypeScript tests.

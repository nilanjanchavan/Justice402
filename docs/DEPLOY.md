# Justice402 Devnet Deployment Guide

This guide details the exact steps to deploy the verifiable Justice402 Anchor program to Solana devnet, initialize on-chain IDL, confirm verification against the public repository, and configure initial devnet accounts.

---

## 1. Prerequisites & Funding Requirements

### Network Safety Check
> [!CAUTION]
> **NEVER USE MAINNET OR REAL FUNDS.** Always verify cluster configuration before running any deployment or funding commands.

```bash
solana config set --url https://api.devnet.solana.com
solana config get
```
*Verify that `RPC URL` points to `https://api.devnet.solana.com`.*

### Devnet SOL Estimation
- **Verifiable Binary Size**: `target/verifiable/justice402.so` is **433,184 bytes** (~424 KB).
- **Program Account Rent**: ~3.01 SOL at base size.
- **Recommended `--max-len` (650,000 bytes)**: ~4.52 SOL rent exemption (provides headroom for in-place future upgrades).
- **IDL Account Rent & Transactions**: ~0.05 SOL.
- **Buffer & Deployment Fees**: ~1.0 SOL.
- **Total Devnet SOL Required**: **~5.5 to 6.5 devnet SOL** in the deployer wallet.

Request devnet SOL if needed:
```bash
solana airdrop 2 <DEPLOYER_PUBKEY> --url https://api.devnet.solana.com
# Repeat or use the Solana Devnet Faucet (https://faucet.solana.com)
```

---

## 2. Verifiable Build Verification

The verifiable build has been compiled deterministically inside the official Anchor container (`solanafoundation/anchor:v1.0.0`):
```bash
anchor keys sync
anchor build --verifiable
```
*Binary artifact generated at `target/verifiable/justice402.so`.*

---

## 3. Devnet Deployment Commands

### A. Deploy Program with Upgrade Headroom (`--max-len`)
Replace `<DEPLOYER_KEYPAIR_PATH>` with your deployer keypair path (e.g. `~/.config/solana/id.json`). Do not commit this keypair!

```bash
# 1. Print cluster and wallet confirmation
echo "Deploying to cluster: $(solana config get | grep 'RPC URL')"
echo "Deployer wallet: $(solana address --keypair <DEPLOYER_KEYPAIR_PATH>)"

# 2. Deploy program with extra max-len (650,000 bytes)
solana program deploy \
  --program-id target/deploy/justice402-keypair.json \
  --max-len 650000 \
  --keypair <DEPLOYER_KEYPAIR_PATH> \
  --url https://api.devnet.solana.com \
  target/verifiable/justice402.so
```

### B. Verify Program Account on Devnet
```bash
solana program show 2kqYmJMLeSUQ9pgwpJuewNhjr4CMkw3dE9phTpFKNJoJ --url https://api.devnet.solana.com
```
*Confirm the ProgramData address, authority, and data length.*

---

## 4. Initialize & Confirm On-Chain IDL

Anchor stores program IDL on-chain in an account derived from the program ID.

### A. Initialize IDL on Devnet
```bash
anchor idl init \
  --provider.cluster devnet \
  --provider.wallet <DEPLOYER_KEYPAIR_PATH> \
  --filepath target/idl/justice402.json \
  2kqYmJMLeSUQ9pgwpJuewNhjr4CMkw3dE9phTpFKNJoJ
```

### B. Fetch and Confirm On-Chain IDL
```bash
anchor idl fetch \
  --provider.cluster devnet \
  2kqYmJMLeSUQ9pgwpJuewNhjr4CMkw3dE9phTpFKNJoJ
```
*Verify that the returned JSON contains all 8 instructions and accounts.*

---

## 5. Verify Program against Public Repo with `solana-verify`

`solana-verify` builds the code from GitHub in Docker and compares sha256 hashes against the deployed on-chain bytecode:

```bash
# Install solana-verify if not installed
cargo install solana-verify

# Verify on-chain program against the public repository
solana-verify verify-from-repo \
  --url https://api.devnet.solana.com \
  --program-id 2kqYmJMLeSUQ9pgwpJuewNhjr4CMkw3dE9phTpFKNJoJ \
  https://github.com/nilanjanchavan/Justice402
```
*Outputs verification status: `Program matches commit hash`.*

---

## 6. Post-Deployment Devnet Initialization

Once the program is deployed on devnet:
```bash
# 1. Initialize singleton Config PDA and USDC vault
npm run init:devnet

# 2. Seed test demo providers (Honest, Lying, Plausible-Wrong) with bonds
npm run seed:devnet

# 3. Execute live devnet verification flow
npm run demo:devnet
```


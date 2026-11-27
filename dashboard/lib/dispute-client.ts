/**
 * Browser-side Anchor instruction builders for open_dispute & claim_timeout.
 * Account derivations and layouts match target/idl/justice402.json exactly.
 */
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  NATIVE_MINT,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import { PROGRAM_ID } from "./solana";
import { ReceiptDataBrowser, encodeReceiptBrowser, sha256 } from "./receipt-browser";

const te = new TextEncoder();

export const CONFIG_PDA = PublicKey.findProgramAddressSync([te.encode("config")], PROGRAM_ID)[0];
export const VAULT_PDA = PublicKey.findProgramAddressSync(
  [te.encode("vault"), CONFIG_PDA.toBytes()],
  PROGRAM_ID
)[0];

export function getProviderPda(providerWallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [te.encode("provider"), providerWallet.toBytes()],
    PROGRAM_ID
  )[0];
}

export function getBuyerRecordPda(providerWallet: PublicKey, buyer: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [te.encode("buyer_record"), providerWallet.toBytes(), buyer.toBytes()],
    PROGRAM_ID
  )[0];
}

export function getDisputePda(receiptHash: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync([te.encode("dispute"), receiptHash], PROGRAM_ID)[0];
}

const OPEN_DISPUTE_DISC = new Uint8Array([137, 25, 99, 119, 23, 223, 161, 42]);
const CLAIM_TIMEOUT_DISC = new Uint8Array([130, 234, 45, 53, 120, 90, 86, 178]);

function readU64LE(arr: Uint8Array, offset: number): bigint {
  const view = new DataView(arr.buffer, arr.byteOffset + offset, 8);
  return view.getBigUint64(0, true);
}

/**
 * Reads dispute_deposit (lamports) from on-chain Config account.
 * Config layout: disc(8) + arbiter(32) + usdc_mint(32) + dispute_window(8)
 * + resolve_timeout(8) + withdraw_delay(8) + per_ruling_payout_cap(8) + dispute_deposit(8)
 */
async function getOnChainDisputeDeposit(connection: Connection): Promise<bigint> {
  try {
    const info = await connection.getAccountInfo(CONFIG_PDA);
    if (info && info.data.length >= 112) {
      return readU64LE(info.data, 104);
    }
  } catch {
    // fallback below
  }
  return 10_000_000n; // 0.01 SOL default on Devnet
}

export async function buildOpenDisputeTransaction(params: {
  connection: Connection;
  buyerPubkey: PublicKey;
  receipt: ReceiptDataBrowser;
  signatureBase64: string;
  responseData: any;
}): Promise<{ transaction: Transaction; disputePda: PublicKey; receiptHash: Uint8Array }> {
  const { connection, buyerPubkey, receipt, signatureBase64, responseData } = params;

  const canonicalBytes = encodeReceiptBrowser(receipt);
  const receiptHash = await sha256(canonicalBytes);
  const rawResponse = te.encode(JSON.stringify(responseData));
  const evidenceHash = await sha256(rawResponse);

  const disputePda = getDisputePda(receiptHash);
  const providerPda = getProviderPda(receipt.provider);
  const buyerRecordPda = getBuyerRecordPda(receipt.provider, buyerPubkey);

  const signatureBytes = Uint8Array.from(atob(signatureBase64), (c) => c.charCodeAt(0));

  const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
    publicKey: receipt.provider.toBytes(),
    message: canonicalBytes,
    signature: signatureBytes,
  });

  // Read exact dispute deposit required by Config and wrap only the shortfall into wSOL ATA
  const requiredDeposit = await getOnChainDisputeDeposit(connection);
  const buyerAta = await getAssociatedTokenAddress(NATIVE_MINT, buyerPubkey);
  const preInstructions: TransactionInstruction[] = [];

  let existingWsol = 0n;
  const ataInfo = await connection.getAccountInfo(buyerAta);
  if (!ataInfo) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(buyerPubkey, buyerAta, buyerPubkey, NATIVE_MINT)
    );
  } else {
    try {
      const bal = await connection.getTokenAccountBalance(buyerAta);
      existingWsol = BigInt(bal.value.amount || "0");
    } catch {
      existingWsol = 0n;
    }
  }

  if (existingWsol < requiredDeposit) {
    const shortfall = Number(requiredDeposit - existingWsol);
    preInstructions.push(
      SystemProgram.transfer({
        fromPubkey: buyerPubkey,
        toPubkey: buyerAta,
        lamports: shortfall,
      }),
      createSyncNativeInstruction(buyerAta)
    );
  }

  const ixData = new Uint8Array(OPEN_DISPUTE_DISC.length + canonicalBytes.length + 32);
  ixData.set(OPEN_DISPUTE_DISC, 0);
  ixData.set(canonicalBytes, OPEN_DISPUTE_DISC.length);
  ixData.set(evidenceHash, OPEN_DISPUTE_DISC.length + canonicalBytes.length);

  const openDisputeIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: buyerPubkey, isSigner: true, isWritable: true },
      { pubkey: providerPda, isSigner: false, isWritable: true },
      { pubkey: buyerRecordPda, isSigner: false, isWritable: true },
      { pubkey: disputePda, isSigner: false, isWritable: true },
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
      { pubkey: VAULT_PDA, isSigner: false, isWritable: true },
      { pubkey: buyerAta, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(ixData),
  });

  const tx = new Transaction();
  for (const ix of preInstructions) tx.add(ix);
  tx.add(ed25519Ix);
  tx.add(openDisputeIx);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = buyerPubkey;

  return { transaction: tx, disputePda, receiptHash };
}

export async function buildClaimTimeoutTransaction(params: {
  connection: Connection;
  callerPubkey: PublicKey;
  disputePda: PublicKey;
  providerWallet: PublicKey;
  buyerWallet: PublicKey;
}): Promise<Transaction> {
  const { connection, callerPubkey, disputePda, providerWallet, buyerWallet } = params;
  const providerPda = getProviderPda(providerWallet);
  const buyerRecordPda = getBuyerRecordPda(providerWallet, buyerWallet);
  const buyerAta = await getAssociatedTokenAddress(NATIVE_MINT, buyerWallet);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: callerPubkey, isSigner: true, isWritable: false },
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
      { pubkey: disputePda, isSigner: false, isWritable: true },
      { pubkey: providerPda, isSigner: false, isWritable: true },
      { pubkey: buyerRecordPda, isSigner: false, isWritable: true },
      { pubkey: VAULT_PDA, isSigner: false, isWritable: true },
      { pubkey: buyerAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(CLAIM_TIMEOUT_DISC),
  });

  const tx = new Transaction().add(ix);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = callerPubkey;
  return tx;
}

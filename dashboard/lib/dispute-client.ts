/**
 * Browser-side Anchor instruction builders for open_dispute, register_provider,
 * top_up, and claim_timeout. All account derivations & layouts match target/idl/justice402.json.
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
const U64_MAX = 18446744073709551615n;

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
const REGISTER_PROVIDER_DISC = new Uint8Array([254, 209, 54, 184, 46, 197, 109, 78]);
const TOP_UP_DISC = new Uint8Array([236, 225, 96, 9, 60, 106, 77, 208]);

function readU64LE(arr: Uint8Array, offset: number): bigint {
  const view = new DataView(arr.buffer, arr.byteOffset + offset, 8);
  return view.getBigUint64(0, true);
}

function writeU64LE(val: bigint): Uint8Array {
  if (val < 0n || val > U64_MAX) {
    throw new Error(`Value ${val.toString()} is outside supported u64 range`);
  }
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, val, true);
  return buf;
}

async function getOnChainDisputeDeposit(connection: Connection): Promise<bigint> {
  const info = await connection.getAccountInfo(CONFIG_PDA);
  if (info && info.data.length >= 112) {
    return readU64LE(info.data, 104);
  }
  return 10_000_000n;
}

/**
 * Queries existing wSOL balance strictly: returns 0n ONLY when ATA is confirmed absent,
 * and propagates RPC balance-read failures instead of masking them as 0n.
 */
export async function getExistingWsolBalance(
  connection: Connection,
  owner: PublicKey
): Promise<{ ata: PublicKey; ataExists: boolean; existingWsol: bigint }> {
  const ata = await getAssociatedTokenAddress(NATIVE_MINT, owner);
  const ataInfo = await connection.getAccountInfo(ata);
  if (!ataInfo) {
    return { ata, ataExists: false, existingWsol: 0n };
  }

  let lastErr: any;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const bal = await connection.getTokenAccountBalance(ata);
      return {
        ata,
        ataExists: true,
        existingWsol: BigInt(bal.value.amount),
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Unable to read existing wSOL balance for ${ata.toBase58()}: ${lastErr?.message || lastErr}`
  );
}

/**
 * Builds instructions to ensure wSOL ATA exists and covers `requiredLamports` without rounding.
 */
async function buildWsolShortfallInstructions(
  connection: Connection,
  owner: PublicKey,
  requiredLamports: bigint
): Promise<{ ata: PublicKey; instructions: TransactionInstruction[]; shortfall: bigint }> {
  if (requiredLamports < 0n || requiredLamports > U64_MAX) {
    throw new Error("Requested lamport amount is outside u64 range");
  }

  const { ata, ataExists, existingWsol } = await getExistingWsolBalance(connection, owner);
  const instructions: TransactionInstruction[] = [];

  if (!ataExists) {
    instructions.push(
      createAssociatedTokenAccountInstruction(owner, ata, owner, NATIVE_MINT)
    );
  }

  let shortfall = 0n;
  if (existingWsol < requiredLamports) {
    shortfall = requiredLamports - existingWsol;
    if (shortfall > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `Transfer shortfall ${shortfall.toString()} lamports exceeds SystemProgram.transfer safe integer precision`
      );
    }
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: ata,
        lamports: Number(shortfall),
      }),
      createSyncNativeInstruction(ata)
    );
  }

  return { ata, instructions, shortfall };
}

/**
 * Builds open_dispute transaction. Splits wSOL ATA wrap into `prepareTransaction`
 * so the Ed25519 + open_dispute transaction stays below Solana's 1232-byte MTU limit.
 */
export async function buildOpenDisputeTransaction(params: {
  connection: Connection;
  buyerPubkey: PublicKey;
  receipt: ReceiptDataBrowser;
  signatureBase64: string;
  responseData: any;
}): Promise<{
  prepareTransaction: Transaction | null;
  transaction: Transaction;
  disputePda: PublicKey;
  receiptHash: Uint8Array;
}> {
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

  const requiredDeposit = await getOnChainDisputeDeposit(connection);
  const { ata: buyerAta, instructions: wrapIxs } = await buildWsolShortfallInstructions(
    connection,
    buyerPubkey,
    requiredDeposit
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

  let prepareTransaction: Transaction | null = null;
  if (wrapIxs.length > 0) {
    prepareTransaction = new Transaction();
    for (const ix of wrapIxs) prepareTransaction.add(ix);
    prepareTransaction.recentBlockhash = blockhash;
    prepareTransaction.lastValidBlockHeight = lastValidBlockHeight;
    prepareTransaction.feePayer = buyerPubkey;
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
  tx.add(ed25519Ix);
  tx.add(openDisputeIx);
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = buyerPubkey;

  return { prepareTransaction, transaction: tx, disputePda, receiptHash };
}

/**
 * Builds `register_provider(bond_amount, spec_hash)` transaction from connected wallet.
 */
export async function buildRegisterProviderTransaction(params: {
  connection: Connection;
  providerWallet: PublicKey;
  bondLamports: bigint;
  specHash: Uint8Array;
}): Promise<{ transaction: Transaction; providerPda: PublicKey }> {
  const { connection, providerWallet, bondLamports, specHash } = params;
  if (specHash.length !== 32) throw new Error("specHash must be 32 bytes");
  if (bondLamports < 0n || bondLamports > U64_MAX) {
    throw new Error("Bond amount is outside supported u64 range");
  }

  const providerPda = getProviderPda(providerWallet);
  const { ata: providerAta, instructions: wrapIxs } = await buildWsolShortfallInstructions(
    connection,
    providerWallet,
    bondLamports
  );

  const data = new Uint8Array(REGISTER_PROVIDER_DISC.length + 8 + 32);
  data.set(REGISTER_PROVIDER_DISC, 0);
  data.set(writeU64LE(bondLamports), REGISTER_PROVIDER_DISC.length);
  data.set(specHash, REGISTER_PROVIDER_DISC.length + 8);

  const regIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: providerWallet, isSigner: true, isWritable: true },
      { pubkey: providerPda, isSigner: false, isWritable: true },
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
      { pubkey: VAULT_PDA, isSigner: false, isWritable: true },
      { pubkey: providerAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const tx = new Transaction();
  for (const ix of wrapIxs) tx.add(ix);
  tx.add(regIx);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = providerWallet;

  return { transaction: tx, providerPda };
}

/**
 * Builds `top_up(amount)` transaction from provider's connected wallet.
 */
export async function buildTopUpTransaction(params: {
  connection: Connection;
  providerWallet: PublicKey;
  amountLamports: bigint;
}): Promise<Transaction> {
  const { connection, providerWallet, amountLamports } = params;
  if (amountLamports <= 0n || amountLamports > U64_MAX) {
    throw new Error("Top-up amount must be within valid u64 range (> 0)");
  }

  const providerPda = getProviderPda(providerWallet);
  const { ata: providerAta, instructions: wrapIxs } = await buildWsolShortfallInstructions(
    connection,
    providerWallet,
    amountLamports
  );

  const data = new Uint8Array(TOP_UP_DISC.length + 8);
  data.set(TOP_UP_DISC, 0);
  data.set(writeU64LE(amountLamports), TOP_UP_DISC.length);

  const topUpIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: providerWallet, isSigner: true, isWritable: true },
      { pubkey: providerPda, isSigner: false, isWritable: true },
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
      { pubkey: VAULT_PDA, isSigner: false, isWritable: true },
      { pubkey: providerAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const tx = new Transaction();
  for (const ix of wrapIxs) tx.add(ix);
  tx.add(topUpIx);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = providerWallet;

  return tx;
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

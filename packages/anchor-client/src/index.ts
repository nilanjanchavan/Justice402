import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  encodeReceipt,
  hashReceipt,
  ReceiptData,
  RECEIPT_CANONICAL_LEN,
  RECEIPT_VERSION,
} from "./receipt";

export * from "./receipt";

export interface ProviderTrust {
  wallet: PublicKey;
  bond: BN;
  locked: BN;
  withdrawRequestedAt: BN;
  specHash: Buffer;
  openDisputes: BN;
  wins: BN;
  losses: BN;
  disputesProviderWon: BN;
  disputesBuyerWon: BN;
  disputesTimedOut: BN;
  totalSlashed: BN;
}

export function getProviderPda(programId: PublicKey, providerWallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("provider"), providerWallet.toBuffer()],
    programId
  );
}

export function getConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
}

export function getVaultPda(programId: PublicKey, configPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), configPda.toBuffer()], programId);
}

export function getDisputePda(programId: PublicKey, receiptHash: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], programId);
}

export function getBuyerRecordPda(
  programId: PublicKey,
  providerWallet: PublicKey,
  buyerWallet: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("buyer_record"), providerWallet.toBuffer(), buyerWallet.toBuffer()],
    programId
  );
}

export async function getProviderTrust(
  program: any,
  providerWallet: PublicKey
): Promise<ProviderTrust> {
  const [providerPda] = getProviderPda(program.programId, providerWallet);
  const account = await program.account.provider.fetch(providerPda);
  return {
    wallet: account.wallet,
    bond: account.bond,
    locked: account.locked,
    withdrawRequestedAt: account.withdrawRequestedAt,
    specHash: Buffer.from(account.specHash),
    openDisputes: account.openDisputes,
    wins: account.disputesProviderWon,
    losses: account.disputesBuyerWon,
    disputesProviderWon: account.disputesProviderWon,
    disputesBuyerWon: account.disputesBuyerWon,
    disputesTimedOut: account.disputesTimedOut,
    totalSlashed: account.totalSlashed,
  };
}

export async function openDisputeWithReceipt(params: {
  program: any;
  buyerKeypair: Keypair;
  providerWallet: PublicKey;
  buyerTokenAccount: PublicKey;
  receipt: ReceiptData;
  signature: Buffer;
  evidenceHash: Buffer;
}): Promise<{ txSig: string; disputePda: PublicKey; receiptHash: Buffer }> {
  const { program, buyerKeypair, providerWallet, buyerTokenAccount, receipt, signature, evidenceHash } = params;

  const canonicalBytes = encodeReceipt(receipt);
  const receiptHash = hashReceipt(canonicalBytes);
  const [disputePda] = getDisputePda(program.programId, receiptHash);
  const [providerPda] = getProviderPda(program.programId, providerWallet);
  const [configPda] = getConfigPda(program.programId);
  const [vaultPda] = getVaultPda(program.programId, configPda);
  const [buyerRecordPda] = getBuyerRecordPda(program.programId, providerWallet, buyerKeypair.publicKey);

  const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
    publicKey: providerWallet.toBytes(),
    message: canonicalBytes,
    signature: signature,
  });

  const anchorReceipt = {
    version: receipt.version,
    provider: receipt.provider,
    buyer: receipt.buyer,
    specHash: Array.from(receipt.specHash),
    requestHash: Array.from(receipt.requestHash),
    responseHash: Array.from(receipt.responseHash),
    paymentReference: Array.from(receipt.paymentReference),
    price: new BN(receipt.price.toString()),
    timestamp: new BN(receipt.timestamp.toString()),
    nonce: new BN(receipt.nonce.toString()),
  };

  const openIx = await program.methods
    .openDispute(anchorReceipt, Array.from(evidenceHash))
    .accounts({
      buyer: buyerKeypair.publicKey,
      provider: providerPda,
      buyerRecord: buyerRecordPda,
      dispute: disputePda,
      config: configPda,
      vault: vaultPda,
      buyerTokenAccount,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const tx = new Transaction().add(ed25519Ix).add(openIx);
  tx.feePayer = buyerKeypair.publicKey;
  const txSig = await anchor.web3.sendAndConfirmTransaction(program.provider.connection, tx, [buyerKeypair]);

  return { txSig, disputePda, receiptHash };
}

export async function resolveDisputeRuling(params: {
  program: any;
  arbiterKeypair: Keypair;
  disputePda: PublicKey;
  providerWallet: PublicKey;
  buyerWallet: PublicKey;
  buyerTokenAccount: PublicKey;
  ruling: "BuyerWins" | "ProviderWins";
  rulingHash?: Buffer;
}): Promise<string> {
  const {
    program,
    arbiterKeypair,
    disputePda,
    providerWallet,
    buyerWallet,
    buyerTokenAccount,
    ruling,
    rulingHash,
  } = params;
  const [providerPda] = getProviderPda(program.programId, providerWallet);
  const [configPda] = getConfigPda(program.programId);
  const [vaultPda] = getVaultPda(program.programId, configPda);
  const [buyerRecordPda] = getBuyerRecordPda(program.programId, providerWallet, buyerWallet);

  const anchorRuling = ruling === "BuyerWins" ? { buyerWins: {} } : { providerWins: {} };
  const rHash = rulingHash ? Array.from(rulingHash) : Array.from(Buffer.alloc(32, 0));

  return await program.methods
    .resolveDispute(anchorRuling, rHash)
    .accounts({
      arbiter: arbiterKeypair.publicKey,
      config: configPda,
      dispute: disputePda,
      provider: providerPda,
      buyerRecord: buyerRecordPda,
      vault: vaultPda,
      buyerTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([arbiterKeypair])
    .rpc();
}

export async function claimTimeoutSettlement(params: {
  program: any;
  callerKeypair: Keypair;
  disputePda: PublicKey;
  providerWallet: PublicKey;
  buyerWallet: PublicKey;
  buyerTokenAccount: PublicKey;
}): Promise<string> {
  const {
    program,
    callerKeypair,
    disputePda,
    providerWallet,
    buyerWallet,
    buyerTokenAccount,
  } = params;
  const [providerPda] = getProviderPda(program.programId, providerWallet);
  const [configPda] = getConfigPda(program.programId);
  const [vaultPda] = getVaultPda(program.programId, configPda);
  const [buyerRecordPda] = getBuyerRecordPda(program.programId, providerWallet, buyerWallet);

  return await program.methods
    .claimTimeout()
    .accounts({
      caller: callerKeypair.publicKey,
      config: configPda,
      dispute: disputePda,
      provider: providerPda,
      buyerRecord: buyerRecordPda,
      vault: vaultPda,
      buyerTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([callerKeypair])
    .rpc();
}

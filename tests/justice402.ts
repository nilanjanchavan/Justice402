import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import crypto from "crypto";
import {
  encodeReceipt,
  hashReceipt,
  ReceiptData,
  RECEIPT_VERSION,
} from "../packages/anchor-client/src/receipt";
import { getProviderTrust } from "../packages/anchor-client/src/index";
import idl from "../target/idl/justice402.json";

function signEd25519(message: Buffer, secretKey: Uint8Array): Buffer {
  const privKey = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(secretKey.slice(0, 32)),
    ]),
    format: "der",
    type: "pkcs8",
  });
  return crypto.sign(null, message, privKey);
}

function getErrorMessage(err: any): string {
  if (!err) return "";
  let msg = err.toString();
  if (err.logs && Array.isArray(err.logs)) {
    msg += " " + err.logs.join(" ");
  }
  if (err.transactionLogs && Array.isArray(err.transactionLogs)) {
    msg += " " + err.transactionLogs.join(" ");
  }
  if (err.error?.errorCode?.code) {
    msg += " " + err.error.errorCode.code;
  }
  return msg;
}

function toAnchorReceipt(r: ReceiptData) {
  return {
    version: r.version,
    provider: r.provider,
    buyer: r.buyer,
    specHash: Array.from(r.specHash),
    requestHash: Array.from(r.requestHash),
    responseHash: Array.from(r.responseHash),
    paymentReference: Array.from(r.paymentReference),
    price: r.price as BN,
    timestamp: r.timestamp as BN,
    nonce: r.nonce as BN,
  };
}

describe("justice402 program test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program: any = new anchor.Program(idl as any, provider);

  let usdcMint: PublicKey;
  let admin: Keypair;
  let arbiter: Keypair;
  let providerWallet: Keypair;
  let providerTokenAccount: PublicKey;
  let buyerWallet: Keypair;
  let buyerTokenAccount: PublicKey;
  let attackerWallet: Keypair;
  let attackerTokenAccount: PublicKey;

  let configPda: PublicKey;
  let vaultPda: PublicKey;
  let providerPda: PublicKey;

  let dispute101Receipt: ReceiptData;
  let dispute201Receipt: ReceiptData;

  const PROVIDER_SPEC_HASH = crypto.createHash("sha256").update("test-spec-v1").digest();
  const DISPUTE_WINDOW = new BN(15); // 15 seconds
  const RESOLVE_TIMEOUT = new BN(3); // 3 seconds
  const WITHDRAW_DELAY = new BN(3);  // 3 seconds
  const PAYOUT_CAP = new BN(50_000_000); // 50 USDC cap (6 decimals)
  const DISPUTE_DEPOSIT = new BN(1_000_000); // 1 USDC deposit
  const MAX_OPEN_DISPUTES = 3;

  const INITIAL_BOND = new BN(100_000_000); // 100 USDC
  const TOP_UP_BOND = new BN(50_000_000);   // 50 USDC

  async function waitForTimestamp(targetTime: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const slot = await provider.connection.getSlot();
      const blockTime = await provider.connection.getBlockTime(slot);
      if (blockTime !== null && blockTime >= targetTime) {
        return;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  function createTestReceipt(opts: {
    price?: number | BN;
    timestamp?: number;
    nonce?: number;
    buyer?: PublicKey;
    providerKey?: PublicKey;
    specHash?: Buffer;
  } = {}): ReceiptData {
    return {
      version: RECEIPT_VERSION,
      provider: opts.providerKey || providerWallet.publicKey,
      buyer: opts.buyer || buyerWallet.publicKey,
      specHash: opts.specHash || PROVIDER_SPEC_HASH,
      requestHash: crypto.createHash("sha256").update("request-test").digest(),
      responseHash: crypto.createHash("sha256").update("response-test").digest(),
      paymentReference: Buffer.alloc(64, 7),
      price: opts.price !== undefined ? new BN(opts.price.toString()) : new BN(20_000_000), // 20 USDC
      timestamp: new BN(opts.timestamp !== undefined ? opts.timestamp : Math.floor(Date.now() / 1000)),
      nonce: new BN(opts.nonce !== undefined ? opts.nonce : 1),
    };
  }

  async function sendTx(tx: Transaction, signers: Keypair[]): Promise<string> {
    tx.feePayer = signers[0].publicKey;
    return await anchor.web3.sendAndConfirmTransaction(provider.connection, tx, signers);
  }

  function getBuyerRecordPda(buyerKey: PublicKey, providerKey: PublicKey = providerWallet.publicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("buyer_record"), providerKey.toBuffer(), buyerKey.toBuffer()],
      program.programId
    )[0];
  }

  const ARBITER_SEED = crypto.createHash("sha256").update("justice402-shared-test-arbiter").digest().subarray(0, 32);

  before(async () => {
    admin = (provider.wallet as any).payer;
    arbiter = Keypair.fromSeed(ARBITER_SEED);
    providerWallet = Keypair.generate();
    buyerWallet = Keypair.generate();
    attackerWallet = Keypair.generate();

    // Airdrop SOL to test actors
    for (const kp of [arbiter, providerWallet, buyerWallet, attackerWallet]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      });
    }

    // Create mock USDC mint (6 decimals)
    usdcMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Derive Program PDAs
    [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
    [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), configPda.toBuffer()], program.programId);
    [providerPda] = PublicKey.findProgramAddressSync([Buffer.from("provider"), providerWallet.publicKey.toBuffer()], program.programId);

    // Create Token Accounts
    providerTokenAccount = await createAccount(provider.connection, admin, usdcMint, providerWallet.publicKey);
    buyerTokenAccount = await createAccount(provider.connection, admin, usdcMint, buyerWallet.publicKey);
    attackerTokenAccount = await createAccount(provider.connection, admin, usdcMint, attackerWallet.publicKey);

    // Fund provider with 500 USDC
    await mintTo(provider.connection, admin, usdcMint, providerTokenAccount, admin, 500_000_000);
    await mintTo(provider.connection, admin, usdcMint, buyerTokenAccount, admin, 100_000_000);
    await mintTo(provider.connection, admin, usdcMint, attackerTokenAccount, admin, 100_000_000);
  });

  it("1. Initializes program config and vault PDA", async () => {
    await program.methods
      .initialize(
        arbiter.publicKey,
        DISPUTE_WINDOW,
        RESOLVE_TIMEOUT,
        WITHDRAW_DELAY,
        PAYOUT_CAP,
        DISPUTE_DEPOSIT,
        MAX_OPEN_DISPUTES
      )
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        usdcMint,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const configAccount: any = await program.account.config.fetch(configPda);
    expect(configAccount.arbiter.toBase58()).to.equal(arbiter.publicKey.toBase58());
    expect(configAccount.usdcMint.toBase58()).to.equal(usdcMint.toBase58());
    expect(configAccount.disputeWindow.toString()).to.equal(DISPUTE_WINDOW.toString());
    expect(configAccount.resolveTimeout.toString()).to.equal(RESOLVE_TIMEOUT.toString());
    expect(configAccount.withdrawDelay.toString()).to.equal(WITHDRAW_DELAY.toString());
    expect(configAccount.perRulingPayoutCap.toString()).to.equal(PAYOUT_CAP.toString());

    const vaultInfo = await getAccount(provider.connection, vaultPda);
    expect(vaultInfo.mint.toBase58()).to.equal(usdcMint.toBase58());
    expect(vaultInfo.owner.toBase58()).to.equal(vaultPda.toBase58());
  });

  it("2. Registers provider with spec_hash, track record counters, and deposits initial bond", async () => {
    await program.methods
      .registerProvider(INITIAL_BOND, Array.from(PROVIDER_SPEC_HASH))
      .accounts({
        providerWallet: providerWallet.publicKey,
        provider: providerPda,
        config: configPda,
        vault: vaultPda,
        providerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([providerWallet])
      .rpc();

    const providerAccount: any = await program.account.provider.fetch(providerPda);
    expect(providerAccount.wallet.toBase58()).to.equal(providerWallet.publicKey.toBase58());
    expect(providerAccount.bond.toString()).to.equal(INITIAL_BOND.toString());
    expect(providerAccount.locked.toString()).to.equal("0");
    expect(providerAccount.withdrawRequestedAt.toString()).to.equal("0");
    expect(Buffer.from(providerAccount.specHash).toString("hex")).to.equal(PROVIDER_SPEC_HASH.toString("hex"));
    expect(providerAccount.openDisputes.toString()).to.equal("0");
    expect(providerAccount.disputesBuyerWon.toString()).to.equal("0");
    expect(providerAccount.disputesProviderWon.toString()).to.equal("0");
    expect(providerAccount.totalSlashed.toString()).to.equal("0");

    const vaultAccount = await getAccount(provider.connection, vaultPda);
    expect(vaultAccount.amount.toString()).to.equal(INITIAL_BOND.toString());

    // Test getProviderTrust client function
    const trust = await getProviderTrust(program, providerWallet.publicKey);
    expect(trust.wallet.toBase58()).to.equal(providerWallet.publicKey.toBase58());
    expect(trust.bond.toString()).to.equal(INITIAL_BOND.toString());
    expect(trust.locked.toString()).to.equal("0");
    expect(trust.openDisputes.toString()).to.equal("0");
    expect(trust.wins.toString()).to.equal("0");
    expect(trust.losses.toString()).to.equal("0");
    expect(trust.totalSlashed.toString()).to.equal("0");
    expect(trust.specHash.toString("hex")).to.equal(PROVIDER_SPEC_HASH.toString("hex"));
  });

  it("3. Tops up provider bond and resets pending withdrawal", async () => {
    await program.methods
      .topUp(TOP_UP_BOND)
      .accounts({
        providerWallet: providerWallet.publicKey,
        provider: providerPda,
        config: configPda,
        vault: vaultPda,
        providerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([providerWallet])
      .rpc();

    const providerAccount: any = await program.account.provider.fetch(providerPda);
    const expectedBond = INITIAL_BOND.add(TOP_UP_BOND);
    expect(providerAccount.bond.toString()).to.equal(expectedBond.toString());

    const vaultAccount = await getAccount(provider.connection, vaultPda);
    expect(vaultAccount.amount.toString()).to.equal(expectedBond.toString());
  });

  it("4. Opens dispute with valid Ed25519 signature instruction introspection", async () => {
    dispute101Receipt = createTestReceipt({ nonce: 101, timestamp: Math.floor(Date.now() / 1000) });
    const canonicalBytes = encodeReceipt(dispute101Receipt);
    const receiptHash = hashReceipt(canonicalBytes);
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    const sig = signEd25519(canonicalBytes, providerWallet.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: providerWallet.publicKey.toBytes(),
      message: canonicalBytes,
      signature: sig,
    });

    const openIx = await program.methods
      .openDispute(toAnchorReceipt(dispute101Receipt), Array.from(Buffer.alloc(32, 1)))
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
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
    await sendTx(tx, [buyerWallet]);

    const disputeAccount: any = await program.account.dispute.fetch(disputePda);
    expect(disputeAccount.buyer.toBase58()).to.equal(buyerWallet.publicKey.toBase58());
    expect(disputeAccount.provider.toBase58()).to.equal(providerWallet.publicKey.toBase58());
    expect(Buffer.from(disputeAccount.specHash).toString("hex")).to.equal(PROVIDER_SPEC_HASH.toString("hex"));
    expect(disputeAccount.claimAmount.toString()).to.equal("20000000");
    expect(disputeAccount.status.open).to.not.be.undefined;

    const providerAccount: any = await program.account.provider.fetch(providerPda);
    expect(providerAccount.locked.toString()).to.equal("20000000");
    expect(providerAccount.openDisputes.toString()).to.equal("1");
  });

  it("4b. Rejects dispute opening when receipt spec_hash does not match provider spec_hash", async () => {
    const wrongSpecHash = crypto.createHash("sha256").update("different-spec-content").digest();
    const mismatchedReceipt = createTestReceipt({ nonce: 1012, specHash: wrongSpecHash });
    const canonicalBytes = encodeReceipt(mismatchedReceipt);
    const receiptHash = hashReceipt(canonicalBytes);
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    const sig = signEd25519(canonicalBytes, providerWallet.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: providerWallet.publicKey.toBytes(),
      message: canonicalBytes,
      signature: sig,
    });

    const openIx = await program.methods
      .openDispute(toAnchorReceipt(mismatchedReceipt), Array.from(Buffer.alloc(32, 1)))
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
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
    let capturedErr: any = null;
    try {
      await sendTx(tx, [buyerWallet]);
    } catch (err: any) {
      capturedErr = err;
    }
    expect(capturedErr, "SpecHashMismatch must fail").to.not.be.null;
    expect(getErrorMessage(capturedErr)).to.include("SpecHashMismatch");
  });

  it("5. Rejects duplicate dispute opening with identical receipt", async () => {
    const canonicalBytes = encodeReceipt(dispute101Receipt);
    const receiptHash = hashReceipt(canonicalBytes);
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    const sig = signEd25519(canonicalBytes, providerWallet.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: providerWallet.publicKey.toBytes(),
      message: canonicalBytes,
      signature: sig,
    });

    const openIx = await program.methods
      .openDispute(toAnchorReceipt(dispute101Receipt), Array.from(Buffer.alloc(32, 1)))
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
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
    let capturedErr: any = null;
    try {
      await sendTx(tx, [buyerWallet]);
    } catch (err: any) {
      capturedErr = err;
    }
    expect(capturedErr, "Duplicate dispute must fail").to.not.be.null;
    expect(getErrorMessage(capturedErr)).to.match(/already in use|custom program error|0x0|Simulation failed/);
  });

  it("6. Rejects Ed25519 verification with wrong message", async () => {
    const receipt = createTestReceipt({ nonce: 102 });
    const canonicalBytes = encodeReceipt(receipt);
    const receiptHash = hashReceipt(canonicalBytes);
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    // Sign a 249-byte message that differs from canonical receipt
    const wrongMessage = Buffer.from(canonicalBytes);
    wrongMessage[wrongMessage.length - 1] ^= 0xff; // flip last byte
    const sig = signEd25519(wrongMessage, providerWallet.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: providerWallet.publicKey.toBytes(),
      message: wrongMessage,
      signature: sig,
    });

    const openIx = await program.methods
      .openDispute(toAnchorReceipt(receipt), Array.from(Buffer.alloc(32, 1)))
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
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
    let capturedErr: any = null;
    try {
      await sendTx(tx, [buyerWallet]);
    } catch (err: any) {
      capturedErr = err;
    }
    expect(capturedErr, "WrongMessage must fail").to.not.be.null;
    expect(getErrorMessage(capturedErr)).to.include("WrongMessage");
  });

  it("7. Rejects Ed25519 verification with wrong signer (attacker)", async () => {
    const receipt = createTestReceipt({ nonce: 103 });
    const canonicalBytes = encodeReceipt(receipt);
    const receiptHash = hashReceipt(canonicalBytes);
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    // Attacker signs instead of provider
    const sig = signEd25519(canonicalBytes, attackerWallet.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: attackerWallet.publicKey.toBytes(),
      message: canonicalBytes,
      signature: sig,
    });

    const openIx = await program.methods
      .openDispute(toAnchorReceipt(receipt), Array.from(Buffer.alloc(32, 1)))
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
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
    let capturedErr: any = null;
    try {
      await sendTx(tx, [buyerWallet]);
    } catch (err: any) {
      capturedErr = err;
    }
    expect(capturedErr, "WrongSigner must fail").to.not.be.null;
    expect(getErrorMessage(capturedErr)).to.include("WrongSigner");
  });

  it("7b. Rejects Ed25519 verification with corrupted signature bytes", async () => {
    const receipt = createTestReceipt({ nonce: 1032 });
    const canonicalBytes = encodeReceipt(receipt);
    const receiptHash = hashReceipt(canonicalBytes);
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    const validSig = signEd25519(canonicalBytes, providerWallet.secretKey);
    const corruptedSig = Buffer.from(validSig);
    corruptedSig[0] ^= 0xff; // Corrupt signature byte

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: providerWallet.publicKey.toBytes(),
      message: canonicalBytes,
      signature: corruptedSig,
    });

    const openIx = await program.methods
      .openDispute(toAnchorReceipt(receipt), Array.from(Buffer.alloc(32, 1)))
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
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
    let capturedErr: any = null;
    try {
      await sendTx(tx, [buyerWallet]);
    } catch (err: any) {
      capturedErr = err;
    }
    expect(capturedErr, "Transaction should fail with corrupted signature").to.not.be.null;

    const disputeAccount = await program.account.dispute.fetchNullable(disputePda);
    expect(disputeAccount).to.be.null;
  });

  it("8. Rejects open_dispute when Ed25519 instruction is missing", async () => {
    const receipt = createTestReceipt({ nonce: 104 });
    const canonicalBytes = encodeReceipt(receipt);
    const receiptHash = hashReceipt(canonicalBytes);
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    const openIx = await program.methods
      .openDispute(toAnchorReceipt(receipt), Array.from(Buffer.alloc(32, 1)))
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
        dispute: disputePda,
        config: configPda,
        vault: vaultPda,
        buyerTokenAccount,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(openIx);
    let capturedErr: any = null;
    try {
      await sendTx(tx, [buyerWallet]);
    } catch (err: any) {
      capturedErr = err;
    }
    expect(capturedErr, "MissingEd25519Instruction must fail").to.not.be.null;
    expect(getErrorMessage(capturedErr)).to.include("MissingEd25519Instruction");
  });

  it("9. Rejects tampered Ed25519 instruction offsets", async () => {
    const receipt = createTestReceipt({ nonce: 105 });
    const canonicalBytes = encodeReceipt(receipt);
    const receiptHash = hashReceipt(canonicalBytes);
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    const sig = signEd25519(canonicalBytes, providerWallet.secretKey);
    const validEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: providerWallet.publicKey.toBytes(),
      message: canonicalBytes,
      signature: sig,
    });

    // Clone data and tamper msg_ix_idx (byte 14-15) from 0xffff to 0x0000 (cross-instruction offset)
    const tamperedData = Buffer.from(validEd25519Ix.data);
    tamperedData.writeUInt16LE(0, 14); // msg_ix_idx = 0 instead of 0xffff

    const tamperedEd25519Ix = new TransactionInstruction({
      programId: Ed25519Program.programId,
      keys: [],
      data: tamperedData,
    });

    const openIx = await program.methods
      .openDispute(toAnchorReceipt(receipt), Array.from(Buffer.alloc(32, 1)))
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
        dispute: disputePda,
        config: configPda,
        vault: vaultPda,
        buyerTokenAccount,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(tamperedEd25519Ix).add(openIx);
    let capturedErr: any = null;
    try {
      await sendTx(tx, [buyerWallet]);
    } catch (err: any) {
      capturedErr = err;
    }
    expect(capturedErr, "InvalidEd25519Offset must fail").to.not.be.null;
    expect(getErrorMessage(capturedErr)).to.include("InvalidEd25519Offset");
  });

  it("10. Rejects dispute opening after window expiry", async () => {
    // Timestamp 100 seconds in the past (> DISPUTE_WINDOW of 15s)
    const oldTimestamp = Math.floor(Date.now() / 1000) - 100;
    const receipt = createTestReceipt({ nonce: 106, timestamp: oldTimestamp });
    const canonicalBytes = encodeReceipt(receipt);
    const receiptHash = hashReceipt(canonicalBytes);
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    const sig = signEd25519(canonicalBytes, providerWallet.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: providerWallet.publicKey.toBytes(),
      message: canonicalBytes,
      signature: sig,
    });

    const openIx = await program.methods
      .openDispute(toAnchorReceipt(receipt), Array.from(Buffer.alloc(32, 1)))
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
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
    let capturedErr: any = null;
    try {
      await sendTx(tx, [buyerWallet]);
    } catch (err: any) {
      capturedErr = err;
    }
    expect(capturedErr, "WindowExpired must fail").to.not.be.null;
    expect(getErrorMessage(capturedErr)).to.include("WindowExpired");
  });

  it("10b. Rejects dispute opening with future timestamp exceeding clock skew allowance", async () => {
    // Timestamp 500 seconds in the future (> 60s max permitted skew)
    const futureTimestamp = Math.floor(Date.now() / 1000) + 500;
    const receipt = createTestReceipt({ nonce: 1062, timestamp: futureTimestamp });
    const canonicalBytes = encodeReceipt(receipt);
    const receiptHash = hashReceipt(canonicalBytes);
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    const sig = signEd25519(canonicalBytes, providerWallet.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: providerWallet.publicKey.toBytes(),
      message: canonicalBytes,
      signature: sig,
    });

    const openIx = await program.methods
      .openDispute(toAnchorReceipt(receipt), Array.from(Buffer.alloc(32, 1)))
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
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
    let capturedErr: any = null;
    try {
      await sendTx(tx, [buyerWallet]);
    } catch (err: any) {
      capturedErr = err;
    }
    expect(capturedErr, "Future timestamp must fail").to.not.be.null;
    expect(getErrorMessage(capturedErr)).to.include("InvalidReceipt");
  });

  it("11. Rejects non-buyer caller opening dispute", async () => {
    const receipt = createTestReceipt({ nonce: 107 });
    const canonicalBytes = encodeReceipt(receipt);
    const receiptHash = hashReceipt(canonicalBytes);
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    const sig = signEd25519(canonicalBytes, providerWallet.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: providerWallet.publicKey.toBytes(),
      message: canonicalBytes,
      signature: sig,
    });

    const openIx = await program.methods
      .openDispute(toAnchorReceipt(receipt), Array.from(Buffer.alloc(32, 1)))
      .accounts({
        buyer: attackerWallet.publicKey, // ATTACKER CALLER!
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(attackerWallet.publicKey),
        dispute: disputePda,
        config: configPda,
        vault: vaultPda,
        buyerTokenAccount: attackerTokenAccount,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(openIx);
    let capturedErr: any = null;
    try {
      await sendTx(tx, [attackerWallet]);
    } catch (err: any) {
      capturedErr = err;
    }
    expect(capturedErr, "UnauthorizedBuyer must fail").to.not.be.null;
    expect(getErrorMessage(capturedErr)).to.include("UnauthorizedBuyer");
  });

  it("12. Enforces per_ruling_payout_cap when receipt price exceeds cap", async () => {
    // Price = 90 USDC, which exceeds PAYOUT_CAP of 50 USDC
    const highPrice = new BN(90_000_000);
    dispute201Receipt = createTestReceipt({
      nonce: 201,
      price: highPrice,
      timestamp: Math.floor(Date.now() / 1000),
    });
    const canonicalBytes = encodeReceipt(dispute201Receipt);
    const receiptHash = hashReceipt(canonicalBytes);
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    const sig = signEd25519(canonicalBytes, providerWallet.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: providerWallet.publicKey.toBytes(),
      message: canonicalBytes,
      signature: sig,
    });

    const openIx = await program.methods
      .openDispute(toAnchorReceipt(dispute201Receipt), Array.from(Buffer.alloc(32, 2)))
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
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
    await sendTx(tx, [buyerWallet]);

    const disputeAccount: any = await program.account.dispute.fetch(disputePda);
    expect(disputeAccount.price.toString()).to.equal("90000000");
    // Claim amount must be capped at 50 USDC (PAYOUT_CAP)
    expect(disputeAccount.claimAmount.toString()).to.equal(PAYOUT_CAP.toString());
    expect(Buffer.from(disputeAccount.specHash).toString("hex")).to.equal(PROVIDER_SPEC_HASH.toString("hex"));
  });

  it("13. Arbiter resolves dispute: BuyerWins pays refund up to cap and updates track record", async () => {
    const receiptHash = hashReceipt(encodeReceipt(dispute201Receipt));
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    const buyerTokenBefore = await getAccount(provider.connection, buyerTokenAccount);
    const providerAccountBefore: any = await program.account.provider.fetch(providerPda);

    const rulingHash = Array.from(crypto.createHash("sha256").update("ruling-buyer-wins").digest());

    await program.methods
      .resolveDispute({ buyerWins: {} }, rulingHash)
      .accounts({
        arbiter: arbiter.publicKey,
        config: configPda,
        dispute: disputePda,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
        vault: vaultPda,
        buyerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([arbiter])
      .rpc();

    const disputeAccount: any = await program.account.dispute.fetch(disputePda);
    expect(disputeAccount.status.buyerWins).to.not.be.undefined;

    const buyerTokenAfter = await getAccount(provider.connection, buyerTokenAccount);
    const diff = new BN(buyerTokenAfter.amount.toString()).sub(new BN(buyerTokenBefore.amount.toString()));
    // Buyer receives capped 50 USDC + returned 1 USDC deposit
    expect(diff.toString()).to.equal(PAYOUT_CAP.add(DISPUTE_DEPOSIT).toString());

    const providerAccountAfter: any = await program.account.provider.fetch(providerPda);
    const expectedBond = new BN(providerAccountBefore.bond.toString()).sub(PAYOUT_CAP);
    const expectedLocked = new BN(providerAccountBefore.locked.toString()).sub(PAYOUT_CAP);
    expect(providerAccountAfter.bond.toString()).to.equal(expectedBond.toString());
    expect(providerAccountAfter.locked.toString()).to.equal(expectedLocked.toString());

    // Track record counters
    expect(providerAccountAfter.openDisputes.toString()).to.equal("1"); // 101 is still open
    expect(providerAccountAfter.disputesBuyerWon.toString()).to.equal("1");
    expect(providerAccountAfter.totalSlashed.toString()).to.equal(PAYOUT_CAP.toString());
  });

  it("14. Rejects resolve_dispute by unauthorized non-arbiter", async () => {
    const receiptHash = hashReceipt(encodeReceipt(dispute101Receipt));
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    let capturedErr: any = null;
    try {
      await program.methods
        .resolveDispute({ buyerWins: {} }, Array.from(Buffer.alloc(32, 9)))
        .accounts({
          arbiter: attackerWallet.publicKey, // ATTACKER!
          config: configPda,
          dispute: disputePda,
          provider: providerPda,
          buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
          vault: vaultPda,
          buyerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([attackerWallet])
        .rpc();
    } catch (err: any) {
      capturedErr = err;
    }
    expect(capturedErr, "UnauthorizedArbiter must fail").to.not.be.null;
    expect(getErrorMessage(capturedErr)).to.include("UnauthorizedArbiter");
  });

  it("15. Rejects double resolve on an already resolved dispute", async () => {
    // Dispute 201 was resolved in test 13
    const receiptHash = hashReceipt(encodeReceipt(dispute201Receipt));
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    let capturedErr: any = null;
    try {
      await program.methods
        .resolveDispute({ buyerWins: {} }, Array.from(Buffer.alloc(32, 9)))
        .accounts({
          arbiter: arbiter.publicKey,
          config: configPda,
          dispute: disputePda,
          provider: providerPda,
          buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
          vault: vaultPda,
          buyerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([arbiter])
        .rpc();
    } catch (err: any) {
      capturedErr = err;
    }
    expect(capturedErr, "DisputeNotOpen must fail").to.not.be.null;
    expect(getErrorMessage(capturedErr)).to.include("DisputeNotOpen");
  });

  it("16. Arbiter resolves ProviderWins: unlocks bond without buyer payout, updates provider wins", async () => {
    // Open dispute 108 for 20 USDC and immediately resolve ProviderWins before timeout
    const receipt108 = createTestReceipt({ nonce: 108, price: new BN(20_000_000) });
    const canonicalBytes = encodeReceipt(receipt108);
    const receiptHash = hashReceipt(canonicalBytes);
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    const sig = signEd25519(canonicalBytes, providerWallet.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: providerWallet.publicKey.toBytes(),
      message: canonicalBytes,
      signature: sig,
    });

    const openIx = await program.methods
      .openDispute(toAnchorReceipt(receipt108), Array.from(Buffer.alloc(32, 8)))
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
        dispute: disputePda,
        config: configPda,
        vault: vaultPda,
        buyerTokenAccount,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    await sendTx(new Transaction().add(ed25519Ix).add(openIx), [buyerWallet]);

    const buyerTokenBefore = await getAccount(provider.connection, buyerTokenAccount);
    const providerAccountBefore: any = await program.account.provider.fetch(providerPda);
    expect(providerAccountBefore.openDisputes.toString()).to.equal("2"); // 101 and 108

    await program.methods
      .resolveDispute({ providerWins: {} }, Array.from(Buffer.alloc(32, 8)))
      .accounts({
        arbiter: arbiter.publicKey,
        config: configPda,
        dispute: disputePda,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
        vault: vaultPda,
        buyerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([arbiter])
      .rpc();

    const disputeAccount: any = await program.account.dispute.fetch(disputePda);
    expect(disputeAccount.status.providerWins).to.not.be.undefined;

    // Buyer received nothing
    const buyerTokenAfter = await getAccount(provider.connection, buyerTokenAccount);
    expect(buyerTokenAfter.amount.toString()).to.equal(buyerTokenBefore.amount.toString());

    // Provider bond credited with forfeited dispute deposit, locked decreased by 20 USDC
    const providerAccountAfter: any = await program.account.provider.fetch(providerPda);
    const expectedBond = new BN(providerAccountBefore.bond.toString()).add(DISPUTE_DEPOSIT);
    expect(providerAccountAfter.bond.toString()).to.equal(expectedBond.toString());
    const expectedLocked = new BN(providerAccountBefore.locked.toString()).sub(new BN(20_000_000));
    expect(providerAccountAfter.locked.toString()).to.equal(expectedLocked.toString());

    // Track record: providerWins incremented to 1, openDisputes decremented to 1
    expect(providerAccountAfter.openDisputes.toString()).to.equal("1");
    expect(providerAccountAfter.disputesProviderWon.toString()).to.equal("1");
  });

  it("17. Timeout refund: buyer claims refund if arbiter is silent past timeout, arbiter rejected after timeout", async () => {
    // Open dispute 301 for 15 USDC
    const receipt = createTestReceipt({ nonce: 301, price: new BN(15_000_000) });
    const canonicalBytes = encodeReceipt(receipt);
    const receiptHash = hashReceipt(canonicalBytes);
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    const sig = signEd25519(canonicalBytes, providerWallet.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: providerWallet.publicKey.toBytes(),
      message: canonicalBytes,
      signature: sig,
    });

    const openIx = await program.methods
      .openDispute(toAnchorReceipt(receipt), Array.from(Buffer.alloc(32, 3)))
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
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
    await sendTx(tx, [buyerWallet]);

    const disputeAccountBefore: any = await program.account.dispute.fetch(disputePda);
    const deadline = Number(disputeAccountBefore.openedAt.toString()) + Number(RESOLVE_TIMEOUT.toString());

    // Calling claim_timeout immediately should fail with TimeoutNotReached
    let earlyErr: any = null;
    try {
      await program.methods
        .claimTimeout()
        .accounts({
          caller: buyerWallet.publicKey,
          config: configPda,
          dispute: disputePda,
          provider: providerPda,
          buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
          vault: vaultPda,
          buyerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyerWallet])
        .rpc();
    } catch (err: any) {
      earlyErr = err;
    }
    expect(earlyErr, "Should fail before timeout").to.not.be.null;
    expect(getErrorMessage(earlyErr)).to.include("TimeoutNotReached");

    // Wait until chain time >= deadline
    await waitForTimestamp(deadline);

    // Arbiter trying to resolve after deadline should fail with ResolveTimeoutElapsed
    let arbiterLateErr: any = null;
    try {
      await program.methods
        .resolveDispute({ buyerWins: {} }, Array.from(Buffer.alloc(32, 9)))
        .accounts({
          arbiter: arbiter.publicKey,
          config: configPda,
          dispute: disputePda,
          provider: providerPda,
          buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
          vault: vaultPda,
          buyerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([arbiter])
        .rpc();
    } catch (err: any) {
      arbiterLateErr = err;
    }
    expect(arbiterLateErr, "Arbiter should fail after timeout deadline").to.not.be.null;
    expect(getErrorMessage(arbiterLateErr)).to.include("ResolveTimeoutElapsed");

    const buyerTokenBefore = await getAccount(provider.connection, buyerTokenAccount);
    const providerAccountBefore: any = await program.account.provider.fetch(providerPda);

    // Call claim_timeout past timeout deadline
    await program.methods
      .claimTimeout()
      .accounts({
        caller: buyerWallet.publicKey,
        config: configPda,
        dispute: disputePda,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
        vault: vaultPda,
        buyerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyerWallet])
      .rpc();

    const disputeAccount: any = await program.account.dispute.fetch(disputePda);
    expect(disputeAccount.status.timedOut).to.not.be.undefined;

    const buyerTokenAfter = await getAccount(provider.connection, buyerTokenAccount);
    const diff = new BN(buyerTokenAfter.amount.toString()).sub(new BN(buyerTokenBefore.amount.toString()));
    // Price refund (15 USDC) + returned deposit (1 USDC)
    expect(diff.toString()).to.equal(new BN(15_000_000).add(DISPUTE_DEPOSIT).toString());

    const providerAccountAfter: any = await program.account.provider.fetch(providerPda);
    // Timeout refund increments disputes_timed_out; does NOT increment disputes_buyer_won or total_slashed
    expect(providerAccountAfter.disputesTimedOut.toString()).to.equal("1");
    expect(providerAccountAfter.disputesBuyerWon.toString()).to.equal(providerAccountBefore.disputesBuyerWon.toString());
    expect(providerAccountAfter.totalSlashed.toString()).to.equal(providerAccountBefore.totalSlashed.toString());
  });

  it("17b. Permissionless timeout refund: independent caller triggers settlement, buyer receives refund", async () => {
    // Open dispute 302 for 10 USDC
    const receipt = createTestReceipt({ nonce: 302, price: new BN(10_000_000) });
    const canonicalBytes = encodeReceipt(receipt);
    const receiptHash = hashReceipt(canonicalBytes);
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    const sig = signEd25519(canonicalBytes, providerWallet.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: providerWallet.publicKey.toBytes(),
      message: canonicalBytes,
      signature: sig,
    });

    const openIx = await program.methods
      .openDispute(toAnchorReceipt(receipt), Array.from(Buffer.alloc(32, 32)))
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
        dispute: disputePda,
        config: configPda,
        vault: vaultPda,
        buyerTokenAccount,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    await sendTx(new Transaction().add(ed25519Ix).add(openIx), [buyerWallet]);

    const disputeAccountBefore: any = await program.account.dispute.fetch(disputePda);
    const deadline = Number(disputeAccountBefore.openedAt.toString()) + Number(RESOLVE_TIMEOUT.toString());
    await waitForTimestamp(deadline);

    const buyerTokenBefore = await getAccount(provider.connection, buyerTokenAccount);
    const attackerTokenBefore = await getAccount(provider.connection, attackerTokenAccount);

    // Permissionless caller: ATTACKER / UNRELATED CALLER triggers settlement!
    await program.methods
      .claimTimeout()
      .accounts({
        caller: attackerWallet.publicKey,
        config: configPda,
        dispute: disputePda,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
        vault: vaultPda,
        buyerTokenAccount, // strictly bound to dispute.buyer
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([attackerWallet])
      .rpc();

    const disputeAccountAfter: any = await program.account.dispute.fetch(disputePda);
    expect(disputeAccountAfter.status.timedOut).to.not.be.undefined;

    // Buyer receives the 10 USDC claim + 1 USDC deposit
    const buyerTokenAfter = await getAccount(provider.connection, buyerTokenAccount);
    const diff = new BN(buyerTokenAfter.amount.toString()).sub(new BN(buyerTokenBefore.amount.toString()));
    expect(diff.toString()).to.equal(new BN(10_000_000).add(DISPUTE_DEPOSIT).toString());

    // Attacker received nothing
    const attackerTokenAfter = await getAccount(provider.connection, attackerTokenAccount);
    expect(attackerTokenAfter.amount.toString()).to.equal(attackerTokenBefore.amount.toString());
  });

  it("17c. Enforces open dispute cap per buyer per provider (max 3)", async () => {
    // Current open disputes for buyerWallet: let us check
    const buyerRecordBefore: any = await program.account.buyerRecord.fetchNullable(getBuyerRecordPda(buyerWallet.publicKey));
    const currentOpen = buyerRecordBefore ? buyerRecordBefore.openDisputes : 0;

    // Open disputes until cap of 3 is reached
    const addedReceipts = [];
    for (let i = currentOpen; i < MAX_OPEN_DISPUTES; i++) {
      const r = createTestReceipt({ nonce: 900 + i, price: new BN(1_000_000) });
      const cBytes = encodeReceipt(r);
      const rHash = hashReceipt(cBytes);
      const [dPda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), rHash], program.programId);
      const sig = signEd25519(cBytes, providerWallet.secretKey);
      const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
        publicKey: providerWallet.publicKey.toBytes(),
        message: cBytes,
        signature: sig,
      });
      const openIx = await program.methods
        .openDispute(toAnchorReceipt(r), Array.from(Buffer.alloc(32, 90 + i)))
        .accounts({
          buyer: buyerWallet.publicKey,
          provider: providerPda,
          buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
          dispute: dPda,
          config: configPda,
          vault: vaultPda,
          buyerTokenAccount,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      await sendTx(new Transaction().add(ed25519Ix).add(openIx), [buyerWallet]);
      addedReceipts.push({ r, dPda });
    }

    // Now buyer has exactly 3 open disputes. Opening the 4th dispute MUST fail with TooManyOpenDisputes!
    const exceedingReceipt = createTestReceipt({ nonce: 999, price: new BN(1_000_000) });
    const cBytes = encodeReceipt(exceedingReceipt);
    const rHash = hashReceipt(cBytes);
    const [dPdaExceeding] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), rHash], program.programId);
    const sigExceeding = signEd25519(cBytes, providerWallet.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: providerWallet.publicKey.toBytes(),
      message: cBytes,
      signature: sigExceeding,
    });
    const openIx = await program.methods
      .openDispute(toAnchorReceipt(exceedingReceipt), Array.from(Buffer.alloc(32, 99)))
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
        dispute: dPdaExceeding,
        config: configPda,
        vault: vaultPda,
        buyerTokenAccount,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    let capErr: any = null;
    try {
      await sendTx(new Transaction().add(ed25519Ix).add(openIx), [buyerWallet]);
    } catch (err: any) {
      capErr = err;
    }
    expect(capErr, "Opening dispute beyond cap must fail").to.not.be.null;
    expect(getErrorMessage(capErr)).to.include("TooManyOpenDisputes");

    // Clear the added disputes so subsequent tests have room
    for (const item of addedReceipts) {
      await program.methods
        .resolveDispute({ providerWins: {} }, Array.from(Buffer.alloc(32, 0)))
        .accounts({
          arbiter: arbiter.publicKey,
          config: configPda,
          dispute: item.dPda,
          provider: providerPda,
          buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
          vault: vaultPda,
          buyerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([arbiter])
        .rpc();
    }
  });

  it("18. Withdraw restrictions: blocked while funds are locked in active disputes", async () => {
    // Open dispute 401 for 10 USDC
    const receipt = createTestReceipt({ nonce: 401, price: new BN(10_000_000) });
    const canonicalBytes = encodeReceipt(receipt);
    const receiptHash = hashReceipt(canonicalBytes);
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    const sig = signEd25519(canonicalBytes, providerWallet.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: providerWallet.publicKey.toBytes(),
      message: canonicalBytes,
      signature: sig,
    });

    const openIx = await program.methods
      .openDispute(toAnchorReceipt(receipt), Array.from(Buffer.alloc(32, 4)))
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
        dispute: disputePda,
        config: configPda,
        vault: vaultPda,
        buyerTokenAccount,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    await sendTx(new Transaction().add(ed25519Ix).add(openIx), [buyerWallet]);

    // Provider has locked funds: request_withdraw should fail
    let reqErr: any = null;
    try {
      await program.methods
        .requestWithdraw()
        .accounts({
          providerWallet: providerWallet.publicKey,
          provider: providerPda,
        })
        .signers([providerWallet])
        .rpc();
    } catch (err: any) {
      reqErr = err;
    }
    expect(reqErr, "requestWithdraw should fail when locked").to.not.be.null;
    expect(getErrorMessage(reqErr)).to.include("BondLocked");

    // withdraw_bond should also fail
    let withErr: any = null;
    try {
      await program.methods
        .withdrawBond(new BN(10_000_000))
        .accounts({
          providerWallet: providerWallet.publicKey,
          provider: providerPda,
          config: configPda,
          vault: vaultPda,
          providerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([providerWallet])
        .rpc();
    } catch (err: any) {
      withErr = err;
    }
    expect(withErr, "withdrawBond should fail when locked").to.not.be.null;
    expect(getErrorMessage(withErr)).to.include("BondLocked");

    // Resolve dispute 401
    await program.methods
      .resolveDispute({ providerWins: {} }, Array.from(Buffer.alloc(32, 4)))
      .accounts({
        arbiter: arbiter.publicKey,
        config: configPda,
        dispute: disputePda,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
        vault: vaultPda,
        buyerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([arbiter])
      .rpc();

    // Also resolve dispute 101 from test 4 to clear all remaining open disputes
    const receipt101Hash = hashReceipt(encodeReceipt(dispute101Receipt));
    const [dispute101Pda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receipt101Hash], program.programId);
    await program.methods
      .claimTimeout()
      .accounts({
        caller: buyerWallet.publicKey,
        config: configPda,
        dispute: dispute101Pda,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
        vault: vaultPda,
        buyerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyerWallet])
      .rpc();

    const providerFinal: any = await program.account.provider.fetch(providerPda);
    expect(providerFinal.locked.toString()).to.equal("0");
    expect(providerFinal.openDisputes.toString()).to.equal("0");
  });

  it("18b. Withdraw restrictions: blocked while open_disputes > 0", async () => {
    // Open dispute 501 for 0 USDC so provider.locked remains 0 but open_disputes is 1
    const zeroPriceReceipt = createTestReceipt({ nonce: 501, price: 0 });
    const canonicalBytes = encodeReceipt(zeroPriceReceipt);
    const receiptHash = hashReceipt(canonicalBytes);
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    const sig = signEd25519(canonicalBytes, providerWallet.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: providerWallet.publicKey.toBytes(),
      message: canonicalBytes,
      signature: sig,
    });

    const openIx = await program.methods
      .openDispute(toAnchorReceipt(zeroPriceReceipt), Array.from(Buffer.alloc(32, 5)))
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
        dispute: disputePda,
        config: configPda,
        vault: vaultPda,
        buyerTokenAccount,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    await sendTx(new Transaction().add(ed25519Ix).add(openIx), [buyerWallet]);

    const providerWithOpenDispute: any = await program.account.provider.fetch(providerPda);
    expect(providerWithOpenDispute.locked.toString()).to.equal("0");
    expect(providerWithOpenDispute.openDisputes.toString()).to.equal("1");

    // Request withdraw succeeds because locked == 0
    await program.methods
      .requestWithdraw()
      .accounts({
        providerWallet: providerWallet.publicKey,
        provider: providerPda,
      })
      .signers([providerWallet])
      .rpc();

    const providerRequested: any = await program.account.provider.fetch(providerPda);
    const unlockTime = Number(providerRequested.withdrawRequestedAt.toString()) + Number(WITHDRAW_DELAY.toString());
    await waitForTimestamp(unlockTime);

    // withdrawBond should fail with ActiveDisputesPending because openDisputes == 1
    let withdrawErr: any = null;
    try {
      await program.methods
        .withdrawBond(new BN(5_000_000))
        .accounts({
          providerWallet: providerWallet.publicKey,
          provider: providerPda,
          config: configPda,
          vault: vaultPda,
          providerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([providerWallet])
        .rpc();
    } catch (err: any) {
      withdrawErr = err;
    }
    expect(withdrawErr, "Withdraw should fail when open_disputes > 0").to.not.be.null;
    expect(getErrorMessage(withdrawErr)).to.include("ActiveDisputesPending");

    // Now resolve dispute 501 via claimTimeout (since resolve timeout elapsed while waiting for withdraw delay)
    await program.methods
      .claimTimeout()
      .accounts({
        caller: buyerWallet.publicKey,
        config: configPda,
        dispute: disputePda,
        provider: providerPda,
        buyerRecord: getBuyerRecordPda(buyerWallet.publicKey),
        vault: vaultPda,
        buyerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyerWallet])
      .rpc();

    const providerResolved: any = await program.account.provider.fetch(providerPda);
    expect(providerResolved.openDisputes.toString()).to.equal("0");
  });

  it("19. Withdraw restrictions: blocked before delay, succeeds after delay", async () => {
    // Verify provider.locked == 0 and openDisputes == 0
    const providerAccountBefore: any = await program.account.provider.fetch(providerPda);
    expect(providerAccountBefore.locked.toString()).to.equal("0");
    expect(providerAccountBefore.openDisputes.toString()).to.equal("0");

    // Call request_withdraw
    await program.methods
      .requestWithdraw()
      .accounts({
        providerWallet: providerWallet.publicKey,
        provider: providerPda,
      })
      .signers([providerWallet])
      .rpc();

    const providerAccountRequested: any = await program.account.provider.fetch(providerPda);
    const requestedAt = Number(providerAccountRequested.withdrawRequestedAt.toString());
    expect(requestedAt).to.be.greaterThan(0);
    const unlockDeadline = requestedAt + Number(WITHDRAW_DELAY.toString());

    // Immediate withdraw_bond should fail with WithdrawDelayNotElapsed
    let delayErr: any = null;
    try {
      await program.methods
        .withdrawBond(new BN(10_000_000))
        .accounts({
          providerWallet: providerWallet.publicKey,
          provider: providerPda,
          config: configPda,
          vault: vaultPda,
          providerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([providerWallet])
        .rpc();
    } catch (err: any) {
      delayErr = err;
    }
    expect(delayErr, "withdrawBond before delay elapses should fail").to.not.be.null;
    expect(getErrorMessage(delayErr)).to.include("WithdrawDelayNotElapsed");

    // Wait until chain time >= unlockDeadline
    await waitForTimestamp(unlockDeadline);

    const providerTokenBefore = await getAccount(provider.connection, providerTokenAccount);

    // Call withdraw_bond after delay elapses
    const withdrawAmount = new BN(10_000_000); // 10 USDC
    await program.methods
      .withdrawBond(withdrawAmount)
      .accounts({
        providerWallet: providerWallet.publicKey,
        provider: providerPda,
        config: configPda,
        vault: vaultPda,
        providerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([providerWallet])
      .rpc();

    const providerTokenAfter = await getAccount(provider.connection, providerTokenAccount);
    const diff = new BN(providerTokenAfter.amount.toString()).sub(new BN(providerTokenBefore.amount.toString()));
    expect(diff.toString()).to.equal(withdrawAmount.toString());
  });
});

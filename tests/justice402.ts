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

  // Shared receipts to guarantee matching hashes between open and resolve
  let dispute101Receipt: ReceiptData;
  let dispute201Receipt: ReceiptData;

  const DISPUTE_WINDOW = new BN(10); // 10 seconds
  const RESOLVE_TIMEOUT = new BN(2); // 2 seconds
  const WITHDRAW_DELAY = new BN(2);  // 2 seconds
  const PAYOUT_CAP = new BN(50_000_000); // 50 USDC cap (6 decimals)

  const INITIAL_BOND = new BN(100_000_000); // 100 USDC
  const TOP_UP_BOND = new BN(50_000_000);   // 50 USDC

  before(async () => {
    admin = (provider.wallet as any).payer;
    arbiter = Keypair.generate();
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
  });

  it("1. Initializes program config and vault PDA", async () => {
    await program.methods
      .initialize(
        arbiter.publicKey,
        DISPUTE_WINDOW,
        RESOLVE_TIMEOUT,
        WITHDRAW_DELAY,
        PAYOUT_CAP
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

  it("2. Registers provider and deposits initial bond", async () => {
    await program.methods
      .registerProvider(INITIAL_BOND)
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

    const vaultAccount = await getAccount(provider.connection, vaultPda);
    expect(vaultAccount.amount.toString()).to.equal(INITIAL_BOND.toString());
  });

  it("3. Tops up provider bond", async () => {
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

  function createTestReceipt(opts: {
    price?: number | BN;
    timestamp?: number;
    nonce?: number;
    buyer?: PublicKey;
    providerKey?: PublicKey;
  } = {}): ReceiptData {
    return {
      version: RECEIPT_VERSION,
      provider: opts.providerKey || providerWallet.publicKey,
      buyer: opts.buyer || buyerWallet.publicKey,
      requestHash: crypto.createHash("sha256").update("request-test").digest(),
      responseHash: crypto.createHash("sha256").update("response-test").digest(),
      paymentReference: Buffer.alloc(64, 7),
      price: opts.price ? new BN(opts.price.toString()) : new BN(20_000_000), // 20 USDC
      timestamp: new BN(opts.timestamp !== undefined ? opts.timestamp : Math.floor(Date.now() / 1000)),
      nonce: new BN(opts.nonce || 1),
    };
  }

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
      .openDispute(
        {
          version: dispute101Receipt.version,
          provider: dispute101Receipt.provider,
          buyer: dispute101Receipt.buyer,
          requestHash: Array.from(dispute101Receipt.requestHash),
          responseHash: Array.from(dispute101Receipt.responseHash),
          paymentReference: Array.from(dispute101Receipt.paymentReference),
          price: dispute101Receipt.price as BN,
          timestamp: dispute101Receipt.timestamp as BN,
          nonce: dispute101Receipt.nonce as BN,
        },
        Array.from(Buffer.alloc(32, 1))
      )
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        dispute: disputePda,
        config: configPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(openIx);
    await provider.sendAndConfirm(tx, [buyerWallet]);

    const disputeAccount: any = await program.account.dispute.fetch(disputePda);
    expect(disputeAccount.buyer.toBase58()).to.equal(buyerWallet.publicKey.toBase58());
    expect(disputeAccount.provider.toBase58()).to.equal(providerWallet.publicKey.toBase58());
    expect(disputeAccount.claimAmount.toString()).to.equal("20000000");
    expect(disputeAccount.status.open).to.not.be.undefined;

    const providerAccount: any = await program.account.provider.fetch(providerPda);
    expect(providerAccount.locked.toString()).to.equal("20000000");
  });

  it("5. Rejects duplicate dispute opening with identical receipt", async () => {
    // Re-use exact same receipt from test 4
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
      .openDispute(
        {
          version: dispute101Receipt.version,
          provider: dispute101Receipt.provider,
          buyer: dispute101Receipt.buyer,
          requestHash: Array.from(dispute101Receipt.requestHash),
          responseHash: Array.from(dispute101Receipt.responseHash),
          paymentReference: Array.from(dispute101Receipt.paymentReference),
          price: dispute101Receipt.price as BN,
          timestamp: dispute101Receipt.timestamp as BN,
          nonce: dispute101Receipt.nonce as BN,
        },
        Array.from(Buffer.alloc(32, 1))
      )
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        dispute: disputePda,
        config: configPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(openIx);
    try {
      await provider.sendAndConfirm(tx, [buyerWallet]);
      expect.fail("Should have failed on duplicate dispute");
    } catch (err: any) {
      const errMsg = getErrorMessage(err);
      expect(errMsg).to.match(/already in use|custom program error|0x0|Simulation failed/);
    }
  });

  it("6. Rejects Ed25519 verification with wrong message", async () => {
    const receipt = createTestReceipt({ nonce: 102 });
    const canonicalBytes = encodeReceipt(receipt);
    const receiptHash = hashReceipt(canonicalBytes);
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    // Sign a 217-byte message that differs from canonical receipt
    const wrongMessage = Buffer.from(canonicalBytes);
    wrongMessage[wrongMessage.length - 1] ^= 0xff; // flip last byte
    const sig = signEd25519(wrongMessage, providerWallet.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: providerWallet.publicKey.toBytes(),
      message: wrongMessage,
      signature: sig,
    });

    const openIx = await program.methods
      .openDispute(
        {
          version: receipt.version,
          provider: receipt.provider,
          buyer: receipt.buyer,
          requestHash: Array.from(receipt.requestHash),
          responseHash: Array.from(receipt.responseHash),
          paymentReference: Array.from(receipt.paymentReference),
          price: receipt.price as BN,
          timestamp: receipt.timestamp as BN,
          nonce: receipt.nonce as BN,
        },
        Array.from(Buffer.alloc(32, 1))
      )
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        dispute: disputePda,
        config: configPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(openIx);
    try {
      await provider.sendAndConfirm(tx, [buyerWallet]);
      expect.fail("Should have failed with WrongMessage");
    } catch (err: any) {
      expect(getErrorMessage(err)).to.include("WrongMessage");
    }
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
      .openDispute(
        {
          version: receipt.version,
          provider: receipt.provider,
          buyer: receipt.buyer,
          requestHash: Array.from(receipt.requestHash),
          responseHash: Array.from(receipt.responseHash),
          paymentReference: Array.from(receipt.paymentReference),
          price: receipt.price as BN,
          timestamp: receipt.timestamp as BN,
          nonce: receipt.nonce as BN,
        },
        Array.from(Buffer.alloc(32, 1))
      )
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        dispute: disputePda,
        config: configPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(openIx);
    try {
      await provider.sendAndConfirm(tx, [buyerWallet]);
      expect.fail("Should have failed with WrongSigner");
    } catch (err: any) {
      expect(getErrorMessage(err)).to.include("WrongSigner");
    }
  });

  it("8. Rejects open_dispute when Ed25519 instruction is missing", async () => {
    const receipt = createTestReceipt({ nonce: 104 });
    const canonicalBytes = encodeReceipt(receipt);
    const receiptHash = hashReceipt(canonicalBytes);
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    const openIx = await program.methods
      .openDispute(
        {
          version: receipt.version,
          provider: receipt.provider,
          buyer: receipt.buyer,
          requestHash: Array.from(receipt.requestHash),
          responseHash: Array.from(receipt.responseHash),
          paymentReference: Array.from(receipt.paymentReference),
          price: receipt.price as BN,
          timestamp: receipt.timestamp as BN,
          nonce: receipt.nonce as BN,
        },
        Array.from(Buffer.alloc(32, 1))
      )
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        dispute: disputePda,
        config: configPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    // Transaction WITHOUT Ed25519 instruction
    const tx = new Transaction().add(openIx);
    try {
      await provider.sendAndConfirm(tx, [buyerWallet]);
      expect.fail("Should have failed with MissingEd25519Instruction");
    } catch (err: any) {
      expect(getErrorMessage(err)).to.include("MissingEd25519Instruction");
    }
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
      .openDispute(
        {
          version: receipt.version,
          provider: receipt.provider,
          buyer: receipt.buyer,
          requestHash: Array.from(receipt.requestHash),
          responseHash: Array.from(receipt.responseHash),
          paymentReference: Array.from(receipt.paymentReference),
          price: receipt.price as BN,
          timestamp: receipt.timestamp as BN,
          nonce: receipt.nonce as BN,
        },
        Array.from(Buffer.alloc(32, 1))
      )
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        dispute: disputePda,
        config: configPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(tamperedEd25519Ix).add(openIx);
    try {
      await provider.sendAndConfirm(tx, [buyerWallet]);
      expect.fail("Should have failed with InvalidEd25519Offset");
    } catch (err: any) {
      expect(getErrorMessage(err)).to.include("InvalidEd25519Offset");
    }
  });

  it("10. Rejects dispute opening after window expiry", async () => {
    // Timestamp 100 seconds in the past (> DISPUTE_WINDOW of 10s)
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
      .openDispute(
        {
          version: receipt.version,
          provider: receipt.provider,
          buyer: receipt.buyer,
          requestHash: Array.from(receipt.requestHash),
          responseHash: Array.from(receipt.responseHash),
          paymentReference: Array.from(receipt.paymentReference),
          price: receipt.price as BN,
          timestamp: receipt.timestamp as BN,
          nonce: receipt.nonce as BN,
        },
        Array.from(Buffer.alloc(32, 1))
      )
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        dispute: disputePda,
        config: configPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(openIx);
    try {
      await provider.sendAndConfirm(tx, [buyerWallet]);
      expect.fail("Should have failed with WindowExpired");
    } catch (err: any) {
      expect(getErrorMessage(err)).to.include("WindowExpired");
    }
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
      .openDispute(
        {
          version: receipt.version,
          provider: receipt.provider,
          buyer: receipt.buyer,
          requestHash: Array.from(receipt.requestHash),
          responseHash: Array.from(receipt.responseHash),
          paymentReference: Array.from(receipt.paymentReference),
          price: receipt.price as BN,
          timestamp: receipt.timestamp as BN,
          nonce: receipt.nonce as BN,
        },
        Array.from(Buffer.alloc(32, 1))
      )
      .accounts({
        buyer: attackerWallet.publicKey, // ATTACKER CALLER!
        provider: providerPda,
        dispute: disputePda,
        config: configPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(openIx);
    try {
      await provider.sendAndConfirm(tx, [attackerWallet]);
      expect.fail("Should have failed with UnauthorizedBuyer");
    } catch (err: any) {
      expect(getErrorMessage(err)).to.include("UnauthorizedBuyer");
    }
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
      .openDispute(
        {
          version: dispute201Receipt.version,
          provider: dispute201Receipt.provider,
          buyer: dispute201Receipt.buyer,
          requestHash: Array.from(dispute201Receipt.requestHash),
          responseHash: Array.from(dispute201Receipt.responseHash),
          paymentReference: Array.from(dispute201Receipt.paymentReference),
          price: dispute201Receipt.price as BN,
          timestamp: dispute201Receipt.timestamp as BN,
          nonce: dispute201Receipt.nonce as BN,
        },
        Array.from(Buffer.alloc(32, 2))
      )
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        dispute: disputePda,
        config: configPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(openIx);
    await provider.sendAndConfirm(tx, [buyerWallet]);

    const disputeAccount: any = await program.account.dispute.fetch(disputePda);
    expect(disputeAccount.price.toString()).to.equal("90000000");
    // Claim amount must be capped at 50 USDC (PAYOUT_CAP)
    expect(disputeAccount.claimAmount.toString()).to.equal(PAYOUT_CAP.toString());
  });

  it("13. Arbiter resolves dispute: BuyerWins pays refund up to cap", async () => {
    // Uses dispute201Receipt opened in test 12
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
    // Buyer receives exactly the capped 50 USDC
    expect(diff.toString()).to.equal(PAYOUT_CAP.toString());

    const providerAccountAfter: any = await program.account.provider.fetch(providerPda);
    const expectedBond = new BN(providerAccountBefore.bond.toString()).sub(PAYOUT_CAP);
    const expectedLocked = new BN(providerAccountBefore.locked.toString()).sub(PAYOUT_CAP);
    expect(providerAccountAfter.bond.toString()).to.equal(expectedBond.toString());
    expect(providerAccountAfter.locked.toString()).to.equal(expectedLocked.toString());
  });

  it("14. Rejects resolve_dispute by unauthorized non-arbiter", async () => {
    // Dispute 101 from test 4 is still open
    const receiptHash = hashReceipt(encodeReceipt(dispute101Receipt));
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    try {
      await program.methods
        .resolveDispute({ buyerWins: {} }, Array.from(Buffer.alloc(32, 9)))
        .accounts({
          arbiter: attackerWallet.publicKey, // ATTACKER!
          config: configPda,
          dispute: disputePda,
          provider: providerPda,
          vault: vaultPda,
          buyerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([attackerWallet])
        .rpc();
      expect.fail("Should have failed with UnauthorizedArbiter");
    } catch (err: any) {
      expect(getErrorMessage(err)).to.include("UnauthorizedArbiter");
    }
  });

  it("15. Rejects double resolve on an already resolved dispute", async () => {
    // Dispute 201 was resolved in test 13
    const receiptHash = hashReceipt(encodeReceipt(dispute201Receipt));
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    try {
      await program.methods
        .resolveDispute({ buyerWins: {} }, Array.from(Buffer.alloc(32, 9)))
        .accounts({
          arbiter: arbiter.publicKey,
          config: configPda,
          dispute: disputePda,
          provider: providerPda,
          vault: vaultPda,
          buyerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([arbiter])
        .rpc();
      expect.fail("Should have failed with DisputeNotOpen");
    } catch (err: any) {
      expect(getErrorMessage(err)).to.include("DisputeNotOpen");
    }
  });

  it("16. Arbiter resolves ProviderWins: unlocks bond without buyer payout", async () => {
    // Resolve dispute 101 from test 4
    const receiptHash = hashReceipt(encodeReceipt(dispute101Receipt));
    const [disputePda] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), receiptHash], program.programId);

    const buyerTokenBefore = await getAccount(provider.connection, buyerTokenAccount);
    const providerAccountBefore: any = await program.account.provider.fetch(providerPda);

    await program.methods
      .resolveDispute({ providerWins: {} }, Array.from(Buffer.alloc(32, 8)))
      .accounts({
        arbiter: arbiter.publicKey,
        config: configPda,
        dispute: disputePda,
        provider: providerPda,
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

    // Provider bond untouched, locked decreased by 20 USDC
    const providerAccountAfter: any = await program.account.provider.fetch(providerPda);
    expect(providerAccountAfter.bond.toString()).to.equal(providerAccountBefore.bond.toString());
    const expectedLocked = new BN(providerAccountBefore.locked.toString()).sub(new BN(20_000_000));
    expect(providerAccountAfter.locked.toString()).to.equal(expectedLocked.toString());
  });

  it("17. Timeout refund: buyer claims refund if arbiter is silent past timeout", async () => {
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
      .openDispute(
        {
          version: receipt.version,
          provider: receipt.provider,
          buyer: receipt.buyer,
          requestHash: Array.from(receipt.requestHash),
          responseHash: Array.from(receipt.responseHash),
          paymentReference: Array.from(receipt.paymentReference),
          price: receipt.price as BN,
          timestamp: receipt.timestamp as BN,
          nonce: receipt.nonce as BN,
        },
        Array.from(Buffer.alloc(32, 3))
      )
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        dispute: disputePda,
        config: configPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(openIx);
    await provider.sendAndConfirm(tx, [buyerWallet]);

    // Calling claim_timeout immediately should fail with TimeoutNotReached
    try {
      await program.methods
        .claimTimeout()
        .accounts({
          buyer: buyerWallet.publicKey,
          config: configPda,
          dispute: disputePda,
          provider: providerPda,
          vault: vaultPda,
          buyerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyerWallet])
        .rpc();
      expect.fail("Should have failed with TimeoutNotReached");
    } catch (err: any) {
      expect(getErrorMessage(err)).to.include("TimeoutNotReached");
    }

    // Wait for resolve_timeout (2s) to elapse
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const buyerTokenBefore = await getAccount(provider.connection, buyerTokenAccount);

    // Call claim_timeout past timeout deadline
    await program.methods
      .claimTimeout()
      .accounts({
        buyer: buyerWallet.publicKey,
        config: configPda,
        dispute: disputePda,
        provider: providerPda,
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
    expect(diff.toString()).to.equal("15000000");
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
      .openDispute(
        {
          version: receipt.version,
          provider: receipt.provider,
          buyer: receipt.buyer,
          requestHash: Array.from(receipt.requestHash),
          responseHash: Array.from(receipt.responseHash),
          paymentReference: Array.from(receipt.paymentReference),
          price: receipt.price as BN,
          timestamp: receipt.timestamp as BN,
          nonce: receipt.nonce as BN,
        },
        Array.from(Buffer.alloc(32, 4))
      )
      .accounts({
        buyer: buyerWallet.publicKey,
        provider: providerPda,
        dispute: disputePda,
        config: configPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    await provider.sendAndConfirm(new Transaction().add(ed25519Ix).add(openIx), [buyerWallet]);

    // Provider has locked funds: request_withdraw should fail
    try {
      await program.methods
        .requestWithdraw()
        .accounts({
          providerWallet: providerWallet.publicKey,
          provider: providerPda,
        })
        .signers([providerWallet])
        .rpc();
      expect.fail("Should have failed with BondLocked");
    } catch (err: any) {
      expect(getErrorMessage(err)).to.include("BondLocked");
    }

    // withdraw_bond should also fail
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
      expect.fail("Should have failed with BondLocked");
    } catch (err: any) {
      expect(getErrorMessage(err)).to.include("BondLocked");
    }

    // Resolve dispute 401 so provider has 0 locked
    await program.methods
      .resolveDispute({ providerWins: {} }, Array.from(Buffer.alloc(32, 4)))
      .accounts({
        arbiter: arbiter.publicKey,
        config: configPda,
        dispute: disputePda,
        provider: providerPda,
        vault: vaultPda,
        buyerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([arbiter])
      .rpc();
  });

  it("19. Withdraw restrictions: blocked before delay, succeeds after delay", async () => {
    // At this point, all disputes (101, 201, 301, 401) are resolved, provider.locked == 0
    const providerAccountBefore: any = await program.account.provider.fetch(providerPda);
    expect(providerAccountBefore.locked.toString()).to.equal("0");

    // Calling withdraw_bond before request_withdraw fails
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
      expect.fail("Should have failed with WithdrawNotRequested");
    } catch (err: any) {
      expect(getErrorMessage(err)).to.include("WithdrawNotRequested");
    }

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
    expect(Number(providerAccountRequested.withdrawRequestedAt.toString())).to.be.greaterThan(0);

    // Immediate withdraw_bond should fail with WithdrawDelayNotElapsed
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
      expect.fail("Should have failed with WithdrawDelayNotElapsed");
    } catch (err: any) {
      expect(getErrorMessage(err)).to.include("WithdrawDelayNotElapsed");
    }

    // Wait for withdraw_delay (2s) to elapse
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const providerTokenBefore = await getAccount(provider.connection, providerTokenAccount);

    // Call withdraw_bond after delay elapses
    const withdrawAmount = new BN(20_000_000); // 20 USDC
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

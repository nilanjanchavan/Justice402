import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import {
  PublicKey,
  Keypair,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import http from "http";
import crypto from "crypto";
import idl from "../target/idl/justice402.json";
import {
  getConfigPda,
  getVaultPda,
  getProviderPda,
  getProviderTrust,
  decodeReceipt,
} from "../packages/anchor-client/src/index";
import {
  createProviderApp,
  WEATHER_SERVICE_SPEC,
  SPEC_HASH,
  SPEC_CANONICAL_JSON,
} from "../services/provider-api/src/index";
import {
  executeBuyerPurchase,
  checkProviderTrust,
} from "../services/buyer-agent/src/index";
import {
  evaluateAndRule,
  runDeterministicSpecCheck,
} from "../services/arbiter/src/index";

describe("Phase 2 End-to-End System Integration Test", () => {
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

  let configPda: PublicKey;
  let vaultPda: PublicKey;
  let providerPda: PublicKey;

  let honestServer: http.Server;
  let lyingServer: http.Server;
  let subtleServer: http.Server;
  let subtleProviderWallet: Keypair;
  let subtleProviderTokenAccount: PublicKey;
  let subtleProviderPda: PublicKey;
  const HONEST_PORT = 4021;
  const LYING_PORT = 4022;
  const SUBTLE_PORT = 4023;
  const HONEST_URL = `http://127.0.0.1:${HONEST_PORT}`;
  const LYING_URL = `http://127.0.0.1:${LYING_PORT}`;
  const SUBTLE_URL = `http://127.0.0.1:${SUBTLE_PORT}`;

  const INITIAL_BOND = new BN(100_000_000); // 100 USDC
  const PRICE_PER_QUERY = new BN(5_000_000); // 5 USDC
  const DISPUTE_WINDOW = new BN(60); // 60 seconds
  const RESOLVE_TIMEOUT = new BN(30); // 30 seconds
  const WITHDRAW_DELAY = new BN(10);
  const PAYOUT_CAP = new BN(50_000_000);
  const DISPUTE_DEPOSIT = new BN(1_000_000); // 1 USDC deposit
  const MAX_OPEN_DISPUTES = 3;

  const ARBITER_SEED = crypto.createHash("sha256").update("justice402-shared-test-arbiter").digest().subarray(0, 32);

  before(async () => {
    admin = (provider.wallet as any).payer;
    arbiter = Keypair.fromSeed(ARBITER_SEED);
    providerWallet = Keypair.generate();
    buyerWallet = Keypair.generate();
    subtleProviderWallet = Keypair.generate();

    // Airdrop SOL
    for (const kp of [arbiter, providerWallet, buyerWallet, subtleProviderWallet]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      });
    }

    // Derive PDAs
    [configPda] = getConfigPda(program.programId);
    [vaultPda] = getVaultPda(program.programId, configPda);
    [providerPda] = getProviderPda(program.programId, providerWallet.publicKey);
    [subtleProviderPda] = getProviderPda(program.programId, subtleProviderWallet.publicKey);

    // 1. Initialize program if not already initialized on this validator
    const existingConfig: any = await program.account.config.fetchNullable(configPda);
    if (!existingConfig) {
      usdcMint = await createMint(provider.connection, admin, admin.publicKey, null, 6);
      await program.methods
        .initialize(arbiter.publicKey, DISPUTE_WINDOW, RESOLVE_TIMEOUT, WITHDRAW_DELAY, PAYOUT_CAP, DISPUTE_DEPOSIT, MAX_OPEN_DISPUTES)
        .accounts({
          admin: admin.publicKey,
          config: configPda,
          usdcMint,
          vault: vaultPda,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    } else {
      usdcMint = existingConfig.usdcMint;
    }

    // Create Token Accounts
    providerTokenAccount = await createAccount(provider.connection, admin, usdcMint, providerWallet.publicKey);
    buyerTokenAccount = await createAccount(provider.connection, admin, usdcMint, buyerWallet.publicKey);
    subtleProviderTokenAccount = await createAccount(provider.connection, admin, usdcMint, subtleProviderWallet.publicKey);

    // Fund provider with 200 USDC, buyer with 100 USDC, and subtle provider with 200 USDC
    await mintTo(provider.connection, admin, usdcMint, providerTokenAccount, admin, 200_000_000);
    await mintTo(provider.connection, admin, usdcMint, buyerTokenAccount, admin, 100_000_000);
    await mintTo(provider.connection, admin, usdcMint, subtleProviderTokenAccount, admin, 200_000_000);

    // 2. Register Provider with on-chain spec_hash commitment and initial bond
    await program.methods
      .registerProvider(INITIAL_BOND, Array.from(SPEC_HASH))
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

    await program.methods
      .registerProvider(INITIAL_BOND, Array.from(SPEC_HASH))
      .accounts({
        providerWallet: subtleProviderWallet.publicKey,
        provider: subtleProviderPda,
        config: configPda,
        vault: vaultPda,
        providerTokenAccount: subtleProviderTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([subtleProviderWallet])
      .rpc();

    // 3. Start Provider Express servers
    const honestApp = createProviderApp({
      providerKeypair: providerWallet,
      specHash: SPEC_HASH,
      priceLamports: PRICE_PER_QUERY,
    });
    const lyingApp = createProviderApp({
      providerKeypair: providerWallet,
      specHash: SPEC_HASH,
      priceLamports: PRICE_PER_QUERY,
    });

    await new Promise<void>((resolve) => {
      honestServer = honestApp.listen(HONEST_PORT, () => resolve());
    });
    await new Promise<void>((resolve) => {
      lyingServer = lyingApp.listen(LYING_PORT, () => resolve());
    });
    const subtleApp = createProviderApp({
      providerKeypair: subtleProviderWallet,
      specHash: SPEC_HASH,
      priceLamports: PRICE_PER_QUERY,
    });
    await new Promise<void>((resolve) => {
      subtleServer = subtleApp.listen(SUBTLE_PORT, () => resolve());
    });
  });

  after(async () => {
    if (honestServer) honestServer.close();
    if (lyingServer) lyingServer.close();
    if (subtleServer) subtleServer.close();
  });

  it("A. Buyer Spend Policy: Refuses to pay provider whose bond is less than K x price", async () => {
    // If query price is 50 USDC, and K = 3, required bond is 150 USDC.
    // Provider currently has only 100 USDC in bond.
    const expensivePrice = new BN(50_000_000);
    const trustCheck = await checkProviderTrust(
      program,
      providerWallet.publicKey,
      expensivePrice,
      { minBondMultiplier: 3, maxLossRate: 0.5 }
    );

    expect(trustCheck.allowed, "Buyer policy must refuse payment when bond < K * price").to.be.false;
    expect(trustCheck.reason).to.include("less than required 3x price");
  });

  it("B. Honest Purchase: Buyer verifies trust, purchases data, sanity check passes", async () => {
    const result = await executeBuyerPurchase({
      program,
      buyerKeypair: buyerWallet,
      providerWallet: providerWallet.publicKey,
      providerUrl: HONEST_URL,
      endpoint: "/weather",
      price: PRICE_PER_QUERY,
      spec: WEATHER_SERVICE_SPEC,
    });

    expect(result.status).to.equal("success");
    expect(result.data.city).to.equal("SolanaBeach");
    expect(result.data.temperature).to.equal(24.5);
    expect(result.data.humidity).to.equal(55);
    expect(result.receipt).to.not.be.undefined;
    expect(result.receipt?.provider.toBase58()).to.equal(providerWallet.publicKey.toBase58());
  });

  it("C. Lying Purchase & Automatic Dispute: Buyer detects range violation and opens on-chain dispute", async () => {
    const buyerTokenBefore = await getAccount(provider.connection, buyerTokenAccount);

    const result = await executeBuyerPurchase({
      program,
      buyerKeypair: buyerWallet,
      providerWallet: providerWallet.publicKey,
      buyerTokenAccount,
      providerUrl: LYING_URL,
      endpoint: "/weather-lying",
      price: PRICE_PER_QUERY,
      spec: WEATHER_SERVICE_SPEC,
    });

    expect(result.status, "Buyer must detect violation and open dispute").to.equal("disputed");
    expect(result.violations?.some((v) => v.includes("Range violation"))).to.be.true;
    expect(result.disputePda).to.not.be.undefined;
    expect(result.disputeTxSig).to.not.be.undefined;

    // Verify dispute is open on Solana
    const disputeAccount: any = await program.account.dispute.fetch(result.disputePda!);
    expect(disputeAccount.status.open).to.not.be.undefined;
    expect(disputeAccount.buyer.toBase58()).to.equal(buyerWallet.publicKey.toBase58());
    expect(disputeAccount.claimAmount.toString()).to.equal(PRICE_PER_QUERY.toString());

    // Verify provider bond is locked
    const providerAccount: any = await program.account.provider.fetch(providerPda);
    expect(providerAccount.locked.toString()).to.equal(PRICE_PER_QUERY.toString());
    expect(providerAccount.openDisputes.toString()).to.equal("1");

    // D. Human Arbiter: Evaluates deterministic spec check and rules BuyerWins
    const rawEvidence = Buffer.from(JSON.stringify(result.data));
    const arbiterVerdict = await evaluateAndRule({
      program,
      arbiterKeypair: arbiter,
      disputePda: result.disputePda!,
      providerWallet: providerWallet.publicKey,
      buyerTokenAccount,
      receipt: result.receipt!,
      evidenceBytes: rawEvidence,
      specContent: SPEC_CANONICAL_JSON,
      autoApprove: true,
    });

    expect(arbiterVerdict.ruling).to.equal("BuyerWins");
    expect(arbiterVerdict.results.isValid).to.be.false;
    expect(arbiterVerdict.results.rangesValid).to.be.false;
    expect(arbiterVerdict.results.specHashMatch).to.be.true;
    expect(arbiterVerdict.results.responseHashMatch).to.be.true;

    // E. On-chain refund from bond verified (buyer receives claim refund + returned deposit)
    const buyerTokenAfter = await getAccount(provider.connection, buyerTokenAccount);
    const diff = new BN(buyerTokenAfter.amount.toString()).sub(new BN(buyerTokenBefore.amount.toString()));
    expect(diff.toString()).to.equal(PRICE_PER_QUERY.toString());

    const providerFinal: any = await program.account.provider.fetch(providerPda);
    const expectedBond = INITIAL_BOND.sub(PRICE_PER_QUERY);
    expect(providerFinal.bond.toString()).to.equal(expectedBond.toString());
    expect(providerFinal.locked.toString()).to.equal("0");
    expect(providerFinal.openDisputes.toString()).to.equal("0");
    expect(providerFinal.disputesBuyerWon.toString()).to.equal("1");
    expect(providerFinal.totalSlashed.toString()).to.equal(PRICE_PER_QUERY.toString());

    // Verify getProviderTrust reflects updated losses
    const trust = await getProviderTrust(program, providerWallet.publicKey);
    expect(trust.losses.toString()).to.equal("1");
    expect(trust.totalSlashed.toString()).to.equal(PRICE_PER_QUERY.toString());
  });
  it("D. Third Provider Demo: Plausible-wrong response passes schema but contradicts reference ground truth", async () => {
    // 1. Query reference ground truth endpoint
    const refRes = await fetch(HONEST_URL + "/reference/weather");
    const refJson = (await refRes.json()) as any;
    expect(refJson.temperature).to.equal(24.5);

    // 2. Query third provider: /weather-plausible-wrong
    const result = await executeBuyerPurchase({
      program,
      buyerKeypair: buyerWallet,
      providerWallet: subtleProviderWallet.publicKey,
      buyerTokenAccount,
      providerUrl: SUBTLE_URL,
      endpoint: "/weather-plausible-wrong",
      price: PRICE_PER_QUERY,
      spec: WEATHER_SERVICE_SPEC,
    });

    // 3. Buyer basic sanity checks PASS because 38.0 is in [-50, 60] and schema is valid
    expect(result.status).to.equal("success");
    expect(result.data.temperature).to.equal(38.0);
    expect(result.receipt).to.not.be.undefined;

    // 4. Verification against reference ground truth endpoint detects the contradiction:
    // Ground truth: 24.5C vs Plausible-wrong provider: 38.0C (discrepancy = 13.5C)
    const discrepancy = Math.abs(result.data.temperature - refJson.temperature);
    expect(discrepancy).to.be.greaterThan(5.0);
    console.log(`[Item 6 Demo] Reference ground truth: ${refJson.temperature}C | Third provider returned: ${result.data.temperature}C | Discrepancy detected: ${discrepancy}C`);
  });
});


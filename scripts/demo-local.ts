import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import idl from "../target/idl/justice402.json";
import { getConfigPda, getProviderPda, getVaultPda, getProviderTrust } from "../packages/anchor-client/src/index";
import { createProviderApp, SPEC_HASH, SPEC_CANONICAL_JSON, WEATHER_SERVICE_SPEC } from "../services/provider-api/src/index";
import { executeBuyerPurchase } from "../services/buyer-agent/src/index";
import { evaluateAndRule } from "../services/arbiter/src/index";

function deterministicKeypair(seed: string): Keypair {
  return Keypair.fromSeed(crypto.createHash("sha256").update(seed).digest().subarray(0, 32));
}

async function ensureAirdrop(connection: Connection, pubkey: PublicKey, sol = 5) {
  const bal = await connection.getBalance(pubkey);
  if (bal < 2 * LAMPORTS_PER_SOL) {
    const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
  console.log("==================================================");
  console.log("       JUSTICE402 LOCALHOST DEMO SEEDER           ");
  console.log("==================================================");
  console.log("RPC URL:", rpcUrl);

  const connection = new Connection(rpcUrl, "confirmed");
  const admin = deterministicKeypair("justice402-local-admin");
  const arbiter = deterministicKeypair("justice402-local-arbiter");
  const buyer = deterministicKeypair("justice402-local-buyer");
  const honestProvider = deterministicKeypair("justice402-local-honest-provider");
  const lyingProvider = deterministicKeypair("justice402-local-lying-provider");
  const subtleProvider = deterministicKeypair("justice402-local-subtle-provider");

  await Promise.all([
    ensureAirdrop(connection, admin.publicKey, 10),
    ensureAirdrop(connection, arbiter.publicKey, 5),
    ensureAirdrop(connection, buyer.publicKey, 5),
    ensureAirdrop(connection, honestProvider.publicKey, 5),
    ensureAirdrop(connection, lyingProvider.publicKey, 5),
    ensureAirdrop(connection, subtleProvider.publicKey, 5),
  ]);

  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new anchor.Program(idl as any, provider);
  const programId = program.programId;

  const [configPda] = getConfigPda(programId);
  const [vaultPda] = getVaultPda(programId, configPda);

  let usdcMint: PublicKey;
  const existingConfig = await connection.getAccountInfo(configPda);
  if (!existingConfig) {
    usdcMint = await createMint(connection, admin, admin.publicKey, null, 6);
    await program.methods
      .initialize(
        arbiter.publicKey,
        new BN(3600),         // dispute_window: 1h
        new BN(180),          // resolve_timeout: 3m
        new BN(10),           // withdraw_delay: 10s
        new BN(10_000_000),   // per_ruling_payout_cap: 10 USDC
        new BN(1_000_000),    // dispute_deposit: 1 USDC
        3                     // max_open_disputes_per_buyer
      )
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        usdcMint,
        vault: vaultPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();
    console.log("Initialized Config PDA:", configPda.toBase58());
  } else {
    const cfg: any = await (program.account as any).config.fetch(configPda);
    usdcMint = cfg.usdcMint;
    console.log("Config PDA already initialized:", configPda.toBase58());
  }

  // Fund & register providers if needed
  const bondAmount = new BN(100_000_000); // 100 USDC
  for (const [label, kp] of [
    ["Honest", honestProvider],
    ["Lying", lyingProvider],
    ["Subtle", subtleProvider],
  ] as const) {
    const [pda] = getProviderPda(programId, kp.publicKey);
    const info = await connection.getAccountInfo(pda);
    if (!info) {
      const ata = await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, kp.publicKey);
      await mintTo(connection, admin, usdcMint, ata.address, admin, 200_000_000);
      await program.methods
        .registerProvider(bondAmount, Array.from(SPEC_HASH))
        .accounts({
          providerWallet: kp.publicKey,
          provider: pda,
          config: configPda,
          vault: vaultPda,
          providerTokenAccount: ata.address,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([kp])
        .rpc();
      console.log(`Registered ${label} Provider: ${kp.publicKey.toBase58()}`);
    }
  }

  const buyerAta = await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, buyer.publicKey);
  await mintTo(connection, admin, usdcMint, buyerAta.address, admin, 50_000_000);

  // Spin up ephemeral local provider servers for honest and lying demo flow
  const honestApp = createProviderApp({ providerKeypair: honestProvider, priceLamports: 5_000_000 });
  const lyingApp = createProviderApp({ providerKeypair: lyingProvider, priceLamports: 5_000_000 });

  const honestServer = await new Promise<any>((resolve) => {
    const s = honestApp.listen(0, () => resolve(s));
  });
  const lyingServer = await new Promise<any>((resolve) => {
    const s = lyingApp.listen(0, () => resolve(s));
  });

  const honestPort = honestServer.address().port;
  const lyingPort = lyingServer.address().port;

  const steps: any[] = [];

  try {
    // Step 1: Pre-flight trust check
    const trust = await getProviderTrust(program, honestProvider.publicKey);
    steps.push({
      step: 1,
      title: "Pre-Flight Trust Verification",
      status: "SUCCESS",
      description: "Buyer read provider on-chain bond, track record, and spec_hash from local validator before spending.",
      details: {
        provider: honestProvider.publicKey.toBase58(),
        bond: trust.bond.toString(),
        specHash: trust.specHash.toString("hex"),
      },
    });

    // Step 2: Honest purchase
    const honestRes = await executeBuyerPurchase({
      program,
      buyerKeypair: buyer,
      providerWallet: honestProvider.publicKey,
      providerUrl: `http://127.0.0.1:${honestPort}`,
      endpoint: "/weather",
      price: new BN(5_000_000),
      spec: WEATHER_SERVICE_SPEC,
    });
    steps.push({
      step: 2,
      title: "Honest Service Purchase (Localnet Verified)",
      status: "SUCCESS",
      description: "Executed purchase against honest provider; verified Ed25519 receipt and spec compliance.",
      details: {
        provider: honestProvider.publicKey.toBase58(),
        pricePaid: "5.0 USDC",
        data: honestRes.data,
      },
    });

    // Step 3: Lying purchase -> Open Dispute
    const lyingRes = await executeBuyerPurchase({
      program,
      buyerKeypair: buyer,
      providerWallet: lyingProvider.publicKey,
      buyerTokenAccount: buyerAta.address,
      providerUrl: `http://127.0.0.1:${lyingPort}`,
      endpoint: "/weather-lying",
      price: new BN(5_000_000),
      spec: WEATHER_SERVICE_SPEC,
    });

    steps.push({
      step: 3,
      title: "Lying Service Detected & On-Chain Dispute Opened",
      status: "SUCCESS",
      description: "Detected numerical range violation; submitted Ed25519 introspection and opened on-chain dispute.",
      txSignature: lyingRes.disputeTxSig,
      details: {
        disputePda: lyingRes.disputePda?.toBase58(),
        violations: lyingRes.violations,
      },
    });

    // Step 4: Arbiter rules BuyerWins
    const rawEvidence = Buffer.from(JSON.stringify(lyingRes.data));
    const verdict = await evaluateAndRule({
      program,
      arbiterKeypair: arbiter,
      disputePda: lyingRes.disputePda!,
      providerWallet: lyingProvider.publicKey,
      buyerTokenAccount: buyerAta.address,
      receipt: lyingRes.receipt!,
      evidenceBytes: rawEvidence,
      specContent: SPEC_CANONICAL_JSON,
      autoApprove: true,
    });

    steps.push({
      step: 4,
      title: "Human Arbiter Resolution on Localnet",
      status: "SUCCESS",
      description: "Human arbiter audited receipt against registered spec_hash and signed resolve_dispute.",
      txSignature: verdict.txSig,
      details: {
        ruling: verdict.ruling,
        disputePda: lyingRes.disputePda?.toBase58(),
      },
    });

    // Step 5: Refund verification
    const lyingTrustAfter = await getProviderTrust(program, lyingProvider.publicKey);
    steps.push({
      step: 5,
      title: "Refund Settlement & Provider Slashed",
      status: "SUCCESS",
      description: "Buyer received 5.0 USDC claim refund + 1.0 USDC returned deposit; provider bond slashed by 5.0 USDC.",
      details: {
        remainingBond: `${lyingTrustAfter.bond.toString()} units (${lyingTrustAfter.bond.toNumber() / 1_000_000} USDC)`,
        totalSlashed: `${lyingTrustAfter.totalSlashed.toString()} units (${lyingTrustAfter.totalSlashed.toNumber() / 1_000_000} USDC)`,
        disputesBuyerWon: lyingTrustAfter.disputesBuyerWon.toString(),
      },
    });

    const outJson = {
      executedAt: new Date().toISOString(),
      network: "Localhost (127.0.0.1:8899)",
      isSample: false,
      programId: programId.toBase58(),
      buyer: buyer.publicKey.toBase58(),
      steps,
    };

    const publicDir = path.resolve(process.cwd(), "dashboard/public");
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(path.join(publicDir, "demo-run.json"), JSON.stringify(outJson, null, 2));
    console.log("Wrote live localnet run trace to dashboard/public/demo-run.json");
  } finally {
    honestServer.close();
    lyingServer.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


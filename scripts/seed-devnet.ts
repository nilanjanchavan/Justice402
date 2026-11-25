import * as anchor from "@anchor-lang/core";
import { PublicKey, Keypair, Connection, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import idl from "../target/idl/justice402.json";
import { getConfigPda, getVaultPda, getProviderPda } from "../packages/anchor-client/src/index";
import { SPEC_HASH } from "../services/provider-api/src/spec";

function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [key, ...vals] = trimmed.split("=");
      if (key && !process.env[key.trim()]) {
        process.env[key.trim()] = vals.join("=").trim().replace(/^["']|["']$/g, "");
      }
    }
  }
}

async function main() {
  loadEnv();

  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  console.log("==================================================");
  console.log("       JUSTICE402 DEVNET SEED PROVIDERS           ");
  console.log("==================================================");
  console.log("Cluster RPC:   ", rpcUrl);

  // Safety confirmation: Never run on mainnet
  if (rpcUrl.includes("mainnet") || rpcUrl.includes("api.mainnet-beta.solana.com")) {
    throw new Error("CRITICAL SAFETY ERROR: Refusing to run seed script on MAINNET! Only devnet/localnet is permitted.");
  }
  console.log("Cluster Check:  CONFIRMED DEVNET (Safety Check Passed)");

  const connection = new Connection(rpcUrl, "confirmed");

  // Load Admin/Deployer Keypair
  const adminKeypairPath = process.env.ADMIN_KEYPAIR_PATH || process.env.ANCHOR_WALLET || "./id.json";
  if (!fs.existsSync(adminKeypairPath)) {
    throw new Error(`Admin keypair not found at ${adminKeypairPath}. Please provide ADMIN_KEYPAIR_PATH in .env or id.json`);
  }
  const adminSecret = JSON.parse(fs.readFileSync(adminKeypairPath, "utf8"));
  const adminKeypair = Keypair.fromSecretKey(Uint8Array.from(adminSecret));
  console.log("Admin Wallet:  ", adminKeypair.publicKey.toBase58());

  // Program & Config
  const programId = new PublicKey(process.env.PROGRAM_ID || idl.address || "D8uK7oT6f1pcZzK2Dq1NhL7wdNp51sS5ZhuNy4wf8WYD");
  const [configPda] = getConfigPda(programId);
  const [vaultPda] = getVaultPda(programId, configPda);
  const usdcMint = new PublicKey(process.env.USDC_MINT || NATIVE_MINT.toBase58());

  const wallet = new anchor.Wallet(adminKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new anchor.Program(idl as any, provider);

  // Deterministic Keypairs for the 3 Demo Providers
  const providers = [
    {
      name: "Honest Weather Provider",
      endpoint: "/weather",
      seed: "justice402-devnet-honest-provider",
      keypair: Keypair.fromSeed(crypto.createHash("sha256").update("justice402-devnet-honest-provider").digest().subarray(0, 32)),
    },
    {
      name: "Lying Weather Provider (Gross Violations)",
      endpoint: "/weather-lying",
      seed: "justice402-devnet-lying-provider",
      keypair: Keypair.fromSeed(crypto.createHash("sha256").update("justice402-devnet-lying-provider").digest().subarray(0, 32)),
    },
    {
      name: "Plausible-Wrong Provider (Subtle Contradiction)",
      endpoint: "/weather-plausible-wrong",
      seed: "justice402-devnet-subtle-provider",
      keypair: Keypair.fromSeed(crypto.createHash("sha256").update("justice402-devnet-subtle-provider").digest().subarray(0, 32)),
    },
  ];

  const seedResult: any = {
    cluster: "devnet",
    programId: programId.toBase58(),
    configPda: configPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    usdcMint: usdcMint.toBase58(),
    providers: {},
  };

  console.log("\nProcessing Demo Providers Registration & On-Chain State:");
  console.log("--------------------------------------------------");

  for (const p of providers) {
    const [pPda] = getProviderPda(programId, p.keypair.publicKey);
    const ata = getAssociatedTokenAddressSync(usdcMint, p.keypair.publicKey);

    console.log(`[${p.name}]`);
    console.log(`  Wallet:       ${p.keypair.publicKey.toBase58()}`);
    console.log(`  Provider PDA: ${pPda.toBase58()}`);
    console.log(`  USDC ATA:     ${ata.toBase58()}`);

    const existingProvider = await connection.getAccountInfo(pPda);
    if (existingProvider) {
      console.log(`  Status:       ALREADY REGISTERED (Idempotent)`);
      const providerData: any = await (program.account as any).provider.fetch(pPda);
      console.log(`  Current Bond: ${providerData.bond.toString()} units`);
      console.log(`  Locked:       ${providerData.locked.toString()} units`);
      console.log(`  Spec Hash:    ${Buffer.from(providerData.specHash).toString("hex")}`);

      seedResult.providers[p.endpoint] = {
        name: p.name,
        wallet: p.keypair.publicKey.toBase58(),
        providerPda: pPda.toBase58(),
        ata: ata.toBase58(),
        bond: providerData.bond.toString(),
        locked: providerData.locked.toString(),
        specHash: Buffer.from(providerData.specHash).toString("hex"),
        alreadyRegistered: true,
      };
    } else {
      console.log(`  Status:       Not registered. Creating ATA & Registering on-chain...`);

      // 1. Ensure Provider has SOL for tx fee
      const balance = await connection.getBalance(p.keypair.publicKey);
      if (balance < 0.1 * anchor.web3.LAMPORTS_PER_SOL) {
        console.log(`  Funding provider wallet with 0.12 SOL from admin...`);
        const fundTx = new anchor.web3.Transaction().add(
          SystemProgram.transfer({
            fromPubkey: adminKeypair.publicKey,
            toPubkey: p.keypair.publicKey,
            lamports: 0.12 * anchor.web3.LAMPORTS_PER_SOL,
          })
        );
        await provider.sendAndConfirm(fundTx, [adminKeypair]);
      }

      // 2. Ensure ATA exists & wrap 0.05 SOL if using NATIVE_MINT
      const initialBondLamports = 50_000_000; // 0.05 SOL
      const setupTx = new anchor.web3.Transaction();
      const ataInfo = await connection.getAccountInfo(ata);
      if (!ataInfo) {
        setupTx.add(
          createAssociatedTokenAccountInstruction(
            adminKeypair.publicKey,
            ata,
            p.keypair.publicKey,
            usdcMint
          )
        );
      }
      if (usdcMint.equals(NATIVE_MINT)) {
        setupTx.add(
          SystemProgram.transfer({
            fromPubkey: adminKeypair.publicKey,
            toPubkey: ata,
            lamports: initialBondLamports,
          }),
          createSyncNativeInstruction(ata)
        );
      }
      if (setupTx.instructions.length > 0) {
        await provider.sendAndConfirm(setupTx, [adminKeypair]);
      }

      // 3. Register Provider with 0.05 SOL initial bond
      const registerTx = await program.methods
        .registerProvider(new anchor.BN(usdcMint.equals(NATIVE_MINT) ? initialBondLamports : 0), Array.from(SPEC_HASH))
        .accounts({
          providerWallet: p.keypair.publicKey,
          provider: pPda,
          config: configPda,
          vault: vaultPda,
          providerTokenAccount: ata,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([p.keypair])
        .rpc();

      console.log(`  Registered on devnet! Tx: ${registerTx}`);
      console.log(`  Explorer: https://explorer.solana.com/tx/${registerTx}?cluster=devnet`);

      seedResult.providers[p.endpoint] = {
        name: p.name,
        wallet: p.keypair.publicKey.toBase58(),
        providerPda: pPda.toBase58(),
        ata: ata.toBase58(),
        bond: "0",
        locked: "0",
        specHash: SPEC_HASH.toString("hex"),
        registrationTx: registerTx,
        alreadyRegistered: false,
      };
    }
    console.log("--------------------------------------------------");
  }

  // Write devnet-seed.json
  const seedPath = path.resolve(process.cwd(), "docs/devnet-seed.json");
  fs.writeFileSync(seedPath, JSON.stringify(seedResult, null, 2));
  console.log(`Saved seed configuration to: ${seedPath}`);
  console.log("==================================================");
}

main().catch((err) => {
  console.error("Seeding Failed:", err.message || err);
  process.exit(1);
});


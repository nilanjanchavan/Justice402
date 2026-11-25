import * as anchor from "@anchor-lang/core";
import { PublicKey, Keypair, Connection, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";
import path from "path";
import idl from "../target/idl/justice402.json";
import { getConfigPda, getVaultPda } from "../packages/anchor-client/src/index";

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
  console.log("       JUSTICE402 DEVNET INITIALIZATION           ");
  console.log("==================================================");
  console.log("Cluster RPC:   ", rpcUrl);

  // Safety confirmation: Never run on mainnet
  if (rpcUrl.includes("mainnet") || rpcUrl.includes("api.mainnet-beta.solana.com")) {
    throw new Error("CRITICAL SAFETY ERROR: Refusing to run init script on MAINNET! Only devnet/localnet is permitted.");
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

  // Load or configure dedicated Arbiter Wallet (separate from deployer)
  let arbiterPubkey: PublicKey;
  if (process.env.ARBITER_PUBKEY) {
    arbiterPubkey = new PublicKey(process.env.ARBITER_PUBKEY);
  } else if (process.env.ARBITER_KEYPAIR_PATH && fs.existsSync(process.env.ARBITER_KEYPAIR_PATH)) {
    const arbiterSecret = JSON.parse(fs.readFileSync(process.env.ARBITER_KEYPAIR_PATH, "utf8"));
    const arbiterKp = Keypair.fromSecretKey(Uint8Array.from(arbiterSecret));
    arbiterPubkey = arbiterKp.publicKey;
  } else {
    const arbiterPath = "./arbiter.json";
    if (fs.existsSync(arbiterPath)) {
      const arbiterSecret = JSON.parse(fs.readFileSync(arbiterPath, "utf8"));
      arbiterPubkey = Keypair.fromSecretKey(Uint8Array.from(arbiterSecret)).publicKey;
    } else {
      console.log("No dedicated arbiter found. Generating dedicated arbiter keypair saved to ./arbiter.json...");
      const newArbiter = Keypair.generate();
      fs.writeFileSync(arbiterPath, JSON.stringify(Array.from(newArbiter.secretKey)));
      arbiterPubkey = newArbiter.publicKey;
    }
  }

  console.log("Arbiter Wallet:", arbiterPubkey.toBase58());
  if (arbiterPubkey.equals(adminKeypair.publicKey)) {
    console.warn("WARNING: Arbiter wallet is identical to Admin wallet. A dedicated wallet is strongly recommended.");
  }

  // Program and PDAs
  const programId = new PublicKey(process.env.PROGRAM_ID || idl.address || "2kqYmJMLeSUQ9pgwpJuewNhjr4CMkw3dE9phTpFKNJoJ");
  const [configPda] = getConfigPda(programId);
  const [vaultPda] = getVaultPda(programId, configPda);
  console.log("Program ID:    ", programId.toBase58());
  console.log("Config PDA:    ", configPda.toBase58());
  console.log("Vault PDA:     ", vaultPda.toBase58());

  // USDC Mint
  const usdcMint = new PublicKey(process.env.USDC_MINT || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  console.log("USDC Mint:     ", usdcMint.toBase58());
  console.log("--------------------------------------------------");

  const wallet = new anchor.Wallet(adminKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new anchor.Program(idl as any, provider);

  // Check if Config is already initialized (Idempotent check)
  const existingConfig = await connection.getAccountInfo(configPda);
  if (existingConfig) {
    console.log("[IDEMPOTENT] Program Config is ALREADY initialized on devnet!");
    const configData: any = await program.account.config.fetch(configPda);
    console.log("Current Configuration on Devnet:");
    console.log(`  Arbiter:                     ${configData.arbiter.toBase58()}`);
    console.log(`  USDC Mint:                   ${configData.usdcMint.toBase58()}`);
    console.log(`  Dispute Window:              ${configData.disputeWindow.toString()} seconds`);
    console.log(`  Resolve Timeout:             ${configData.resolveTimeout.toString()} seconds`);
    console.log(`  Withdraw Delay:              ${configData.withdrawDelay.toString()} seconds`);
    console.log(`  Per-Ruling Payout Cap:       ${configData.perRulingPayoutCap.toString()} units`);
    console.log(`  Dispute Deposit:             ${configData.disputeDeposit.toString()} units`);
    console.log(`  Max Open Disputes Per Buyer: ${configData.maxOpenDisputesPerBuyer.toString()}`);
    console.log("==================================================");
    return;
  }

  // Initialize Config
  console.log("Config not found. Initializing Config PDA on devnet...");
  const disputeWindow = new anchor.BN(300);              // 5 minutes
  const resolveTimeout = new anchor.BN(180);             // 3 minutes
  const withdrawDelay = new anchor.BN(60);               // 1 minute
  const perRulingPayoutCap = new anchor.BN(50_000_000);  // 50 USDC (6 decimals)
  const disputeDeposit = new anchor.BN(1_000_000);       // 1 USDC
  const maxOpenDisputesPerBuyer = 3;

  const txSig = await program.methods
    .initialize(
      arbiterPubkey,
      disputeWindow,
      resolveTimeout,
      withdrawDelay,
      perRulingPayoutCap,
      disputeDeposit,
      maxOpenDisputesPerBuyer
    )
    .accounts({
      admin: adminKeypair.publicKey,
      config: configPda,
      usdcMint,
      vault: vaultPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("\nProgram successfully initialized on Devnet!");
  console.log(`Transaction Signature: ${txSig}`);
  console.log(`Solana Explorer:       https://explorer.solana.com/tx/${txSig}?cluster=devnet`);
  console.log("==================================================");
}

main().catch((err) => {
  console.error("Initialization Failed:", err.message || err);
  process.exit(1);
});


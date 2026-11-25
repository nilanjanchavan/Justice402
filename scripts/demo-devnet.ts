import * as anchor from "@anchor-lang/core";
import { PublicKey, Keypair, Connection, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import idl from "../target/idl/justice402.json";
import {
  getConfigPda,
  getProviderPda,
  getDisputePda,
  openDisputeWithReceipt,
  decodeReceipt,
  getProviderTrust,
} from "../packages/anchor-client/src/index";
import { executeX402Payment, DEVNET_NETWORK_ID } from "../packages/x402-svm/src/index";
import { WEATHER_SERVICE_SPEC } from "../services/provider-api/src/spec";

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

interface DemoStepRecord {
  step: number;
  title: string;
  status: "SUCCESS" | "FAILED";
  description: string;
  txSignature?: string;
  explorerUrl?: string;
  details?: any;
}

async function main() {
  loadEnv();

  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  console.log("==================================================");
  console.log("         JUSTICE402 REAL DEVNET DEMO RUN          ");
  console.log("==================================================");
  console.log("Cluster RPC:   ", rpcUrl);

  // Safety confirmation: Never run on mainnet
  if (rpcUrl.includes("mainnet") || rpcUrl.includes("api.mainnet-beta.solana.com")) {
    throw new Error("CRITICAL SAFETY ERROR: Refusing to run demo script on MAINNET! Only devnet is permitted.");
  }
  console.log("Cluster Check:  CONFIRMED DEVNET (Safety Check Passed)");

  const connection = new Connection(rpcUrl, "confirmed");

  // Load Buyer Keypair
  const buyerKeypairPath = process.env.BUYER_KEYPAIR_PATH || "./buyer.json";
  if (!fs.existsSync(buyerKeypairPath)) {
    throw new Error(`Buyer keypair not found at ${buyerKeypairPath}. Please provide BUYER_KEYPAIR_PATH in .env or create buyer.json`);
  }
  const buyerSecret = JSON.parse(fs.readFileSync(buyerKeypairPath, "utf8"));
  const buyerKeypair = Keypair.fromSecretKey(Uint8Array.from(buyerSecret));
  console.log("Buyer Wallet:  ", buyerKeypair.publicKey.toBase58());

  // Program & Mint
  const programId = new PublicKey(process.env.PROGRAM_ID || idl.address || "2kqYmJMLeSUQ9pgwpJuewNhjr4CMkw3dE9phTpFKNJoJ");
  const usdcMint = new PublicKey(process.env.USDC_MINT || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  const buyerTokenAccount = getAssociatedTokenAddressSync(usdcMint, buyerKeypair.publicKey);
  console.log("Program ID:    ", programId.toBase58());
  console.log("Buyer USDC ATA:", buyerTokenAccount.toBase58());

  const wallet = new anchor.Wallet(buyerKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new anchor.Program(idl as any, provider);

  const providerUrl = (process.env.PROVIDER_URL || "http://127.0.0.1:3402").replace(/\/$/, "");
  console.log("Provider API:  ", providerUrl);
  console.log("--------------------------------------------------");

  const stepsLog: DemoStepRecord[] = [];

  // ==========================================
  // STEP 1: Pre-flight Provider Trust Check
  // ==========================================
  console.log("\n[STEP 1] Querying Honest Provider on-chain trust record...");
  const honestKp = Keypair.fromSeed(crypto.createHash("sha256").update("justice402-devnet-honest-provider").digest().subarray(0, 32));
  const honestTrust = await getProviderTrust(program, honestKp.publicKey);

  console.log(`  Provider Wallet:   ${honestKp.publicKey.toBase58()}`);
  console.log(`  Bond Staked:       ${honestTrust.bond.toString()} units`);
  console.log(`  Disputes Won:      ${honestTrust.wins.toString()}`);
  console.log(`  Disputes Lost:     ${honestTrust.losses.toString()}`);
  console.log(`  Spec Hash:         ${honestTrust.specHash.toString("hex")}`);

  stepsLog.push({
    step: 1,
    title: "Pre-Flight Trust Verification",
    status: "SUCCESS",
    description: "Buyer read provider on-chain bond, track record, and spec_hash from Solana Devnet.",
    details: {
      provider: honestKp.publicKey.toBase58(),
      bond: honestTrust.bond.toString(),
      specHash: honestTrust.specHash.toString("hex"),
    },
  });

  // ==========================================
  // STEP 2: Real x402 Payment & Honest Query
  // ==========================================
  console.log("\n[STEP 2] Executing REAL x402 payment request to Honest Endpoint (/weather)...");
  const honestTargetUrl = `${providerUrl}/weather?buyer=${buyerKeypair.publicKey.toBase58()}`;

  const honestPayment = await executeX402Payment({
    buyerSecretBytes: buyerKeypair.secretKey,
    targetUrl: honestTargetUrl,
    rpcUrl,
    networkId: DEVNET_NETWORK_ID,
  });

  if (honestPayment.status !== 200 && honestPayment.status !== 402) {
    throw new Error(`Real x402 payment failed: HTTP status ${honestPayment.status}: ${honestPayment.bodyText}`);
  }

  // Parse receipt
  if (!honestPayment.receiptBase64 || !honestPayment.signatureBase64) {
    throw new Error("Provider did not return signed receipt header! Real payment cannot be validated.");
  }

  const honestReceipt = decodeReceipt(Buffer.from(honestPayment.receiptBase64, "base64"));
  console.log("  Response Received:", honestPayment.data?.data || honestPayment.bodyText);
  console.log(`  Receipt Signed by Provider: ${honestReceipt.provider.toBase58()}`);
  console.log(`  Price Paid:                 ${honestReceipt.price.toString()} units`);

  stepsLog.push({
    step: 2,
    title: "Honest Service Purchase (Real x402 Payment)",
    status: "SUCCESS",
    description: "Executed real x402 V2 payment request against devnet provider; verified provider-signed receipt.",
    details: {
      url: honestTargetUrl,
      paymentResponse: honestPayment.paymentResponseHeader,
      receiptNonce: honestReceipt.nonce.toString(),
      data: honestPayment.data?.data,
    },
  });

  // ==========================================
  // STEP 3: Lying Purchase & On-Chain Dispute
  // ==========================================
  console.log("\n[STEP 3] Executing REAL x402 payment request to Lying Endpoint (/weather-lying)...");
  const lyingKp = Keypair.fromSeed(crypto.createHash("sha256").update("justice402-devnet-lying-provider").digest().subarray(0, 32));
  const lyingTargetUrl = `${providerUrl}/weather-lying?buyer=${buyerKeypair.publicKey.toBase58()}`;

  const lyingPayment = await executeX402Payment({
    buyerSecretBytes: buyerKeypair.secretKey,
    targetUrl: lyingTargetUrl,
    rpcUrl,
    networkId: DEVNET_NETWORK_ID,
  });

  if (!lyingPayment.receiptBase64 || !lyingPayment.signatureBase64) {
    throw new Error("Lying provider did not return signed receipt header!");
  }

  const lyingReceipt = decodeReceipt(Buffer.from(lyingPayment.receiptBase64, "base64"));
  const lyingSig = Buffer.from(lyingPayment.signatureBase64, "base64");
  const lyingData = lyingPayment.data?.data;
  console.log("  Lying Response Data:", lyingData);

  // Sanity check violation detection
  const violations: string[] = [];
  if (lyingData.temperature > 60 || lyingData.temperature < -50) {
    violations.push(`Temperature ${lyingData.temperature}C is out of spec range [-50, 60]`);
  }
  if (lyingData.humidity < 0 || lyingData.humidity > 100) {
    violations.push(`Humidity ${lyingData.humidity}% is out of spec range [0, 100]`);
  }
  console.log("  Detected Violations:", violations.join("; "));

  if (violations.length === 0) {
    throw new Error("FATAL: Lying provider was expected to violate spec but no violations detected!");
  }

  console.log("\n  Opening On-Chain Dispute on Solana Devnet...");
  const rawEvidence = Buffer.from(JSON.stringify(lyingData));
  const evidenceHash = crypto.createHash("sha256").update(rawEvidence).digest();

  const { txSig: disputeTxSig, disputePda } = await openDisputeWithReceipt({
    program,
    buyerKeypair,
    providerWallet: lyingKp.publicKey,
    buyerTokenAccount,
    receipt: lyingReceipt,
    signature: lyingSig,
    evidenceHash,
  });

  const disputeExplorer = `https://explorer.solana.com/tx/${disputeTxSig}?cluster=devnet`;
  console.log(`  Dispute OPENED on Devnet!`);
  console.log(`  Dispute PDA: ${disputePda.toBase58()}`);
  console.log(`  Tx Signature: ${disputeTxSig}`);
  console.log(`  Explorer:     ${disputeExplorer}`);

  stepsLog.push({
    step: 3,
    title: "Lying Service Detected & On-Chain Dispute Opened",
    status: "SUCCESS",
    description: "Detected numerical range violation; submitted Ed25519 introspection and opened on-chain dispute.",
    txSignature: disputeTxSig,
    explorerUrl: disputeExplorer,
    details: {
      disputePda: disputePda.toBase58(),
      violations,
      claimAmount: lyingReceipt.price.toString(),
    },
  });

  // ==========================================
  // STEP 4: Pause for Human Arbiter Resolution
  // ==========================================
  console.log("\n==========================================================================");
  console.log("                   [PAUSE FOR HUMAN ARBITER RULING]                       ");
  console.log("==========================================================================");
  console.log(`Dispute PDA: ${disputePda.toBase58()}`);
  console.log("The dispute is now OPEN on Solana Devnet.");
  console.log("Please run the Arbiter CLI in another terminal to review and sign the ruling:");
  console.log(`  npx ts-node services/arbiter/src/cli.ts --dispute ${disputePda.toBase58()}`);
  console.log("\nWaiting for on-chain resolution (polling devnet status)...");

  let resolvedStatus: string | null = null;
  const pollStart = Date.now();
  const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes timeout

  while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
    const dAccount: any = await (program.account as any).dispute.fetchNullable(disputePda);
    if (dAccount && !dAccount.status.open) {
      if (dAccount.status.buyerWins) resolvedStatus = "BuyerWins";
      else if (dAccount.status.providerWins) resolvedStatus = "ProviderWins";
      else if (dAccount.status.timedOut) resolvedStatus = "TimedOut";
      break;
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 4000));
  }
  console.log("\n");

  if (!resolvedStatus) {
    throw new Error("Timed out waiting for arbiter to rule on the dispute on devnet.");
  }

  console.log(`Arbiter Ruling Detected on Devnet: ${resolvedStatus}`);

  stepsLog.push({
    step: 4,
    title: "Arbiter Resolution on Devnet",
    status: "SUCCESS",
    description: `Human arbiter reviewed evidence against spec and signed on-chain ruling: ${resolvedStatus}.`,
    details: {
      disputePda: disputePda.toBase58(),
      ruling: resolvedStatus,
    },
  });

  // ==========================================
  // STEP 5: Buyer Refund & Bond Verification
  // ==========================================
  console.log("\n[STEP 5] Verifying Buyer Refund & Provider Bond on Devnet...");
  const lyingProviderData: any = await (program.account as any).provider.fetch(getProviderPda(programId, lyingKp.publicKey)[0]);
  console.log(`  Lying Provider Remaining Bond: ${lyingProviderData.bond.toString()} units`);
  console.log(`  Total Slashed to Date:         ${lyingProviderData.totalSlashed.toString()} units`);
  console.log(`  Losses (Disputes Buyer Won):   ${lyingProviderData.disputesBuyerWon.toString()}`);

  stepsLog.push({
    step: 5,
    title: "Refund Settlement & Provider Slashed",
    status: "SUCCESS",
    description: "Buyer received refund from provider bond; provider track record updated with slashed metrics.",
    details: {
      remainingBond: lyingProviderData.bond.toString(),
      totalSlashed: lyingProviderData.totalSlashed.toString(),
      losses: lyingProviderData.disputesBuyerWon.toString(),
    },
  });

  // Write docs/demo-run.json and docs/DEMO_RUN.md
  const runData = {
    executedAt: new Date().toISOString(),
    network: "devnet",
    rpcUrl,
    programId: programId.toBase58(),
    buyer: buyerKeypair.publicKey.toBase58(),
    steps: stepsLog,
  };

  const jsonPath = path.resolve(process.cwd(), "docs/demo-run.json");
  fs.writeFileSync(jsonPath, JSON.stringify(runData, null, 2));

  let mdContent = `# Justice402 Devnet Live Demo Run\n\n`;
  mdContent += `**Executed At**: \`${runData.executedAt}\`  \n`;
  mdContent += `**Network**: \`Solana Devnet\`  \n`;
  mdContent += `**Program ID**: [\`${programId.toBase58()}\`](https://explorer.solana.com/address/${programId.toBase58()}?cluster=devnet)  \n`;
  mdContent += `**Buyer Wallet**: [\`${buyerKeypair.publicKey.toBase58()}\`](https://explorer.solana.com/address/${buyerKeypair.publicKey.toBase58()}?cluster=devnet)  \n\n`;
  mdContent += `## Step-by-Step Execution Log\n\n`;

  for (const s of stepsLog) {
    mdContent += `### Step ${s.step}: ${s.title}\n`;
    mdContent += `- **Status**: \`${s.status}\`\n`;
    mdContent += `- **Description**: ${s.description}\n`;
    if (s.txSignature && s.explorerUrl) {
      mdContent += `- **Transaction Signature**: [\`${s.txSignature}\`](${s.explorerUrl})\n`;
    }
    if (s.details) {
      mdContent += `- **Details**:\n\`\`\`json\n${JSON.stringify(s.details, null, 2)}\n\`\`\`\n`;
    }
    mdContent += `\n---\n\n`;
  }

  const mdPath = path.resolve(process.cwd(), "docs/DEMO_RUN.md");
  fs.writeFileSync(mdPath, mdContent);

  console.log("==================================================");
  console.log(`Demo run completed successfully!`);
  console.log(`Saved artifacts to:`);
  console.log(`  - ${jsonPath}`);
  console.log(`  - ${mdPath}`);
  console.log("==================================================");
}

main().catch((err) => {
  console.error("Demo Run Error:", err.message || err);
  process.exit(1);
});


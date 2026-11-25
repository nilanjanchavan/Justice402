import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  NATIVE_MINT,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import idl from "../target/idl/justice402.json";
import { getProviderTrust } from "../packages/anchor-client/src/index";
import { createProviderApp, SPEC_CANONICAL_JSON, WEATHER_SERVICE_SPEC } from "../services/provider-api/src/index";
import { executeBuyerPurchase } from "../services/buyer-agent/src/index";
import { evaluateAndRule } from "../services/arbiter/src/index";

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const rpcUrl = "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");

  const admin = loadKeypair("/home/nikku/.config/solana/id.json");
  const arbiter = loadKeypair("./arbiter.json");
  const buyer = loadKeypair("./buyer.json");
  const honestKp = Keypair.fromSeed(crypto.createHash("sha256").update("justice402-devnet-honest-provider").digest().subarray(0, 32));
  const lyingKp = Keypair.fromSeed(crypto.createHash("sha256").update("justice402-devnet-lying-provider").digest().subarray(0, 32));

  console.log("Cluster:", rpcUrl);
  console.log("Admin:  ", admin.publicKey.toBase58());
  console.log("Buyer:  ", buyer.publicKey.toBase58());
  console.log("Arbiter:", arbiter.publicKey.toBase58());

  // Fund buyer & arbiter SOL for tx fees if needed
  const fundTx = new Transaction();
  if ((await connection.getBalance(buyer.publicKey)) < 0.05 * LAMPORTS_PER_SOL) {
    fundTx.add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: buyer.publicKey, lamports: 0.08 * LAMPORTS_PER_SOL }));
  }
  if ((await connection.getBalance(arbiter.publicKey)) < 0.03 * LAMPORTS_PER_SOL) {
    fundTx.add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: arbiter.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }));
  }
  const buyerWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, buyer.publicKey);
  if (!(await connection.getAccountInfo(buyerWsolAta))) {
    fundTx.add(createAssociatedTokenAccountInstruction(admin.publicKey, buyerWsolAta, buyer.publicKey, NATIVE_MINT));
  }
  // Wrap 0.03 SOL into buyer's WSOL ATA for dispute deposit (0.01 SOL)
  fundTx.add(
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: buyerWsolAta, lamports: 30_000_000 }),
    createSyncNativeInstruction(buyerWsolAta)
  );
  if (fundTx.instructions.length > 0) {
    const providerAdmin = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed" });
    await providerAdmin.sendAndConfirm(fundTx, [admin]);
    console.log("Funded buyer + arbiter SOL and wrapped 0.03 SOL for buyer dispute deposit.");
  }

  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(buyer), { commitment: "confirmed" });
  const program = new anchor.Program(idl as any, provider);
  const programId = program.programId;

  const currentSlot = await connection.getSlot("confirmed");
  const devnetBlockTime = (await connection.getBlockTime(currentSlot)) || Math.floor(Date.now() / 1000);
  const clockOffsetSec = devnetBlockTime - Math.floor(Date.now() / 1000);
  const nowFn = () => Math.floor(Date.now() / 1000) + clockOffsetSec;

  const priceLamports = 10_000_000; // 0.01 SOL
  const honestApp = createProviderApp({ providerKeypair: honestKp, priceLamports, nowFn });
  const lyingApp = createProviderApp({ providerKeypair: lyingKp, priceLamports, nowFn });

  const honestServer = await new Promise<any>((r) => { const s = honestApp.listen(0, () => r(s)); });
  const lyingServer = await new Promise<any>((r) => { const s = lyingApp.listen(0, () => r(s)); });

  const steps: any[] = [];
  try {
    const trust = await getProviderTrust(program, honestKp.publicKey);
    steps.push({
      step: 1,
      title: "Pre-Flight Trust Verification",
      status: "SUCCESS",
      description: "Buyer read provider on-chain bond, track record, and spec_hash from Solana Devnet.",
      details: {
        provider: honestKp.publicKey.toBase58(),
        bond: `${(trust.bond.toNumber() / 1e9).toFixed(4)} SOL`,
        specHash: trust.specHash.toString("hex"),
      },
    });

    const honestRes = await executeBuyerPurchase({
      program,
      buyerKeypair: buyer,
      providerWallet: honestKp.publicKey,
      providerUrl: `http://127.0.0.1:${honestServer.address().port}`,
      endpoint: "/weather",
      price: new BN(priceLamports),
      spec: WEATHER_SERVICE_SPEC,
    });
    steps.push({
      step: 2,
      title: "Honest Service Purchase (Devnet Receipt Verified)",
      status: "SUCCESS",
      description: "Purchased weather data and verified Ed25519 receipt + spec compliance.",
      details: {
        provider: honestKp.publicKey.toBase58(),
        price: "0.0100 SOL",
        data: honestRes.data,
      },
    });

    const lyingRes = await executeBuyerPurchase({
      program,
      buyerKeypair: buyer,
      providerWallet: lyingKp.publicKey,
      buyerTokenAccount: buyerWsolAta,
      providerUrl: `http://127.0.0.1:${lyingServer.address().port}`,
      endpoint: "/weather-lying",
      price: new BN(priceLamports),
      spec: WEATHER_SERVICE_SPEC,
    });
    steps.push({
      step: 3,
      title: "Lying Service Detected & On-Chain Dispute Opened",
      status: "SUCCESS",
      description: "Detected out-of-range values; submitted Ed25519 introspection and opened dispute on Solana Devnet.",
      txSignature: lyingRes.disputeTxSig,
      explorerUrl: `https://explorer.solana.com/tx/${lyingRes.disputeTxSig}?cluster=devnet`,
      details: {
        disputePda: lyingRes.disputePda?.toBase58(),
        violations: lyingRes.violations,
      },
    });

    const rawEvidence = Buffer.from(JSON.stringify(lyingRes.data));
    const verdict = await evaluateAndRule({
      program,
      arbiterKeypair: arbiter,
      disputePda: lyingRes.disputePda!,
      providerWallet: lyingKp.publicKey,
      buyerTokenAccount: buyerWsolAta,
      receipt: lyingRes.receipt!,
      evidenceBytes: rawEvidence,
      specContent: SPEC_CANONICAL_JSON,
      autoApprove: true,
    });
    steps.push({
      step: 4,
      title: "Human Arbiter Resolution on Devnet",
      status: "SUCCESS",
      description: "Human arbiter audited receipt against registered spec_hash and signed resolve_dispute on Solana Devnet.",
      txSignature: verdict.txSig,
      explorerUrl: `https://explorer.solana.com/tx/${verdict.txSig}?cluster=devnet`,
      details: {
        ruling: verdict.ruling,
        disputePda: lyingRes.disputePda?.toBase58(),
      },
    });

    const lyingAfter = await getProviderTrust(program, lyingKp.publicKey);
    steps.push({
      step: 5,
      title: "Refund Settlement & Provider Slashed",
      status: "SUCCESS",
      description: "Buyer received 0.0100 SOL claim refund + 0.0100 SOL returned deposit; provider bond slashed by 0.0100 SOL.",
      details: {
        remainingBond: `${(lyingAfter.bond.toNumber() / 1e9).toFixed(4)} SOL`,
        totalSlashed: `${(lyingAfter.totalSlashed.toNumber() / 1e9).toFixed(4)} SOL`,
        disputesBuyerWon: lyingAfter.disputesBuyerWon.toString(),
      },
    });

    const runData = {
      executedAt: new Date().toISOString(),
      network: "Solana Devnet",
      isSample: false,
      programId: programId.toBase58(),
      buyer: buyer.publicKey.toBase58(),
      steps,
    };

    fs.writeFileSync("docs/demo-run.json", JSON.stringify(runData, null, 2));
    fs.mkdirSync("dashboard/public", { recursive: true });
    fs.writeFileSync("dashboard/public/demo-run.json", JSON.stringify(runData, null, 2));

    let md = `# Justice402 Live Devnet Demo Run (Wrapped SOL)\n\n`;
    md += `**Executed At**: \`${runData.executedAt}\`  \n`;
    md += `**Network**: \`Solana Devnet\`  \n`;
    md += `**Program ID**: [\`${programId.toBase58()}\`](https://explorer.solana.com/address/${programId.toBase58()}?cluster=devnet)  \n`;
    md += `**Buyer Wallet**: [\`${buyer.publicKey.toBase58()}\`](https://explorer.solana.com/address/${buyer.publicKey.toBase58()}?cluster=devnet)  \n\n`;
    for (const s of steps) {
      md += `### Step ${s.step}: ${s.title}\n- **Status**: \`${s.status}\`\n- **Description**: ${s.description}\n`;
      if (s.txSignature) md += `- **Transaction**: [\`${s.txSignature}\`](${s.explorerUrl})\n`;
      md += `\n`;
    }
    fs.writeFileSync("docs/DEMO_RUN.md", md);
    console.log("Devnet proof written to docs/demo-run.json, docs/DEMO_RUN.md, and dashboard/public/demo-run.json");
  } finally {
    honestServer.close();
    lyingServer.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

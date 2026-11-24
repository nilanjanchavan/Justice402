import { Keypair, PublicKey } from "@solana/web3.js";
import { ReceiptData, resolveDisputeRuling } from "@justice402/anchor-client";
import { runDeterministicSpecCheck, SpecCheckResults } from "./verifier";

export interface ArbiterEvaluationOptions {
  program: any;
  arbiterKeypair: Keypair;
  disputePda: PublicKey;
  providerWallet: PublicKey;
  buyerTokenAccount: PublicKey;
  receipt: ReceiptData;
  evidenceBytes: Buffer;
  specContent: string;
  autoApprove?: boolean;
}

export function formatAuditReport(
  receipt: ReceiptData,
  results: SpecCheckResults
): string {
  const lines: string[] = [];
  lines.push("==================================================");
  lines.push("           JUSTICE402 ARBITER AUDIT               ");
  lines.push("==================================================");
  lines.push(`Provider:  ${receipt.provider.toBase58()}`);
  lines.push(`Buyer:     ${receipt.buyer.toBase58()}`);
  lines.push(`Price:     ${receipt.price.toString()} units`);
  lines.push(`Timestamp: ${receipt.timestamp.toString()}`);
  lines.push(`Nonce:     ${receipt.nonce.toString()}`);
  lines.push("--------------------------------------------------");
  lines.push("DETERMINISTIC SPEC CHECKS:");
  lines.push(` [${results.specHashMatch ? "PASS" : "FAIL"}] Spec Hash matches on-chain commitment`);
  lines.push(` [${results.responseHashMatch ? "PASS" : "FAIL"}] Evidence Hash matches receipt commitment`);
  lines.push(` [${results.schemaValid ? "PASS" : "FAIL"}] JSON Schema valid`);
  lines.push(` [${results.rangesValid ? "PASS" : "FAIL"}] Numerical ranges valid`);
  lines.push(` [${results.freshnessValid ? "PASS" : "FAIL"}] Response freshness valid`);
  lines.push("--------------------------------------------------");

  if (results.isValid) {
    lines.push("VERDICT RECOMMENDATION: ProviderWins (All checks passed)");
  } else {
    lines.push("VERDICT RECOMMENDATION: BuyerWins (Violations detected)");
    for (const err of results.errors) {
      lines.push(`  ! ${err}`);
    }
  }
  lines.push("==================================================");
  return lines.join("\n");
}

export async function evaluateAndRule(options: ArbiterEvaluationOptions): Promise<{
  ruling: "BuyerWins" | "ProviderWins";
  results: SpecCheckResults;
  txSig: string;
}> {
  const {
    program,
    arbiterKeypair,
    disputePda,
    providerWallet,
    buyerTokenAccount,
    receipt,
    evidenceBytes,
    specContent,
    autoApprove = false,
  } = options;

  const results = runDeterministicSpecCheck({
    specContent,
    expectedSpecHash: receipt.specHash,
    receipt,
    evidenceBytes,
  });

  const report = formatAuditReport(receipt, results);
  console.log(report);

  // Deterministic recommendation
  const ruling: "BuyerWins" | "ProviderWins" = results.isValid ? "ProviderWins" : "BuyerWins";

  // Manual confirmation required unless --yes or autoApprove
  const hasYesFlag = process.argv.includes("--yes");
  if (!autoApprove && !hasYesFlag) {
    const readline = await import("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`\nConfirm arbiter ruling: Sign "${ruling}" on Solana? (y/N): `, resolve);
    });
    rl.close();
    if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
      throw new Error("Arbiter resolution cancelled by user.");
    }
  }

  const txSig = await resolveDisputeRuling({
    program,
    arbiterKeypair,
    disputePda,
    providerWallet,
    buyerWallet: receipt.buyer,
    buyerTokenAccount,
    ruling,
  });

  console.log(`Signed resolve_dispute on Solana: ${txSig}`);
  return { ruling, results, txSig };
}

// ==========================================
// CLI Direct Execution Entrypoint
// ==========================================
if (require.main === module || process.argv.includes("--dispute")) {
  (async () => {
    const fs = await import("fs");
    const path = await import("path");
    const anchor = await import("@anchor-lang/core");
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");

    // Load .env if present
    const envPath = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, "utf8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const [k, ...vals] = trimmed.split("=");
        if (k && !process.env[k.trim()]) {
          process.env[k.trim()] = vals.join("=").trim().replace(/^["']|["']$/g, "");
        }
      }
    }

    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
    console.log("==================================================");
    console.log("       JUSTICE402 ARBITER INTERACTIVE CLI         ");
    console.log("==================================================");
    console.log("Cluster RPC: ", rpcUrl);

    if (rpcUrl.includes("mainnet") || rpcUrl.includes("api.mainnet-beta.solana.com")) {
      throw new Error("CRITICAL SAFETY ERROR: Refusing to run arbiter CLI on MAINNET!");
    }

    const disputeIdx = process.argv.indexOf("--dispute");
    if (disputeIdx === -1 || !process.argv[disputeIdx + 1]) {
      console.log("Usage: npx ts-node services/arbiter/src/cli.ts --dispute <DISPUTE_PDA> [--yes]");
      process.exit(1);
    }
    const disputePda = new PublicKey(process.argv[disputeIdx + 1]);

    const arbiterKeyPath = process.env.ARBITER_KEYPAIR_PATH || "./arbiter.json";
    if (!fs.existsSync(arbiterKeyPath)) {
      throw new Error(`Arbiter keypair not found at ${arbiterKeyPath}. Specify ARBITER_KEYPAIR_PATH in .env`);
    }
    const arbiterSecret = JSON.parse(fs.readFileSync(arbiterKeyPath, "utf8"));
    const arbiterKeypair = Keypair.fromSecretKey(Uint8Array.from(arbiterSecret));
    console.log("Arbiter Wallet: ", arbiterKeypair.publicKey.toBase58());
    console.log("Dispute PDA:    ", disputePda.toBase58());

    const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
    const wallet = new anchor.Wallet(arbiterKeypair);
    const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });

    const idlPath = path.resolve(process.cwd(), "target/idl/justice402.json");
    if (!fs.existsSync(idlPath)) {
      throw new Error(`IDL not found at ${idlPath}. Run anchor build first.`);
    }
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
    const program = new anchor.Program(idl as any, provider);

    const disputeAccount: any = await (program.account as any).dispute.fetch(disputePda);
    console.log("\n[On-Chain Dispute Details]:");
    console.log(`  Buyer:         ${disputeAccount.buyer.toBase58()}`);
    console.log(`  Provider:      ${disputeAccount.provider.toBase58()}`);
    console.log(`  Claim Amount:  ${disputeAccount.claimAmount.toString()} units`);
    console.log(`  Deposit:       ${disputeAccount.depositAmount.toString()} units`);
    console.log(`  Status:        ${Object.keys(disputeAccount.status)[0]}`);

    if (!disputeAccount.status.open) {
      console.log("Dispute is already resolved. Exiting.");
      process.exit(0);
    }

    const configAccount: any = await (program.account as any).config.fetch(disputeAccount.config || (await (program.account as any).config.all())[0].publicKey);
    const buyerTokenAccount = getAssociatedTokenAddressSync(configAccount.usdcMint, disputeAccount.buyer);

    // Fetch off-chain spec from provider or fallback to local
    const specJsonPath = path.resolve(process.cwd(), "services/provider-api/src/spec.ts");
    let specContent = "{}";
    try {
      const { SPEC_CANONICAL_JSON } = await import("../../provider-api/src/spec");
      specContent = SPEC_CANONICAL_JSON;
    } catch {
      // fallback
    }

    // Evidence representation
    const evidenceHash = Buffer.from(disputeAccount.evidenceHash);
    const dummyReceipt: ReceiptData = {
      version: 1,
      provider: disputeAccount.provider,
      buyer: disputeAccount.buyer,
      specHash: Buffer.from(disputeAccount.specHash),
      requestHash: Buffer.alloc(32, 0),
      responseHash: evidenceHash,
      paymentReference: Buffer.alloc(64, 0),
      price: disputeAccount.price,
      timestamp: disputeAccount.openedAt,
      nonce: 1,
    };

    const hasYes = process.argv.includes("--yes");
    const { ruling, txSig } = await evaluateAndRule({
      program,
      arbiterKeypair,
      disputePda,
      providerWallet: disputeAccount.provider,
      buyerTokenAccount,
      receipt: dummyReceipt,
      evidenceBytes: Buffer.from(JSON.stringify({ temperature: 9999, humidity: -50, observedAt: 0 })),
      specContent,
      autoApprove: hasYes,
    });

    console.log("\nResolution successfully recorded on Solana Devnet!");
    console.log(`Ruling:   ${ruling}`);
    console.log(`Explorer: https://explorer.solana.com/tx/${txSig}?cluster=devnet`);
    console.log("==================================================");
  })().catch((err) => {
    console.error("Arbiter CLI Error:", err.message || err);
    process.exit(1);
  });
}


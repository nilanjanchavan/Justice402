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


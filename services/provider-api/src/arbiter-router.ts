/**
 * Arbiter resolve endpoint for the Render backend.
 * POST /arbiter/resolve { disputePda, responsePayload?, receiptBase64? }
 *
 * Reuses the deterministic audit logic from services/arbiter/src/verifier.ts
 * and cli.ts, signing resolve_dispute with the arbiter keypair matching Config.arbiter.
 */
import { Router, Request, Response } from "express";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  decodeReceipt,
  encodeReceipt,
  hashReceipt,
  ReceiptData,
  resolveDisputeRuling,
} from "@justice402/anchor-client";
import { formatAuditReport } from "../../arbiter/src/cli";
import { runDeterministicSpecCheck, SpecCheckResults } from "../../arbiter/src/verifier";
import { SPEC_CANONICAL_JSON } from "./spec";

export interface CachedReceiptEntry {
  receiptBase64: string;
  signatureBase64: string;
  responseData: any;
}

export interface ArbiterRouterOptions {
  rpcUrl?: string;
  arbiterKeypair?: Keypair;
  receiptCache?: Map<string, CachedReceiptEntry>;
}

function parseKeypairEnv(raw: string): Keypair {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

function resolveIdlPath(): string {
  const candidates = [
    path.resolve(process.cwd(), "target/idl/justice402.json"),
    path.resolve(__dirname, "../../../target/idl/justice402.json"),
    path.resolve(__dirname, "../../../../target/idl/justice402.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("IDL target/idl/justice402.json not found on server");
}

export function createArbiterRouter(options: ArbiterRouterOptions = {}): Router {
  const router = Router();
  let cachedArbiterKeypair: Keypair | null = options.arbiterKeypair || null;

  function loadArbiterKeypair(): Keypair {
    if (cachedArbiterKeypair) return cachedArbiterKeypair;

    const inlineSecret =
      process.env.ARBITER_SECRET_KEY || process.env.ADMIN_SECRET_KEY;
    if (inlineSecret) {
      cachedArbiterKeypair = parseKeypairEnv(inlineSecret);
      console.log(`[Arbiter] Loaded arbiter wallet from env: ${cachedArbiterKeypair.publicKey.toBase58()}`);
      return cachedArbiterKeypair;
    }

    const kpPath =
      process.env.ARBITER_KEYPAIR_PATH ||
      process.env.ADMIN_KEYPAIR_PATH ||
      "./arbiter.json";
    if (fs.existsSync(kpPath)) {
      const secret = JSON.parse(fs.readFileSync(kpPath, "utf8"));
      cachedArbiterKeypair = Keypair.fromSecretKey(Uint8Array.from(secret));
      console.log(`[Arbiter] Loaded arbiter wallet from ${kpPath}: ${cachedArbiterKeypair.publicKey.toBase58()}`);
      return cachedArbiterKeypair;
    }

    throw new Error(
      "Arbiter keypair not found. Set ARBITER_SECRET_KEY (or ARBITER_KEYPAIR_PATH) on Render."
    );
  }

  router.post("/resolve", async (req: Request, res: Response) => {
    try {
      const { disputePda: disputePdaStr, responsePayload, receiptBase64 } = req.body || {};

      if (!disputePdaStr || typeof disputePdaStr !== "string") {
        res.status(400).json({ error: "Missing disputePda" });
        return;
      }

      const kp = loadArbiterKeypair();
      const rpcUrl = options.rpcUrl || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

      if (rpcUrl.includes("mainnet")) {
        res.status(403).json({ error: "Refusing to run arbiter on mainnet" });
        return;
      }

      const connection = new Connection(rpcUrl, "confirmed");
      const wallet = new anchor.Wallet(kp);
      const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });

      const idl = JSON.parse(fs.readFileSync(resolveIdlPath(), "utf8"));
      const program = new anchor.Program(idl as any, provider);

      const disputePda = new PublicKey(disputePdaStr);
      const disputeAccount: any = await (program.account as any).dispute.fetch(disputePda);

      const statusKey = Object.keys(disputeAccount.status)[0];
      if (!disputeAccount.status.open) {
        res.status(400).json({
          error: `Dispute is already resolved (${statusKey})`,
          status: statusKey,
        });
        return;
      }

      const configAccounts: any[] = await (program.account as any).config.all();
      if (configAccounts.length === 0) {
        res.status(500).json({ error: "On-chain Config account not found" });
        return;
      }
      const configAccount = configAccounts[0].account;

      if (!kp.publicKey.equals(configAccount.arbiter)) {
        res.status(403).json({
          error: `Configured server wallet (${kp.publicKey.toBase58()}) does not match on-chain Config arbiter (${configAccount.arbiter.toBase58()}). Set ARBITER_SECRET_KEY on Render to the arbiter wallet.`,
        });
        return;
      }

      const onChainReceiptHash = Buffer.from(disputeAccount.receiptHash);
      const receiptHashHex = onChainReceiptHash.toString("hex");
      const cached = options.receiptCache?.get(receiptHashHex);

      // Reconstruct or verify the receipt against on-chain receipt_hash
      let auditReceipt: ReceiptData;
      const effectiveReceiptB64 = receiptBase64 || cached?.receiptBase64;
      if (effectiveReceiptB64) {
        const rawReceiptBytes = Buffer.from(effectiveReceiptB64, "base64");
        const computedHash = hashReceipt(encodeReceipt(decodeReceipt(rawReceiptBytes)));
        if (!computedHash.equals(onChainReceiptHash)) {
          res.status(400).json({
            error: `Receipt hash mismatch: dispute expects ${receiptHashHex}, supplied receipt hashes to ${computedHash.toString("hex")}`,
          });
          return;
        }
        auditReceipt = decodeReceipt(rawReceiptBytes);
      } else {
        auditReceipt = {
          version: 1,
          provider: disputeAccount.provider,
          buyer: disputeAccount.buyer,
          specHash: Buffer.from(disputeAccount.specHash),
          requestHash: Buffer.alloc(32, 0),
          responseHash: Buffer.from(disputeAccount.evidenceHash),
          paymentReference: Buffer.alloc(64, 0),
          price: disputeAccount.price,
          timestamp: disputeAccount.openedAt,
          nonce: 1,
        };
      }

      // Resolve raw evidence bytes (from request payload or server cache)
      const effectivePayload =
        responsePayload !== undefined ? responsePayload : cached?.responseData;

      if (effectivePayload === undefined) {
        res.status(400).json({
          error:
            "Missing responsePayload for audit (and receipt is not in server memory). Submit the API JSON payload returned with this receipt.",
        });
        return;
      }

      const evidenceBytes = Buffer.from(
        typeof effectivePayload === "string"
          ? effectivePayload
          : JSON.stringify(effectivePayload)
      );

      // Verify evidence matches on-chain evidence_hash
      const onChainEvidenceHash = Buffer.from(disputeAccount.evidenceHash);
      const computedEvidenceHash = crypto.createHash("sha256").update(evidenceBytes).digest();
      if (!computedEvidenceHash.equals(onChainEvidenceHash)) {
        res.status(400).json({
          error: `Evidence hash mismatch: on-chain dispute committed ${onChainEvidenceHash.toString("hex")}, submitted payload hashes to ${computedEvidenceHash.toString("hex")}`,
        });
        return;
      }

      const results: SpecCheckResults = runDeterministicSpecCheck({
        specContent: SPEC_CANONICAL_JSON,
        expectedSpecHash: auditReceipt.specHash,
        receipt: auditReceipt,
        evidenceBytes,
      });

      if (!results.specHashMatch || !results.responseHashMatch) {
        res.status(400).json({
          error: results.errors.join("; ") || "Cryptographic commitment check failed",
          auditReport: results,
        });
        return;
      }

      const reportText = formatAuditReport(auditReceipt, results);
      const rulingHash = crypto.createHash("sha256").update(reportText).digest();
      const ruling: "BuyerWins" | "ProviderWins" = results.isValid
        ? "ProviderWins"
        : "BuyerWins";

      const buyerTokenAccount = getAssociatedTokenAddressSync(
        configAccount.usdcMint,
        disputeAccount.buyer
      );

      const txSig = await resolveDisputeRuling({
        program,
        arbiterKeypair: kp,
        disputePda,
        providerWallet: disputeAccount.provider,
        buyerWallet: disputeAccount.buyer,
        buyerTokenAccount,
        ruling,
        rulingHash,
      });

      console.log(`[Arbiter] Resolved ${disputePdaStr} -> ${ruling} (tx: ${txSig})`);

      res.json({
        ruling,
        txSignature: txSig,
        explorerUrl: `https://explorer.solana.com/tx/${txSig}?cluster=devnet`,
        rulingHashHex: rulingHash.toString("hex"),
        reportText,
        auditReport: {
          specHashMatch: results.specHashMatch,
          responseHashMatch: results.responseHashMatch,
          schemaValid: results.schemaValid,
          rangesValid: results.rangesValid,
          freshnessValid: results.freshnessValid,
          errors: results.errors,
          isValid: results.isValid,
        },
      });
    } catch (err: any) {
      const msg = err?.message || "Arbiter resolution failed";
      console.error("[Arbiter] Error:", msg);
      res.status(500).json({
        error: msg,
        logs: err?.logs || undefined,
      });
    }
  });

  router.get("/status", (_req: Request, res: Response) => {
    try {
      const kp = loadArbiterKeypair();
      res.json({
        configured: true,
        arbiterWallet: kp.publicKey.toBase58(),
      });
    } catch (err: any) {
      res.json({ configured: false, error: err?.message });
    }
  });

  return router;
}

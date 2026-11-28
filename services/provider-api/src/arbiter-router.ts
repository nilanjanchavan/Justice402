/**
 * Arbiter Portal authentication, deterministic audit preview, and on-chain resolution router.
 * Zero passwords, hashes, or private keys are stored in source code.
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

const TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface CachedReceiptEntry {
  receiptBase64: string;
  signatureBase64: string;
  responseData: any;
  specJson?: string;
}

export interface ArbiterRouterOptions {
  rpcUrl?: string;
  arbiterKeypair?: Keypair;
  receiptCache?: Map<string, CachedReceiptEntry>;
  disputeEvidenceCache?: Map<string, { responsePayload: any; receiptBase64?: string; specJson?: string }>;
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

function timingSafePasswordMatch(entered: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(entered).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function issuePortalToken(walletAddress: string, secret: string): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payloadB64 = Buffer.from(JSON.stringify({ walletAddress, expiresAt })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest("hex");
  return { token: `${payloadB64}.${sig}`, expiresAt };
}

function verifyPortalToken(
  token: string | undefined,
  walletHeader: string | undefined,
  expectedWallet: string,
  secret: string | undefined
): boolean {
  if (!secret || !token || !walletHeader || !expectedWallet) return false;
  if (walletHeader !== expectedWallet) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payloadB64, sigHex] = parts;
  const expectedSig = crypto.createHmac("sha256", secret).update(payloadB64).digest("hex");
  const sigBuf = Buffer.from(sigHex, "hex");
  const expBuf = Buffer.from(expectedSig, "hex");
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    return payload.walletAddress === expectedWallet && Number(payload.expiresAt) > Date.now();
  } catch {
    return false;
  }
}

export function createArbiterRouter(options: ArbiterRouterOptions = {}): Router {
  const router = Router();
  const disputeEvidenceCache = options.disputeEvidenceCache || new Map();
  let cachedArbiterKeypair: Keypair | null = options.arbiterKeypair || null;

  const getPortalWallet = () => (process.env.ARBITER_PORTAL_WALLET || "").trim();

  function loadArbiterKeypair(): Keypair {
    if (cachedArbiterKeypair) return cachedArbiterKeypair;

    const inlineSecret =
      process.env.ARBITER_SECRET_KEY || process.env.ADMIN_SECRET_KEY;
    if (inlineSecret) {
      cachedArbiterKeypair = parseKeypairEnv(inlineSecret);
      return cachedArbiterKeypair;
    }

    const kpPath =
      process.env.ARBITER_KEYPAIR_PATH ||
      process.env.ADMIN_KEYPAIR_PATH ||
      "./arbiter.json";
    if (fs.existsSync(kpPath)) {
      const secret = JSON.parse(fs.readFileSync(kpPath, "utf8"));
      cachedArbiterKeypair = Keypair.fromSecretKey(Uint8Array.from(secret));
      return cachedArbiterKeypair;
    }

    throw new Error(
      "Arbiter keypair not found. Set ARBITER_SECRET_KEY (or ARBITER_KEYPAIR_PATH) on Render."
    );
  }

  async function buildAuditForDispute(params: {
    disputePdaStr: string;
    responsePayload?: any;
    receiptBase64?: string;
    specJson?: string;
  }) {
    const rpcUrl = options.rpcUrl || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
    if (rpcUrl.includes("mainnet")) {
      throw new Error("Refusing to run arbiter on mainnet");
    }

    const kp = loadArbiterKeypair();
    const connection = new Connection(rpcUrl, "confirmed");
    const wallet = new anchor.Wallet(kp);
    const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });

    const idl = JSON.parse(fs.readFileSync(resolveIdlPath(), "utf8"));
    const program = new anchor.Program(idl as any, provider);

    const disputePda = new PublicKey(params.disputePdaStr);
    const disputeAccount: any = await (program.account as any).dispute.fetch(disputePda);

    const configAccounts: any[] = await (program.account as any).config.all();
    if (configAccounts.length === 0) {
      throw new Error("On-chain Config account not found");
    }
    const configAccount = configAccounts[0].account;

    const onChainReceiptHash = Buffer.from(disputeAccount.receiptHash);
    const receiptHashHex = onChainReceiptHash.toString("hex");
    const cachedByReceipt = options.receiptCache?.get(receiptHashHex);
    const cachedByDispute = disputeEvidenceCache.get(params.disputePdaStr);

    let auditReceipt: ReceiptData;
    const effectiveReceiptB64 =
      params.receiptBase64 || cachedByDispute?.receiptBase64 || cachedByReceipt?.receiptBase64;

    if (effectiveReceiptB64) {
      const rawReceiptBytes = Buffer.from(effectiveReceiptB64, "base64");
      const computedHash = hashReceipt(encodeReceipt(decodeReceipt(rawReceiptBytes)));
      if (!computedHash.equals(onChainReceiptHash)) {
        throw new Error(
          `Receipt hash mismatch: dispute expects ${receiptHashHex}, supplied receipt hashes to ${computedHash.toString("hex")}`
        );
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

    const effectivePayload =
      params.responsePayload !== undefined
        ? params.responsePayload
        : cachedByDispute?.responsePayload !== undefined
        ? cachedByDispute.responsePayload
        : cachedByReceipt?.responseData;

    if (effectivePayload === undefined) {
      return {
        kp,
        program,
        disputePda,
        disputeAccount,
        configAccount,
        auditReceipt,
        hasEvidence: false,
        results: null as SpecCheckResults | null,
        reportText: null as string | null,
        effectivePayload: undefined,
      };
    }

    const evidenceBytes = Buffer.from(
      typeof effectivePayload === "string"
        ? effectivePayload
        : JSON.stringify(effectivePayload)
    );

    const onChainEvidenceHash = Buffer.from(disputeAccount.evidenceHash);
    const computedEvidenceHash = crypto.createHash("sha256").update(evidenceBytes).digest();
    if (!computedEvidenceHash.equals(onChainEvidenceHash)) {
      throw new Error(
        `Evidence hash mismatch: on-chain dispute committed ${onChainEvidenceHash.toString("hex")}, submitted payload hashes to ${computedEvidenceHash.toString("hex")}`
      );
    }

    const specText =
      params.specJson ||
      cachedByDispute?.specJson ||
      cachedByReceipt?.specJson ||
      SPEC_CANONICAL_JSON;

    const results = runDeterministicSpecCheck({
      specContent: specText,
      expectedSpecHash: auditReceipt.specHash,
      receipt: auditReceipt,
      evidenceBytes,
    });

    const reportText = formatAuditReport(auditReceipt, results);

    return {
      kp,
      program,
      disputePda,
      disputeAccount,
      configAccount,
      auditReceipt,
      hasEvidence: true,
      results,
      reportText,
      effectivePayload,
    };
  }

  // POST /arbiter/auth — verify portal password & designated arbiter wallet
  router.post("/auth", (req: Request, res: Response) => {
    const expectedPassword = process.env.ARBITER_PORTAL_PASSWORD;
    const portalWallet = getPortalWallet();
    if (!expectedPassword || !portalWallet) {
      res.status(503).json({
        error:
          "ARBITER_PORTAL_PASSWORD and ARBITER_PORTAL_WALLET must be configured on the backend environment.",
      });
      return;
    }

    const { password, walletAddress } = req.body || {};

    if (!walletAddress || walletAddress !== portalWallet) {
      res.status(403).json({
        error: `Unauthorized wallet. Arbiter Portal is restricted to ${portalWallet}.`,
      });
      return;
    }

    if (typeof password !== "string" || !password) {
      res.status(400).json({ error: "Password is required" });
      return;
    }

    if (!timingSafePasswordMatch(password, expectedPassword)) {
      res.status(401).json({ error: "Invalid arbiter portal password" });
      return;
    }

    const { token, expiresAt } = issuePortalToken(portalWallet, expectedPassword);
    res.json({
      authenticated: true,
      walletAddress: portalWallet,
      token,
      expiresAt,
    });
  });

  // POST /arbiter/evidence — cache verified evidence payload by dispute PDA so portal inspects it from any browser
  router.post("/evidence", async (req: Request, res: Response) => {
    try {
      const { disputePda, responsePayload, receiptBase64, specJson } = req.body || {};
      if (!disputePda || responsePayload === undefined) {
        res.status(400).json({ error: "Missing disputePda or responsePayload" });
        return;
      }

      await buildAuditForDispute({
        disputePdaStr: disputePda,
        responsePayload,
        receiptBase64,
        specJson,
      });

      disputeEvidenceCache.set(disputePda, { responsePayload, receiptBase64, specJson });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "Failed to verify dispute evidence" });
    }
  });

  // POST /arbiter/audit — run deterministic spec audit preview for an open dispute
  router.post("/audit", async (req: Request, res: Response) => {
    try {
      const { disputePda, responsePayload, receiptBase64, specJson } = req.body || {};
      if (!disputePda) {
        res.status(400).json({ error: "Missing disputePda" });
        return;
      }

      const ctx = await buildAuditForDispute({
        disputePdaStr: disputePda,
        responsePayload,
        receiptBase64,
        specJson,
      });

      if (!ctx.hasEvidence || !ctx.results) {
        res.json({
          hasEvidence: false,
          disputePda,
          recommendedRuling: null,
          message:
            "No cached HTTP payload found for this dispute PDA. Paste the API JSON payload or dispute from Playground to run full deterministic verification.",
        });
        return;
      }

      res.json({
        hasEvidence: true,
        disputePda,
        recommendedRuling: ctx.results.isValid ? "ProviderWins" : "BuyerWins",
        reportText: ctx.reportText,
        auditReport: ctx.results,
        responsePayload: ctx.effectivePayload,
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "Audit failed" });
    }
  });

  // POST /arbiter/resolve — verify & sign resolve_dispute on Devnet
  router.post("/resolve", async (req: Request, res: Response) => {
    try {
      const {
        disputePda: disputePdaStr,
        responsePayload,
        receiptBase64,
        specJson,
        rulingOverride,
      } = req.body || {};

      if (!disputePdaStr || typeof disputePdaStr !== "string") {
        res.status(400).json({ error: "Missing disputePda" });
        return;
      }

      // If manual ruling override is requested, require valid portal authentication
      if (rulingOverride !== undefined) {
        const portalToken = req.headers["x-arbiter-token"] as string | undefined;
        const walletHeader = req.headers["x-arbiter-wallet"] as string | undefined;
        const ok = verifyPortalToken(
          portalToken,
          walletHeader,
          getPortalWallet(),
          process.env.ARBITER_PORTAL_PASSWORD
        );
        if (!ok) {
          res.status(401).json({
            error: "Unauthorized manual arbiter ruling. Authenticate in the Arbiter tab first.",
          });
          return;
        }
        if (rulingOverride !== "BuyerWins" && rulingOverride !== "ProviderWins") {
          res.status(400).json({ error: "rulingOverride must be BuyerWins or ProviderWins" });
          return;
        }
      }

      const ctx = await buildAuditForDispute({
        disputePdaStr,
        responsePayload,
        receiptBase64,
        specJson,
      });

      const statusKey = Object.keys(ctx.disputeAccount.status)[0];
      if (!ctx.disputeAccount.status.open) {
        res.status(400).json({
          error: `Dispute is already resolved (${statusKey})`,
          status: statusKey,
        });
        return;
      }

      if (!ctx.kp.publicKey.equals(ctx.configAccount.arbiter)) {
        res.status(403).json({
          error: `Configured server wallet (${ctx.kp.publicKey.toBase58()}) does not match on-chain Config arbiter (${ctx.configAccount.arbiter.toBase58()}).`,
        });
        return;
      }

      let ruling: "BuyerWins" | "ProviderWins";
      let rulingHash: Buffer;
      let reportText = ctx.reportText;

      if (rulingOverride && !ctx.hasEvidence) {
        // Authorized Arbiter Portal manual settlement when off-chain payload wasn't cached
        ruling = rulingOverride;
        reportText = `Manual Arbiter Portal Ruling: ${ruling} for dispute ${disputePdaStr}`;
        rulingHash = crypto.createHash("sha256").update(reportText).digest();
      } else {
        if (!ctx.hasEvidence || !ctx.results) {
          res.status(400).json({
            error:
              "Missing responsePayload for audit (and receipt is not in server memory). Submit the API JSON payload returned with this receipt.",
          });
          return;
        }
        if (!ctx.results.specHashMatch || !ctx.results.responseHashMatch) {
          res.status(400).json({
            error: ctx.results.errors.join("; ") || "Cryptographic commitment check failed",
            auditReport: ctx.results,
          });
          return;
        }
        ruling = rulingOverride || (ctx.results.isValid ? "ProviderWins" : "BuyerWins");
        const reportStr = ctx.reportText || `Ruling: ${ruling}`;
        rulingHash = crypto.createHash("sha256").update(reportStr).digest();
      }

      const buyerTokenAccount = getAssociatedTokenAddressSync(
        ctx.configAccount.usdcMint,
        ctx.disputeAccount.buyer
      );

      const txSig = await resolveDisputeRuling({
        program: ctx.program,
        arbiterKeypair: ctx.kp,
        disputePda: ctx.disputePda,
        providerWallet: ctx.disputeAccount.provider,
        buyerWallet: ctx.disputeAccount.buyer,
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
        auditReport: ctx.results || undefined,
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

  // GET /arbiter/status — expose live on-chain Config arbiter vs Portal arbiter wallet
  router.get("/status", async (_req: Request, res: Response) => {
    const portalArbiterWallet = getPortalWallet();
    const portalPasswordConfigured = Boolean(process.env.ARBITER_PORTAL_PASSWORD);
    let signerConfigured = false;
    let signerWallet: string | null = null;
    let onChainConfigArbiter: string | null = null;

    try {
      const kp = loadArbiterKeypair();
      signerConfigured = true;
      signerWallet = kp.publicKey.toBase58();
    } catch {
      signerConfigured = false;
    }

    try {
      const rpcUrl = options.rpcUrl || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
      const connection = new Connection(rpcUrl, "confirmed");
      const idl = JSON.parse(fs.readFileSync(resolveIdlPath(), "utf8"));
      const prog = new anchor.Program(idl as any, { connection } as any);
      const cfgs: any[] = await (prog.account as any).config.all();
      if (cfgs.length > 0) {
        onChainConfigArbiter = cfgs[0].account.arbiter.toBase58();
      }
    } catch {
      // ignore rpc fetch failure
    }

    res.json({
      configured: signerConfigured,
      arbiterWallet: signerWallet,
      portalArbiterWallet: portalArbiterWallet || null,
      portalWalletConfigured: Boolean(portalArbiterWallet),
      portalPasswordConfigured,
      onChainConfigArbiter,
      onChainConfigMatchesPortal:
        Boolean(portalArbiterWallet) && onChainConfigArbiter === portalArbiterWallet,
    });
  });

  return router;
}

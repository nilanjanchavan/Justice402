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
import { ProviderMetadataEntry } from "./registry-router";

const TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const AUTH_CHALLENGE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_EVIDENCE_ENTRIES = 200;
const MAX_EVIDENCE_BYTES = 128 * 1024; // 128 KiB
const MAX_AUTH_FAILURES = 5;
const AUTH_LOCKOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface CachedReceiptEntry {
  receiptBase64: string;
  signatureBase64: string;
  responseData: any;
  specJson?: string;
}

export interface EvidenceEntry {
  responsePayload: any;
  receiptBase64?: string;
  specJson?: string;
  cachedAt: number;
}

export interface ArbiterRouterOptions {
  rpcUrl?: string;
  arbiterKeypair?: Keypair;
  receiptCache?: Map<string, CachedReceiptEntry>;
  disputeEvidenceCache?: Map<string, EvidenceEntry>;
  providerRegistry?: Map<string, ProviderMetadataEntry>;
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

function verifyEd25519Signature(message: Buffer, signature: Buffer, pubkey: PublicKey): boolean {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        pubkey.toBuffer(),
      ]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, message, key, signature);
  } catch {
    return false;
  }
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
  const disputeEvidenceCache = options.disputeEvidenceCache || new Map<string, EvidenceEntry>();
  const authChallenges = new Map<string, { wallet: string; expiresAt: number }>();
  const failedAuthTracker = new Map<string, { failures: number; lockedUntil: number }>();
  let cachedArbiterKeypair: Keypair | null = options.arbiterKeypair || null;

  const getPortalWallet = () => (process.env.ARBITER_PORTAL_WALLET || "").trim();

  function pruneEvidenceCache() {
    const now = Date.now();
    for (const [k, v] of disputeEvidenceCache.entries()) {
      if (now - v.cachedAt > EVIDENCE_TTL_MS) {
        disputeEvidenceCache.delete(k);
      }
    }
    while (disputeEvidenceCache.size > MAX_EVIDENCE_ENTRIES) {
      const oldest = disputeEvidenceCache.keys().next().value;
      if (!oldest) break;
      disputeEvidenceCache.delete(oldest);
    }
  }

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

  function resolveAuthoritativeSpecText(
    providerWalletStr: string,
    expectedSpecHash: Buffer,
    suppliedSpecJson?: string
  ): { specText: string | null } {
    const regEntry = options.providerRegistry?.get(providerWalletStr);
    if (regEntry?.specJson) {
      const regHash = crypto.createHash("sha256").update(regEntry.specJson).digest();
      if (regHash.equals(expectedSpecHash)) {
        return { specText: regEntry.specJson };
      }
    }

    const defaultWeatherHash = crypto.createHash("sha256").update(SPEC_CANONICAL_JSON).digest();
    if (defaultWeatherHash.equals(expectedSpecHash)) {
      return { specText: SPEC_CANONICAL_JSON };
    }

    if (suppliedSpecJson) {
      try {
        const canonical = JSON.stringify(JSON.parse(suppliedSpecJson));
        const h = crypto.createHash("sha256").update(canonical).digest();
        if (h.equals(expectedSpecHash)) {
          return { specText: canonical };
        }
      } catch {
        // invalid json
      }
    }

    return { specText: null };
  }

  async function fetchDisputeAndConfig(disputePdaStr: string) {
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

    const disputePda = new PublicKey(disputePdaStr);
    const disputeAccount: any = await (program.account as any).dispute.fetch(disputePda);

    const configAccounts: any[] = await (program.account as any).config.all();
    if (configAccounts.length === 0) {
      throw new Error("On-chain Config account not found");
    }
    const configAccount = configAccounts[0].account;

    return { kp, program, disputePda, disputeAccount, configAccount };
  }

  async function buildAuditForDispute(params: {
    disputePdaStr: string;
    responsePayload?: any;
    receiptBase64?: string;
    specJson?: string;
    chainCtx?: Awaited<ReturnType<typeof fetchDisputeAndConfig>>;
  }) {
    const chainCtx = params.chainCtx || (await fetchDisputeAndConfig(params.disputePdaStr));
    const { kp, program, disputePda, disputeAccount, configAccount } = chainCtx;

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

    if (evidenceBytes.byteLength > MAX_EVIDENCE_BYTES) {
      throw new Error(`Evidence payload exceeds ${MAX_EVIDENCE_BYTES} byte limit`);
    }

    const { specText } = resolveAuthoritativeSpecText(
      disputeAccount.provider.toBase58(),
      auditReceipt.specHash,
      params.specJson || cachedByDispute?.specJson || cachedByReceipt?.specJson
    );

    if (!specText) {
      const missingSpecResults: SpecCheckResults = {
        isValid: false,
        specHashMatch: false,
        responseHashMatch: crypto
          .createHash("sha256")
          .update(evidenceBytes)
          .digest()
          .equals(auditReceipt.responseHash),
        schemaValid: false,
        rangesValid: false,
        freshnessValid: false,
        errors: [
          `Authoritative spec matching committed spec_hash ${auditReceipt.specHash.toString("hex")} is not available in registry.`,
        ],
      };
      return {
        kp,
        program,
        disputePda,
        disputeAccount,
        configAccount,
        auditReceipt,
        hasEvidence: true,
        results: missingSpecResults,
        reportText: formatAuditReport(auditReceipt, missingSpecResults),
        effectivePayload,
      };
    }

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

  // GET /arbiter/challenge — issue single-use wallet ownership challenge for arbiter auth
  router.get("/challenge", (req: Request, res: Response) => {
    const portalWallet = getPortalWallet();
    if (!portalWallet) {
      res.status(503).json({
        error: "ARBITER_PORTAL_WALLET is not configured on the backend environment.",
      });
      return;
    }

    const walletAddress = String(req.query.wallet || "").trim();
    if (walletAddress !== portalWallet) {
      res.status(403).json({ error: "Unauthorized wallet for Arbiter Portal" });
      return;
    }

    const now = Date.now();
    for (const [k, v] of authChallenges.entries()) {
      if (v.expiresAt < now) authChallenges.delete(k);
    }

    const nonce = crypto.randomBytes(16).toString("hex");
    const expiresAt = now + AUTH_CHALLENGE_TTL_MS;
    authChallenges.set(nonce, { wallet: portalWallet, expiresAt });

    res.json({
      nonce,
      expiresAt,
      message: `Justice402 Arbiter Portal Login\nWallet: ${portalWallet}\nNonce: ${nonce}`,
    });
  });

  // POST /arbiter/auth — verify portal wallet signature + password with brute-force backoff
  router.post("/auth", async (req: Request, res: Response) => {
    const expectedPassword = process.env.ARBITER_PORTAL_PASSWORD;
    const portalWallet = getPortalWallet();
    if (!expectedPassword || !portalWallet) {
      res.status(503).json({
        error:
          "ARBITER_PORTAL_PASSWORD and ARBITER_PORTAL_WALLET must be configured on the backend environment.",
      });
      return;
    }

    const callerKey = req.ip || portalWallet;
    const tracker = failedAuthTracker.get(callerKey);
    if (tracker && tracker.lockedUntil > Date.now()) {
      const waitSec = Math.ceil((tracker.lockedUntil - Date.now()) / 1000);
      res.status(429).json({
        error: `Too many failed login attempts. Try again in ${waitSec}s.`,
      });
      return;
    }

    const { password, walletAddress, nonce, signatureBase64 } = req.body || {};

    if (!walletAddress || walletAddress !== portalWallet) {
      res.status(403).json({
        error: `Unauthorized wallet. Arbiter Portal is restricted to ${portalWallet}.`,
      });
      return;
    }

    if (typeof password !== "string" || !password || !nonce || !signatureBase64) {
      res.status(400).json({
        error: "Password, nonce, and wallet signatureBase64 are required",
      });
      return;
    }

    const challenge = authChallenges.get(String(nonce));
    if (!challenge || challenge.expiresAt < Date.now() || challenge.wallet !== portalWallet) {
      res.status(401).json({ error: "Invalid or expired arbiter login challenge" });
      return;
    }
    authChallenges.delete(String(nonce));

    const expectedMsg = Buffer.from(
      `Justice402 Arbiter Portal Login\nWallet: ${portalWallet}\nNonce: ${String(nonce)}`
    );
    const sigBuf = Buffer.from(String(signatureBase64), "base64");
    const walletPk = new PublicKey(portalWallet);

    if (!verifyEd25519Signature(expectedMsg, sigBuf, walletPk)) {
      res.status(401).json({ error: "Invalid arbiter wallet signature" });
      return;
    }

    if (!timingSafePasswordMatch(password, expectedPassword)) {
      const prevFailures = tracker?.failures || 0;
      const nextFailures = prevFailures + 1;
      const lockedUntil =
        nextFailures >= MAX_AUTH_FAILURES ? Date.now() + AUTH_LOCKOUT_MS : 0;
      failedAuthTracker.set(callerKey, { failures: nextFailures, lockedUntil });
      await new Promise((r) => setTimeout(r, Math.min(2000, nextFailures * 400)));
      res.status(401).json({ error: "Invalid arbiter portal password" });
      return;
    }

    failedAuthTracker.delete(callerKey);
    const { token, expiresAt } = issuePortalToken(portalWallet, expectedPassword);
    res.json({
      authenticated: true,
      walletAddress: portalWallet,
      token,
      expiresAt,
    });
  });

  // POST /arbiter/evidence — cache only commitment-verified evidence payloads (bounded + TTL)
  router.post("/evidence", async (req: Request, res: Response) => {
    try {
      const { disputePda, responsePayload, receiptBase64, specJson } = req.body || {};
      if (!disputePda || responsePayload === undefined) {
        res.status(400).json({ error: "Missing disputePda or responsePayload" });
        return;
      }

      const ctx = await buildAuditForDispute({
        disputePdaStr: disputePda,
        responsePayload,
        receiptBase64,
        specJson,
      });

      if (!ctx.results || !ctx.results.specHashMatch || !ctx.results.responseHashMatch) {
        res.status(400).json({
          error:
            ctx.results?.errors.join("; ") ||
            "Cannot cache evidence: specHash or responseHash commitment mismatch",
        });
        return;
      }

      pruneEvidenceCache();
      disputeEvidenceCache.set(disputePda, {
        responsePayload,
        receiptBase64,
        specJson,
        cachedAt: Date.now(),
      });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "Failed to verify dispute evidence" });
    }
  });

  // POST /arbiter/audit — run deterministic spec audit preview without submitting transaction
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
            "No cached HTTP payload found for this dispute PDA. Paste the API JSON payload to preview deterministic checks.",
        });
        return;
      }

      const commitmentsMatch = ctx.results.specHashMatch && ctx.results.responseHashMatch;
      const recommendedRuling = commitmentsMatch
        ? ctx.results.isValid
          ? "ProviderWins"
          : "BuyerWins"
        : null;

      res.json({
        hasEvidence: true,
        disputePda,
        recommendedRuling,
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

      const isManualOverride = rulingOverride !== undefined;
      if (isManualOverride) {
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

      const chainCtx = await fetchDisputeAndConfig(disputePdaStr);
      const statusKey = Object.keys(chainCtx.disputeAccount.status)[0];
      if (!chainCtx.disputeAccount.status.open) {
        res.status(400).json({
          error: `Dispute is already resolved (${statusKey})`,
          status: statusKey,
        });
        return;
      }

      if (!chainCtx.kp.publicKey.equals(chainCtx.configAccount.arbiter)) {
        res.status(403).json({
          error: `Configured server wallet (${chainCtx.kp.publicKey.toBase58()}) does not match on-chain Config arbiter (${chainCtx.configAccount.arbiter.toBase58()}).`,
        });
        return;
      }

      let auditCtx: Awaited<ReturnType<typeof buildAuditForDispute>> | null = null;
      let auditError: string | null = null;

      try {
        auditCtx = await buildAuditForDispute({
          disputePdaStr,
          responsePayload,
          receiptBase64,
          specJson,
          chainCtx,
        });
      } catch (err: any) {
        if (!isManualOverride) {
          res.status(400).json({ error: err?.message || "Audit verification failed" });
          return;
        }
        auditError = err?.message || "Optional audit skipped";
      }

      let ruling: "BuyerWins" | "ProviderWins";
      let recommendationSummary = "Unavailable";

      if (isManualOverride) {
        ruling = rulingOverride;
        if (auditCtx?.hasEvidence && auditCtx.results) {
          const commitsOk =
            auditCtx.results.specHashMatch && auditCtx.results.responseHashMatch;
          recommendationSummary = commitsOk
            ? auditCtx.results.isValid
              ? "ProviderWins"
              : "BuyerWins"
            : "None (Commitment Mismatch)";
        } else if (auditError) {
          recommendationSummary = `Audit unavailable (${auditError})`;
        }
      } else {
        if (!auditCtx || !auditCtx.hasEvidence || !auditCtx.results) {
          res.status(400).json({
            error:
              "Missing responsePayload for audit (and receipt is not in server memory). Submit the API JSON payload returned with this receipt.",
          });
          return;
        }
        if (!auditCtx.results.specHashMatch || !auditCtx.results.responseHashMatch) {
          res.status(400).json({
            error: auditCtx.results.errors.join("; ") || "Cryptographic commitment check failed",
            auditReport: auditCtx.results,
          });
          return;
        }
        ruling = auditCtx.results.isValid ? "ProviderWins" : "BuyerWins";
        recommendationSummary = ruling;
      }

      const structuredDecisionRecord = [
        `DisputePDA: ${disputePdaStr}`,
        `SelectedRuling: ${ruling}`,
        `AuditRecommendation: ${recommendationSummary}`,
        auditCtx?.reportText || "",
      ]
        .filter(Boolean)
        .join("\n");

      const rulingHash = crypto.createHash("sha256").update(structuredDecisionRecord).digest();
      const buyerTokenAccount = getAssociatedTokenAddressSync(
        chainCtx.configAccount.usdcMint,
        chainCtx.disputeAccount.buyer
      );

      const txSig = await resolveDisputeRuling({
        program: chainCtx.program,
        arbiterKeypair: chainCtx.kp,
        disputePda: chainCtx.disputePda,
        providerWallet: chainCtx.disputeAccount.provider,
        buyerWallet: chainCtx.disputeAccount.buyer,
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
        reportText: structuredDecisionRecord,
        auditReport: auditCtx?.results || undefined,
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

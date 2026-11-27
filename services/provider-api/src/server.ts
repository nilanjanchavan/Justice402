import express, { Request, Response } from "express";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import crypto from "crypto";
import BN from "bn.js";
import bs58 from "bs58";
import {
  encodeReceipt,
  hashReceipt,
  ReceiptData,
  RECEIPT_VERSION,
} from "@justice402/anchor-client";
import { SPEC_HASH, SPEC_CANONICAL_JSON } from "./spec";
import { createArbiterRouter, CachedReceiptEntry } from "./arbiter-router";

export function signWithKeypair(message: Buffer, keypair: Keypair): Buffer {
  const privKey = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(keypair.secretKey.slice(0, 32)),
    ]),
    format: "der",
    type: "pkcs8",
  });
  return crypto.sign(null, message, privKey);
}

export interface ProviderAppOptions {
  providerKeypair: Keypair;
  lyingProviderKeypair?: Keypair;
  subtleProviderKeypair?: Keypair;
  specHash?: Buffer;
  priceLamports?: number | BN;
  allowedOrigin?: string;
  maxRequestsPerMinute?: number;
  nowFn?: () => number;
  requirePayment?: boolean;
  rpcUrl?: string;
  arbiterKeypair?: Keypair;
}

export function createProviderApp(options: ProviderAppOptions): express.Application {
  const app = express();
  app.use(express.json());

  const {
    providerKeypair,
    lyingProviderKeypair = providerKeypair,
    subtleProviderKeypair = providerKeypair,
    specHash = SPEC_HASH,
    priceLamports = 5_000_000,
    allowedOrigin = process.env.DASHBOARD_ORIGIN || process.env.ALLOWED_ORIGINS || "*",
    maxRequestsPerMinute = 120,
    requirePayment = false,
    rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  } = options;

  const currentUnixTime = () =>
    options.nowFn ? options.nowFn() : Math.floor(Date.now() / 1000);

  let nonceCounter = Math.floor(Date.now() / 1000);
  const usedSignatures = new Set<string>();
  const receiptCache = new Map<string, CachedReceiptEntry>();
  const rpcConnection = requirePayment ? new Connection(rpcUrl, "confirmed") : null;

  // 1. CORS Configuration
  app.use((req: Request, res: Response, next) => {
    const origin = req.headers.origin;
    if (allowedOrigin === "*" || (origin && origin === allowedOrigin)) {
      res.setHeader("Access-Control-Allow-Origin", origin || allowedOrigin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Buyer-Wallet, X-Justice402-Receipt, X-Justice402-Signature, PAYMENT-SIGNATURE"
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "X-Justice402-Receipt, X-Justice402-Signature, PAYMENT-RESPONSE, PAYMENT-REQUIRED"
    );

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // 2. In-Memory Sliding Window Rate Limiter
  const requestCounts = new Map<string, { count: number; resetAt: number }>();
  app.use((req: Request, res: Response, next) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const windowRecord = requestCounts.get(ip);

    if (!windowRecord || now > windowRecord.resetAt) {
      requestCounts.set(ip, { count: 1, resetAt: now + 60_000 });
      next();
    } else if (windowRecord.count < maxRequestsPerMinute) {
      windowRecord.count++;
      next();
    } else {
      res.status(429).json({
        error: "Too Many Requests",
        message: `Rate limit of ${maxRequestsPerMinute} requests per minute exceeded.`,
      });
    }
  });

  // 3. Safe Request Logging
  app.use((req: Request, res: Response, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      const clientIp = req.ip || "unknown";
      console.log(`[HTTP] ${req.method} ${req.path} ${res.statusCode} (${duration}ms) - IP: ${clientIp}`);
    });
    next();
  });

  // 4. Health Check Endpoint: /health
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      service: "justice402-provider-api",
      uptime: process.uptime(),
      provider: providerKeypair.publicKey.toBase58(),
      providers: {
        honest: providerKeypair.publicKey.toBase58(),
        lying: lyingProviderKeypair.publicKey.toBase58(),
        subtle: subtleProviderKeypair.publicKey.toBase58(),
      },
      specHash: specHash.toString("hex"),
      priceLamports: Number(priceLamports.toString()),
      requirePayment,
      network: "devnet",
      timestamp: currentUnixTime(),
    });
  });

  // Off-chain service spec endpoint: /spec
  app.get("/spec", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/json");
    res.send(SPEC_CANONICAL_JSON);
  });

  // Reference ground-truth endpoint: /reference/weather
  app.get("/reference/weather", (req: Request, res: Response) => {
    const city = (req.query.city as string) || "SolanaBeach";
    res.json({
      city,
      temperature: 24.5,
      humidity: 55,
      observedAt: currentUnixTime(),
    });
  });

  // Verify x402 payment header or emit 402 Payment Required
  async function verifyOrChallengeX402(
    req: Request,
    res: Response,
    payToKeypair: Keypair
  ): Promise<{ ok: boolean; paymentRef: Buffer; paymentTxSig?: string }> {
    const enforce =
      requirePayment ||
      req.query.x402 === "1" ||
      req.headers["x-justice402-require-payment"] === "1";

    if (!enforce) {
      return { ok: true, paymentRef: Buffer.alloc(64, 0) };
    }

    const paymentHeader = req.headers["payment-signature"] as string | undefined;
    const priceStr = priceLamports.toString();

    if (!paymentHeader) {
      const paymentRequired = {
        x402Version: 2,
        error: "Payment Required",
        accepts: [
          {
            scheme: "exact",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            asset: "SOL",
            amount: priceStr,
            payTo: payToKeypair.publicKey.toBase58(),
            maxTimeoutSeconds: 60,
          },
        ],
      };
      res.setHeader(
        "PAYMENT-REQUIRED",
        Buffer.from(JSON.stringify(paymentRequired)).toString("base64")
      );
      res.status(402).json(paymentRequired);
      return { ok: false, paymentRef: Buffer.alloc(64, 0) };
    }

    let txSignature = "";
    try {
      const trimmed = paymentHeader.trim();
      if (/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(trimmed)) {
        txSignature = trimmed;
      } else {
        const parsed = JSON.parse(Buffer.from(trimmed, "base64").toString("utf8"));
        txSignature = parsed.txSignature || parsed.signature || parsed.transaction || "";
      }
    } catch {
      res.status(402).json({ error: "Invalid PAYMENT-SIGNATURE header format" });
      return { ok: false, paymentRef: Buffer.alloc(64, 0) };
    }

    if (!txSignature) {
      res.status(402).json({ error: "Missing txSignature in PAYMENT-SIGNATURE" });
      return { ok: false, paymentRef: Buffer.alloc(64, 0) };
    }

    if (usedSignatures.has(txSignature)) {
      res.status(402).json({ error: "Payment signature already redeemed" });
      return { ok: false, paymentRef: Buffer.alloc(64, 0) };
    }

    let sigBytes: Uint8Array;
    try {
      sigBytes = bs58.decode(txSignature);
      if (sigBytes.length !== 64) {
        throw new Error("Invalid signature length");
      }
    } catch {
      res.status(402).json({ error: "Invalid base58 Solana transaction signature" });
      return { ok: false, paymentRef: Buffer.alloc(64, 0) };
    }

    const conn = rpcConnection || new Connection(rpcUrl, "confirmed");
    let txInfo: any = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      txInfo = await conn.getTransaction(txSignature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (txInfo) break;
      await new Promise((r) => setTimeout(r, 800));
    }

    if (!txInfo || txInfo.meta?.err) {
      res.status(402).json({
        error: "Payment transaction not confirmed or failed on Solana",
        txSignature,
      });
      return { ok: false, paymentRef: Buffer.alloc(64, 0) };
    }

    // Verify recipient received at least priceLamports
    const accountKeys = txInfo.transaction.message.getAccountKeys
      ? txInfo.transaction.message.getAccountKeys().staticAccountKeys
      : txInfo.transaction.message.accountKeys;
    const payToIdx = accountKeys.findIndex((k: PublicKey) =>
      k.equals(payToKeypair.publicKey)
    );
    const minRequired = BigInt(priceStr);
    const received =
      payToIdx >= 0
        ? BigInt(txInfo.meta.postBalances[payToIdx] - txInfo.meta.preBalances[payToIdx])
        : 0n;

    if (received < minRequired) {
      res.status(402).json({
        error: `Insufficient SOL payment to ${payToKeypair.publicKey.toBase58()}: expected ${minRequired}, received ${received}`,
        txSignature,
      });
      return { ok: false, paymentRef: Buffer.alloc(64, 0) };
    }

    usedSignatures.add(txSignature);
    if (usedSignatures.size > 5000) {
      const oldest = usedSignatures.values().next().value;
      if (oldest) usedSignatures.delete(oldest);
    }

    return { ok: true, paymentRef: Buffer.from(sigBytes), paymentTxSig: txSignature };
  }

  function buildAndSignReceipt(params: {
    signerKeypair: Keypair;
    buyerPubkey: PublicKey;
    requestPath: string;
    responseData: any;
    paymentRef: Buffer;
  }): { receiptData: ReceiptData; canonicalBytes: Buffer; signature: Buffer; receiptHashHex: string } {
    const rawResponse = Buffer.from(JSON.stringify(params.responseData));
    const responseHash = crypto.createHash("sha256").update(rawResponse).digest();
    const requestHash = crypto.createHash("sha256").update(params.requestPath).digest();

    const receiptData: ReceiptData = {
      version: RECEIPT_VERSION,
      provider: params.signerKeypair.publicKey,
      buyer: params.buyerPubkey,
      specHash: specHash,
      requestHash,
      responseHash,
      paymentReference: params.paymentRef,
      price: new BN(priceLamports.toString()),
      timestamp: currentUnixTime(),
      nonce: ++nonceCounter,
    };

    const canonicalBytes = encodeReceipt(receiptData);
    const signature = signWithKeypair(canonicalBytes, params.signerKeypair);
    const receiptHashHex = hashReceipt(canonicalBytes).toString("hex");

    receiptCache.set(receiptHashHex, {
      receiptBase64: canonicalBytes.toString("base64"),
      signatureBase64: signature.toString("base64"),
      responseData: params.responseData,
    });
    if (receiptCache.size > 500) {
      const oldest = receiptCache.keys().next().value;
      if (oldest) receiptCache.delete(oldest);
    }

    return { receiptData, canonicalBytes, signature, receiptHashHex };
  }

  async function handleWeatherRoute(
    req: Request,
    res: Response,
    signerKeypair: Keypair,
    responseData: any
  ) {
    const buyerStr = (req.query.buyer as string) || (req.headers["x-buyer-wallet"] as string);
    let buyerPubkey: PublicKey;
    try {
      buyerPubkey = buyerStr ? new PublicKey(buyerStr) : PublicKey.default;
    } catch {
      res.status(400).json({ error: "Invalid buyer wallet public key" });
      return;
    }

    const payment = await verifyOrChallengeX402(req, res, signerKeypair);
    if (!payment.ok) return;

    const { canonicalBytes, signature, receiptHashHex } = buildAndSignReceipt({
      signerKeypair,
      buyerPubkey,
      requestPath: req.originalUrl || req.path,
      responseData,
      paymentRef: payment.paymentRef,
    });

    const receiptB64 = canonicalBytes.toString("base64");
    const sigB64 = signature.toString("base64");

    res.setHeader("X-Justice402-Receipt", receiptB64);
    res.setHeader("X-Justice402-Signature", sigB64);
    if (payment.paymentTxSig) {
      const paymentResp = Buffer.from(
        JSON.stringify({
          success: true,
          txSignature: payment.paymentTxSig,
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          payTo: signerKeypair.publicKey.toBase58(),
          amount: priceLamports.toString(),
        })
      ).toString("base64");
      res.setHeader("PAYMENT-RESPONSE", paymentResp);
    }

    res.json({
      data: responseData,
      receipt: {
        bytesBase64: receiptB64,
        signatureBase64: sigB64,
        receiptHashHex,
      },
      payment: payment.paymentTxSig
        ? {
            txSignature: payment.paymentTxSig,
            payTo: signerKeypair.publicKey.toBase58(),
            amountLamports: Number(priceLamports.toString()),
          }
        : undefined,
    });
  }

  // Honest endpoint: /weather
  app.get("/weather", async (req: Request, res: Response) => {
    await handleWeatherRoute(req, res, providerKeypair, {
      city: "SolanaBeach",
      temperature: 24.5,
      humidity: 55,
      observedAt: currentUnixTime(),
    });
  });

  // Lying endpoint (Gross liar): /weather-lying
  app.get("/weather-lying", async (req: Request, res: Response) => {
    await handleWeatherRoute(req, res, lyingProviderKeypair, {
      city: "SolanaBeach",
      temperature: 9999,
      humidity: -50,
      observedAt: currentUnixTime() - 1000,
    });
  });

  // Subtle liar endpoint (Plausible but wrong): /weather-plausible-wrong
  app.get("/weather-plausible-wrong", async (req: Request, res: Response) => {
    await handleWeatherRoute(req, res, subtleProviderKeypair, {
      city: "SolanaBeach",
      temperature: 38.0,
      humidity: 80,
      observedAt: currentUnixTime(),
    });
  });

  // Arbiter auto-resolve endpoint
  app.use(
    "/arbiter",
    createArbiterRouter({
      rpcUrl,
      arbiterKeypair: options.arbiterKeypair,
      receiptCache,
    })
  );

  return app;
}

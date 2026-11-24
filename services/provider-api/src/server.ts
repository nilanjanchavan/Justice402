import express, { Request, Response } from "express";
import { Keypair, PublicKey } from "@solana/web3.js";
import crypto from "crypto";
import BN from "bn.js";
import {
  encodeReceipt,
  ReceiptData,
  RECEIPT_VERSION,
} from "@justice402/anchor-client";
import { WEATHER_SERVICE_SPEC, SPEC_HASH, SPEC_CANONICAL_JSON } from "./spec";

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
  specHash?: Buffer;
  priceLamports?: number | BN;
}

export function createProviderApp(options: ProviderAppOptions): express.Application {
  const app = express();
  app.use(express.json());

  const {
    providerKeypair,
    specHash = SPEC_HASH,
    priceLamports = 5_000_000, // 5 USDC
  } = options;

  let nonceCounter = 1000;

  // 1. Off-chain service spec endpoint: /spec
  app.get("/spec", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/json");
    res.send(SPEC_CANONICAL_JSON);
  });

  // 2. Mock reference endpoint: /reference/weather (provides objective ground truth)
  app.get("/reference/weather", (req: Request, res: Response) => {
    const city = (req.query.city as string) || "SolanaBeach";
    res.json({
      city,
      temperature: 24.5,
      humidity: 55,
      observedAt: Math.floor(Date.now() / 1000),
    });
  });

  // Helper to build and sign receipt
  function buildAndSignReceipt(params: {
    buyerPubkey: PublicKey;
    requestPath: string;
    responseData: any;
  }): { receiptData: ReceiptData; canonicalBytes: Buffer; signature: Buffer } {
    const rawResponse = Buffer.from(JSON.stringify(params.responseData));
    const responseHash = crypto.createHash("sha256").update(rawResponse).digest();
    const requestHash = crypto.createHash("sha256").update(params.requestPath).digest();

    const receiptData: ReceiptData = {
      version: RECEIPT_VERSION,
      provider: providerKeypair.publicKey,
      buyer: params.buyerPubkey,
      specHash: specHash,
      requestHash,
      responseHash,
      paymentReference: Buffer.alloc(64, 0),
      price: new BN(priceLamports.toString()),
      timestamp: Math.floor(Date.now() / 1000),
      nonce: ++nonceCounter,
    };

    const canonicalBytes = encodeReceipt(receiptData);
    const signature = signWithKeypair(canonicalBytes, providerKeypair);

    return { receiptData, canonicalBytes, signature };
  }

  // 3. Honest endpoint: /weather
  app.get("/weather", (req: Request, res: Response) => {
    const buyerStr = (req.query.buyer as string) || (req.headers["x-buyer-wallet"] as string);
    const buyerPubkey = buyerStr ? new PublicKey(buyerStr) : PublicKey.default;

    const honestData = {
      city: "SolanaBeach",
      temperature: 24.5,
      humidity: 55,
      observedAt: Math.floor(Date.now() / 1000),
    };

    const { canonicalBytes, signature } = buildAndSignReceipt({
      buyerPubkey,
      requestPath: req.originalUrl || "/weather",
      responseData: honestData,
    });

    res.setHeader("X-Justice402-Receipt", canonicalBytes.toString("base64"));
    res.setHeader("X-Justice402-Signature", signature.toString("base64"));
    res.json({
      data: honestData,
      receipt: {
        bytesBase64: canonicalBytes.toString("base64"),
        signatureBase64: signature.toString("base64"),
      },
    });
  });

  // 4. Lying endpoint (Gross liar): /weather-lying
  app.get("/weather-lying", (req: Request, res: Response) => {
    const buyerStr = (req.query.buyer as string) || (req.headers["x-buyer-wallet"] as string);
    const buyerPubkey = buyerStr ? new PublicKey(buyerStr) : PublicKey.default;

    // Gross lying response: out-of-range temperature (9999), invalid humidity (-50), stale
    const lyingData = {
      city: "SolanaBeach",
      temperature: 9999, // Out of bounds!
      humidity: -50,     // Out of bounds!
      observedAt: Math.floor(Date.now() / 1000) - 1000, // Stale!
    };

    const { canonicalBytes, signature } = buildAndSignReceipt({
      buyerPubkey,
      requestPath: req.originalUrl || "/weather-lying",
      responseData: lyingData,
    });

    res.setHeader("X-Justice402-Receipt", canonicalBytes.toString("base64"));
    res.setHeader("X-Justice402-Signature", signature.toString("base64"));
    res.json({
      data: lyingData,
      receipt: {
        bytesBase64: canonicalBytes.toString("base64"),
        signatureBase64: signature.toString("base64"),
      },
    });
  });

  // 5. Subtle liar endpoint (Plausible but wrong): /weather-plausible-wrong
  app.get("/weather-plausible-wrong", (req: Request, res: Response) => {
    const buyerStr = (req.query.buyer as string) || (req.headers["x-buyer-wallet"] as string);
    const buyerPubkey = buyerStr ? new PublicKey(buyerStr) : PublicKey.default;

    // Plausible but wrong: valid schema, valid ranges, fresh, but contradicts ground truth (24.5C vs 38.0C)
    const subtleLyingData = {
      city: "SolanaBeach",
      temperature: 38.0,
      humidity: 80,
      observedAt: Math.floor(Date.now() / 1000),
    };

    const { canonicalBytes, signature } = buildAndSignReceipt({
      buyerPubkey,
      requestPath: req.originalUrl || "/weather-plausible-wrong",
      responseData: subtleLyingData,
    });

    res.setHeader("X-Justice402-Receipt", canonicalBytes.toString("base64"));
    res.setHeader("X-Justice402-Signature", signature.toString("base64"));
    res.json({
      data: subtleLyingData,
      receipt: {
        bytesBase64: canonicalBytes.toString("base64"),
        signatureBase64: signature.toString("base64"),
      },
    });
  });

  return app;
}

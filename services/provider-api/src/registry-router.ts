import { Router, Request, Response } from "express";
import { Connection, PublicKey } from "@solana/web3.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import BN from "bn.js";
import { encodeReceipt, ReceiptData, RECEIPT_VERSION } from "@justice402/anchor-client";
import { SPEC_CANONICAL_JSON, SPEC_HASH } from "./spec";
import { verifyOrChallengeX402 } from "./x402";

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "D8uK7oT6f1pcZzK2Dq1NhL7wdNp51sS5ZhuNy4wf8WYD"
);

export interface ProviderMetadataEntry {
  wallet: string;
  name: string;
  endpointUrl: string;
  specJson: string;
  specHash: string;
  hostedProxy: boolean;
  priceLamports: number;
  description: string;
  badge: "honest" | "lying" | "subtle" | "community";
  createdAt: string;
}

export interface RegistryRouterOptions {
  rpcUrl: string;
  priceLamports: number;
  requirePayment: boolean;
  usedSignatures: Set<string>;
  currentUnixTime: () => number;
  seededWallets: {
    honest: string;
    lying: string;
    subtle: string;
  };
}

const CACHE_FILE = path.resolve(process.cwd(), "services/provider-api/.registry-cache.json");

function loadPersistedEntries(): ProviderMetadataEntry[] {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // ignore corrupt cache
  }
  return [];
}

function savePersistedEntries(entries: ProviderMetadataEntry[]) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(entries, null, 2));
  } catch {
    // ignore read-only fs environments
  }
}

export function createRegistryRouter(options: RegistryRouterOptions): Router {
  const router = Router();
  const { rpcUrl, priceLamports, requirePayment, usedSignatures, currentUnixTime, seededWallets } =
    options;

  const registry = new Map<string, ProviderMetadataEntry>();
  const seededSpecHash = SPEC_HASH.toString("hex");

  const defaultSeeds: ProviderMetadataEntry[] = [
    {
      wallet: seededWallets.honest,
      name: "Honest Weather Provider",
      endpointUrl: "/weather",
      specJson: SPEC_CANONICAL_JSON,
      specHash: seededSpecHash,
      hostedProxy: true,
      priceLamports,
      description:
        "Returns accurate, spec-compliant weather data (24.5°C, 55%). All verification checks pass.",
      badge: "honest",
      createdAt: "2026-11-25T00:00:00.000Z",
    },
    {
      wallet: seededWallets.lying,
      name: "Lying Weather Provider",
      endpointUrl: "/weather-lying",
      specJson: SPEC_CANONICAL_JSON,
      specHash: seededSpecHash,
      hostedProxy: true,
      priceLamports,
      description:
        "Returns out-of-range & stale data: temperature=9999°C, humidity=-50%, stale observedAt. Fails audit -> BuyerWins.",
      badge: "lying",
      createdAt: "2026-11-25T00:00:00.000Z",
    },
    {
      wallet: seededWallets.subtle,
      name: "Plausible-Wrong Provider",
      endpointUrl: "/weather-plausible-wrong",
      specJson: SPEC_CANONICAL_JSON,
      specHash: seededSpecHash,
      hostedProxy: true,
      priceLamports,
      description:
        "Returns plausible values (38.0°C vs ground truth 24.5°C). Passes deterministic schema/range checks.",
      badge: "subtle",
      createdAt: "2026-11-25T00:00:00.000Z",
    },
  ];

  for (const s of defaultSeeds) registry.set(s.wallet, s);
  for (const p of loadPersistedEntries()) {
    if (!registry.has(p.wallet)) {
      registry.set(p.wallet, p);
    }
  }

  const connection = new Connection(rpcUrl, "confirmed");

  // GET /providers/registry — public catalog of registered provider metadata
  router.get("/registry", (_req: Request, res: Response) => {
    res.json({
      providers: Array.from(registry.values()),
    });
  });

  // POST /providers/registry — register/update public metadata after on-chain register_provider
  router.post("/registry", async (req: Request, res: Response) => {
    try {
      const {
        wallet: walletStr,
        name,
        endpointUrl,
        specJson,
        hostedProxy = false,
        description,
        priceLamports: customPrice,
      } = req.body || {};

      if (!walletStr || !name || !specJson) {
        res.status(400).json({ error: "Missing required fields: wallet, name, specJson" });
        return;
      }

      let providerWallet: PublicKey;
      try {
        providerWallet = new PublicKey(walletStr);
      } catch {
        res.status(400).json({ error: "Invalid provider wallet public key" });
        return;
      }

      // Validate spec JSON & canonicalize
      let canonicalSpec: string;
      try {
        const parsed = typeof specJson === "string" ? JSON.parse(specJson) : specJson;
        canonicalSpec = JSON.stringify(parsed);
      } catch {
        res.status(400).json({ error: "specJson must be valid JSON" });
        return;
      }

      const computedSpecHash = crypto.createHash("sha256").update(canonicalSpec).digest();
      const computedSpecHashHex = computedSpecHash.toString("hex");

      // Verify on-chain Provider PDA exists and matches spec_hash
      const [providerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("provider"), providerWallet.toBuffer()],
        PROGRAM_ID
      );
      const accountInfo = await connection.getAccountInfo(providerPda);
      if (!accountInfo || accountInfo.data.length < 137) {
        res.status(400).json({
          error: `Provider PDA (${providerPda.toBase58()}) not found on Solana Devnet. Submit register_provider first.`,
        });
        return;
      }

      const onChainSpecHash = Buffer.from(accountInfo.data.subarray(64, 96)).toString("hex");
      if (onChainSpecHash !== computedSpecHashHex) {
        res.status(400).json({
          error: `Spec hash mismatch: on-chain provider committed ${onChainSpecHash}, submitted spec hashes to ${computedSpecHashHex}`,
        });
        return;
      }

      const resolvedEndpoint = hostedProxy
        ? `/providers/hosted/${providerWallet.toBase58()}`
        : String(endpointUrl || "").trim();

      if (!hostedProxy && !/^https?:\/\//i.test(resolvedEndpoint)) {
        res.status(400).json({
          error: "endpointUrl must start with http:// or https:// unless hostedProxy is enabled",
        });
        return;
      }

      const entry: ProviderMetadataEntry = {
        wallet: providerWallet.toBase58(),
        name: String(name).trim().slice(0, 80),
        endpointUrl: resolvedEndpoint,
        specJson: canonicalSpec,
        specHash: computedSpecHashHex,
        hostedProxy: Boolean(hostedProxy),
        priceLamports: Number(customPrice) > 0 ? Number(customPrice) : priceLamports,
        description:
          String(description || "").trim().slice(0, 240) ||
          (hostedProxy
            ? "Community provider using Justice402 Hosted Test Route."
            : "Community x402 API provider registered on Solana Devnet."),
        badge: "community",
        createdAt: new Date().toISOString(),
      };

      registry.set(entry.wallet, entry);
      savePersistedEntries(
        Array.from(registry.values()).filter((e) => e.badge === "community")
      );

      res.json({ ok: true, provider: entry });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to save provider metadata" });
    }
  });

  // GET /providers/hosted/:wallet — Hosted x402 test route for community providers without a backend
  router.get("/hosted/:wallet", async (req: Request, res: Response) => {
    try {
      const providerWallet = new PublicKey(req.params.wallet);
      const buyerStr = (req.query.buyer as string) || (req.headers["x-buyer-wallet"] as string);
      const buyerPubkey = buyerStr ? new PublicKey(buyerStr) : PublicKey.default;
      const simulateLie = req.query.simulate === "lie";

      const meta = registry.get(providerWallet.toBase58());
      const effectivePrice = meta?.priceLamports || priceLamports;
      const specText = meta?.specJson || SPEC_CANONICAL_JSON;
      const specHashBuf = crypto.createHash("sha256").update(specText).digest();

      const payment = await verifyOrChallengeX402({
        req,
        res,
        payTo: providerWallet,
        priceLamports: String(effectivePrice),
        requirePayment,
        rpcUrl,
        connection,
        usedSignatures,
      });
      if (!payment.ok) return;

      const ts = currentUnixTime();
      const responseData = simulateLie
        ? {
            city: "SolanaBeach",
            temperature: 9999,
            humidity: -50,
            observedAt: ts - 1000,
          }
        : {
            city: "SolanaBeach",
            temperature: 24.5,
            humidity: 55,
            observedAt: ts,
          };

      const rawResponse = Buffer.from(JSON.stringify(responseData));
      const responseHash = crypto.createHash("sha256").update(rawResponse).digest();
      const requestHash = crypto.createHash("sha256").update(req.originalUrl || req.path).digest();

      const receiptData: ReceiptData = {
        version: RECEIPT_VERSION,
        provider: providerWallet,
        buyer: buyerPubkey,
        specHash: specHashBuf,
        requestHash,
        responseHash,
        paymentReference: payment.paymentRef,
        price: new BN(effectivePrice),
        timestamp: ts,
        nonce: ts,
      };
      const canonicalBytes = encodeReceipt(receiptData);

      res.json({
        data: responseData,
        specJson: specText,
        receipt: {
          bytesBase64: canonicalBytes.toString("base64"),
          needsProviderSignature: true,
        },
        payment: payment.paymentTxSig
          ? {
              txSignature: payment.paymentTxSig,
              payTo: providerWallet.toBase58(),
              amountLamports: effectivePrice,
            }
          : undefined,
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "Invalid hosted provider call" });
    }
  });

  // POST /providers/proxy — CORS-safe relay for external custom x402 API URLs
  router.post("/proxy", async (req: Request, res: Response) => {
    try {
      const { targetUrl, paymentSignature } = req.body || {};
      if (!targetUrl || typeof targetUrl !== "string" || !/^https?:\/\//i.test(targetUrl)) {
        res.status(400).json({ error: "Invalid targetUrl" });
        return;
      }

      // Prevent SSRF to localhost / private RFC1918 ranges in hosted environment
      const parsed = new URL(targetUrl);
      const host = parsed.hostname.toLowerCase();
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host.startsWith("10.") ||
        host.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        host === "169.254.169.254"
      ) {
        res.status(403).json({ error: "Private network proxy targets are blocked" });
        return;
      }

      const headers: Record<string, string> = {};
      if (paymentSignature) headers["PAYMENT-SIGNATURE"] = String(paymentSignature);

      const upstream = await fetch(targetUrl, { headers });
      const text = await upstream.text();
      let body: any = text;
      try {
        body = JSON.parse(text);
      } catch {
        // plain text
      }

      res.status(upstream.status).json({
        status: upstream.status,
        headers: {
          "payment-required": upstream.headers.get("payment-required"),
          "payment-response": upstream.headers.get("payment-response"),
          "x-justice402-receipt": upstream.headers.get("x-justice402-receipt"),
          "x-justice402-signature": upstream.headers.get("x-justice402-signature"),
        },
        body,
      });
    } catch (err: any) {
      res.status(502).json({ error: err?.message || "Upstream proxy error" });
    }
  });

  return router;
}


import { Router, Request, Response } from "express";
import { Connection, PublicKey } from "@solana/web3.js";
import crypto from "crypto";
import dns from "dns/promises";
import net from "net";
import fs from "fs";
import path from "path";
import BN from "bn.js";
import { encodeReceipt, ReceiptData, RECEIPT_VERSION } from "@justice402/anchor-client";
import { SPEC_CANONICAL_JSON, SPEC_HASH } from "./spec";
import { verifyOrChallengeX402 } from "./x402";

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "D8uK7oT6f1pcZzK2Dq1NhL7wdNp51sS5ZhuNy4wf8WYD"
);

const U64_MAX = 18446744073709551615n;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const PROXY_TIMEOUT_MS = 10_000;
const PROXY_MAX_BYTES = 1024 * 1024; // 1 MiB

export interface ProviderMetadataEntry {
  wallet: string;
  name: string;
  endpointUrl: string;
  specJson: string;
  specHash: string;
  hostedProxy: boolean;
  priceLamports: string;
  description: string;
  badge: "honest" | "lying" | "subtle" | "community";
  createdAt: string;
}

export interface RegistryRouterOptions {
  rpcUrl: string;
  priceLamports: string;
  requirePayment: boolean;
  usedSignatures: Map<string, number>;
  currentUnixTime: () => number;
  registry?: Map<string, ProviderMetadataEntry>;
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

function persistEntriesStrict(entries: ProviderMetadataEntry[]): void {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(entries, null, 2));
}

function verifyEd25519WalletSignature(
  message: Buffer,
  signature: Buffer,
  wallet: PublicKey
): boolean {
  try {
    const pubKey = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        wallet.toBuffer(),
      ]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, message, pubKey, signature);
  } catch {
    return false;
  }
}

function isPrivateOrReservedIp(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPrivateOrReservedIp(normalized.slice(7));
  }
  if (net.isIPv4(normalized)) {
    const parts = normalized.split(".").map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // Multicast / reserved
    return false;
  }
  if (net.isIPv6(normalized)) {
    if (normalized === "::1" || normalized === "::") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // ULA
    if (normalized.startsWith("fe80:")) return true; // link-local
    if (normalized.startsWith("ff")) return true; // multicast
    return false;
  }
  return true;
}

async function assertPublicDestination(targetUrl: string): Promise<void> {
  const parsed = new URL(targetUrl);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("Private network proxy targets are blocked");
  }
  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new Error("Private IP proxy targets are blocked");
    }
    return;
  }
  const resolved = await dns.lookup(host, { all: true });
  if (resolved.length === 0) {
    throw new Error("Unable to resolve target hostname");
  }
  for (const addr of resolved) {
    if (isPrivateOrReservedIp(addr.address)) {
      throw new Error("Resolved proxy target points to a private/reserved IP address");
    }
  }
}

async function readResponseWithLimit(response: globalThis.Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Upstream response exceeded ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

export function createRegistryRouter(options: RegistryRouterOptions): Router {
  const router = Router();
  const { rpcUrl, priceLamports, requirePayment, usedSignatures, currentUnixTime, seededWallets } =
    options;

  const registry = options.registry || new Map<string, ProviderMetadataEntry>();
  const seededSet = new Set([seededWallets.honest, seededWallets.lying, seededWallets.subtle]);
  const seededSpecHash = SPEC_HASH.toString("hex");
  const challengeNonces = new Map<string, { wallet: string; nonce: string; expiresAt: number }>();

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

  // Seeded wallets are immutable; only restore non-seeded persisted community providers
  for (const s of defaultSeeds) registry.set(s.wallet, s);
  for (const p of loadPersistedEntries()) {
    if (!seededSet.has(p.wallet)) {
      registry.set(p.wallet, { ...p, priceLamports: String(p.priceLamports || priceLamports) });
    }
  }

  const connection = new Connection(rpcUrl, "confirmed");

  // GET /providers/registry — public catalog of registered provider metadata
  router.get("/registry", (_req: Request, res: Response) => {
    res.json({
      providers: Array.from(registry.values()),
    });
  });

  // GET /providers/registry/challenge?wallet=<pubkey> — single-use ownership challenge
  router.get("/registry/challenge", (req: Request, res: Response) => {
    const walletStr = String(req.query.wallet || "").trim();
    try {
      new PublicKey(walletStr);
    } catch {
      res.status(400).json({ error: "Valid wallet query param required" });
      return;
    }

    const now = Date.now();
    for (const [k, v] of challengeNonces.entries()) {
      if (v.expiresAt < now) challengeNonces.delete(k);
    }

    const nonce = crypto.randomBytes(16).toString("hex");
    const expiresAt = now + CHALLENGE_TTL_MS;
    challengeNonces.set(nonce, { wallet: walletStr, nonce, expiresAt });

    res.json({
      nonce,
      expiresAt,
    });
  });

  // POST /providers/registry — verify wallet signature + on-chain PDA + specHash before saving metadata
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
        nonce,
        signatureBase64,
      } = req.body || {};

      if (!walletStr || !name || !specJson || !nonce || !signatureBase64) {
        res.status(400).json({
          error: "Missing required fields: wallet, name, specJson, nonce, signatureBase64",
        });
        return;
      }

      let providerWallet: PublicKey;
      try {
        providerWallet = new PublicKey(walletStr);
      } catch {
        res.status(400).json({ error: "Invalid provider wallet public key" });
        return;
      }

      const canonicalWallet = providerWallet.toBase58();
      if (seededSet.has(canonicalWallet)) {
        res.status(403).json({
          error: "Seeded protocol demo providers are immutable and cannot be overwritten.",
        });
        return;
      }

      // Consume single-use server challenge & verify Ed25519 signature over canonical metadata payload
      const challenge = challengeNonces.get(String(nonce));
      if (!challenge || challenge.expiresAt < Date.now() || challenge.wallet !== canonicalWallet) {
        res.status(401).json({ error: "Invalid or expired registry challenge nonce" });
        return;
      }
      challengeNonces.delete(String(nonce));

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

      const resolvedEndpoint = hostedProxy
        ? `/providers/hosted/${canonicalWallet}`
        : String(endpointUrl || "").trim();

      if (!hostedProxy && !/^https?:\/\//i.test(resolvedEndpoint)) {
        res.status(400).json({
          error: "endpointUrl must start with http:// or https:// unless hostedProxy is enabled",
        });
        return;
      }

      let effectivePriceStr = priceLamports;
      if (customPrice !== undefined && customPrice !== null && customPrice !== "") {
        const rawPrice = String(customPrice).trim();
        if (!/^\d+$/.test(rawPrice)) {
          res.status(400).json({ error: "customPrice must be a positive integer lamport string" });
          return;
        }
        const priceBig = BigInt(rawPrice);
        if (priceBig <= 0n || priceBig > U64_MAX) {
          res.status(400).json({ error: "customPrice must be within valid u64 range (> 0)" });
          return;
        }
        effectivePriceStr = rawPrice;
      }

      const signedMessage = Buffer.from(
        JSON.stringify({
          action: "justice402-register-metadata",
          wallet: canonicalWallet,
          name: String(name).trim().slice(0, 80),
          endpointUrl: resolvedEndpoint,
          specHash: computedSpecHashHex,
          priceLamports: effectivePriceStr,
          nonce: String(nonce),
        })
      );
      const sigBuf = Buffer.from(String(signatureBase64), "base64");
      if (!verifyEd25519WalletSignature(signedMessage, sigBuf, providerWallet)) {
        res.status(401).json({
          error: "Invalid provider wallet Ed25519 signature over registry metadata",
        });
        return;
      }

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

      const entry: ProviderMetadataEntry = {
        wallet: canonicalWallet,
        name: String(name).trim().slice(0, 80),
        endpointUrl: resolvedEndpoint,
        specJson: canonicalSpec,
        specHash: computedSpecHashHex,
        hostedProxy: Boolean(hostedProxy),
        priceLamports: effectivePriceStr,
        description:
          String(description || "").trim().slice(0, 240) ||
          (hostedProxy
            ? "Community provider using Justice402 Hosted Test Route."
            : "Community x402 API provider registered on Solana Devnet."),
        badge: "community",
        createdAt: new Date().toISOString(),
      };

      const nextEntries = Array.from(registry.values())
        .filter((e) => !seededSet.has(e.wallet) && e.wallet !== entry.wallet)
        .concat(entry);

      persistEntriesStrict(nextEntries);
      registry.set(entry.wallet, entry);

      res.json({ ok: true, provider: entry });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to persist provider metadata" });
    }
  });

  // GET /providers/hosted/:wallet — Fail closed unless registered metadata & on-chain specHash match
  router.get("/hosted/:wallet", async (req: Request, res: Response) => {
    try {
      const providerWallet = new PublicKey(req.params.wallet);
      const walletStr = providerWallet.toBase58();
      const meta = registry.get(walletStr);

      if (!meta || !meta.specJson) {
        res.status(404).json({
          error: "Provider metadata/spec not published in registry yet.",
        });
        return;
      }

      const [providerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("provider"), providerWallet.toBuffer()],
        PROGRAM_ID
      );
      const accountInfo = await connection.getAccountInfo(providerPda);
      if (!accountInfo || accountInfo.data.length < 137) {
        res.status(404).json({ error: "Provider not registered on-chain" });
        return;
      }

      const onChainSpecHash = Buffer.from(accountInfo.data.subarray(64, 96)).toString("hex");
      const specHashBuf = crypto.createHash("sha256").update(meta.specJson).digest();
      if (specHashBuf.toString("hex") !== onChainSpecHash) {
        res.status(409).json({
          error: "Hosted metadata specHash does not match provider on-chain commitment",
        });
        return;
      }

      const buyerStr = (req.query.buyer as string) || (req.headers["x-buyer-wallet"] as string);
      const buyerPubkey = buyerStr ? new PublicKey(buyerStr) : PublicKey.default;
      const simulateLie = req.query.simulate === "lie";

      const payment = await verifyOrChallengeX402({
        req,
        res,
        payTo: providerWallet,
        priceLamports: meta.priceLamports,
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
      const requestHash = crypto
        .createHash("sha256")
        .update(req.originalUrl || req.path)
        .digest();

      const receiptData: ReceiptData = {
        version: RECEIPT_VERSION,
        provider: providerWallet,
        buyer: buyerPubkey,
        specHash: specHashBuf,
        requestHash,
        responseHash,
        paymentReference: payment.paymentRef,
        price: new BN(meta.priceLamports),
        timestamp: ts,
        nonce: ts,
      };
      const canonicalBytes = encodeReceipt(receiptData);

      res.json({
        data: responseData,
        specJson: meta.specJson,
        receipt: {
          bytesBase64: canonicalBytes.toString("base64"),
          needsProviderSignature: true,
        },
        payment: payment.paymentTxSig
          ? {
              txSignature: payment.paymentTxSig,
              payTo: walletStr,
              amountLamports: meta.priceLamports,
            }
          : undefined,
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "Invalid hosted provider call" });
    }
  });

  // POST /providers/proxy — Hardened CORS-safe relay with DNS/IP SSRF guard, disabled redirects, timeout & byte cap
  router.post("/proxy", async (req: Request, res: Response) => {
    try {
      const { targetUrl, paymentSignature } = req.body || {};
      if (!targetUrl || typeof targetUrl !== "string" || !/^https?:\/\//i.test(targetUrl)) {
        res.status(400).json({ error: "Invalid targetUrl" });
        return;
      }

      await assertPublicDestination(targetUrl);

      const headers: Record<string, string> = {};
      if (paymentSignature) headers["PAYMENT-SIGNATURE"] = String(paymentSignature);

      const upstream = await fetch(targetUrl, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });

      if (upstream.status >= 300 && upstream.status < 400) {
        res.status(403).json({
          error: "Redirects are blocked on the CORS proxy for egress security.",
        });
        return;
      }

      const text = await readResponseWithLimit(upstream, PROXY_MAX_BYTES);
      let body: any = text;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          // keep text
        }
      } else {
        body = null;
      }

      const collectedHeaders = {
        "payment-required": upstream.headers.get("payment-required"),
        "payment-response": upstream.headers.get("payment-response"),
        "x-justice402-receipt": upstream.headers.get("x-justice402-receipt"),
        "x-justice402-signature": upstream.headers.get("x-justice402-signature"),
      };

      // Always return HTTP 200 envelope with upstream status preserved (handles 204, 402, etc. uniformly)
      res.status(200).json({
        proxied: true,
        status: upstream.status,
        headers: collectedHeaders,
        body,
      });
    } catch (err: any) {
      const msg = err?.message || "Upstream proxy error";
      const code = msg.includes("blocked") || msg.includes("private") ? 403 : 502;
      res.status(code).json({ error: msg });
    }
  });

  return router;
}

import { Request, Response } from "express";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

export const MAX_PAYMENT_AGE_SECONDS = 3600; // 1 hour window for proof freshness

export interface X402ChallengeOptions {
  req: Request;
  res: Response;
  payTo: PublicKey;
  priceLamports: string;
  requirePayment: boolean;
  rpcUrl: string;
  connection?: Connection | null;
  usedSignatures: Map<string, number>;
}

/**
 * Shared x402 V2 challenge & Solana Devnet settlement verification helper.
 * Preserves lookup-table account resolution, enforces transaction freshness,
 * and records redeemed signatures atomically after validation.
 */
export async function verifyOrChallengeX402(
  opts: X402ChallengeOptions
): Promise<{ ok: boolean; paymentRef: Buffer; paymentTxSig?: string }> {
  const { req, res, payTo, priceLamports, requirePayment, rpcUrl, usedSignatures } = opts;

  if (!/^\d+$/.test(priceLamports) || BigInt(priceLamports) <= 0n) {
    res.status(500).json({ error: "Invalid server price configuration" });
    return { ok: false, paymentRef: Buffer.alloc(64, 0) };
  }

  const enforce =
    requirePayment ||
    req.query.x402 === "1" ||
    req.headers["x-justice402-require-payment"] === "1";

  if (!enforce) {
    return { ok: true, paymentRef: Buffer.alloc(64, 0) };
  }

  const paymentHeader = req.headers["payment-signature"] as string | undefined;

  if (!paymentHeader) {
    const paymentRequired = {
      x402Version: 2,
      error: "Payment Required",
      accepts: [
        {
          scheme: "exact",
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          asset: "SOL",
          amount: priceLamports,
          payTo: payTo.toBase58(),
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

  // Prune expired redemption entries past tx freshness window + safety margin
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [sig, expiresAtSec] of usedSignatures.entries()) {
    if (expiresAtSec < nowSec) {
      usedSignatures.delete(sig);
    }
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

  const conn = opts.connection || new Connection(rpcUrl, "confirmed");
  let txInfo: any = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    txInfo = await conn.getTransaction(txSignature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (txInfo) break;
    await new Promise((r) => setTimeout(r, 800));
  }

  if (!txInfo || !txInfo.meta || txInfo.meta.err) {
    res.status(402).json({
      error: "Payment transaction not confirmed, missing metadata, or failed on Solana",
      txSignature,
    });
    return { ok: false, paymentRef: Buffer.alloc(64, 0) };
  }

  // Reject stale payment transactions outside proof freshness window
  const txBlockTime: number | null = txInfo.blockTime ?? null;
  if (txBlockTime !== null && nowSec - txBlockTime > MAX_PAYMENT_AGE_SECONDS) {
    res.status(402).json({
      error: "Payment transaction expired outside freshness window",
      txSignature,
    });
    return { ok: false, paymentRef: Buffer.alloc(64, 0) };
  }

  // Resolve full ordered account keys including address lookup table loaded addresses
  const msg = txInfo.transaction.message;
  const accountKeys: PublicKey[] = msg.getAccountKeys
    ? msg
        .getAccountKeys({ accountKeysFromLookups: txInfo.meta.loadedAddresses })
        .keySegments()
        .flat()
    : msg.accountKeys;

  const payToIdx = accountKeys.findIndex((k: PublicKey) => k.equals(payTo));
  const minRequired = BigInt(priceLamports);
  const received =
    payToIdx >= 0
      ? BigInt(txInfo.meta.postBalances[payToIdx] - txInfo.meta.preBalances[payToIdx])
      : 0n;

  if (received < minRequired) {
    res.status(402).json({
      error: `Insufficient SOL payment to ${payTo.toBase58()}: expected ${minRequired}, received ${received}`,
      txSignature,
    });
    return { ok: false, paymentRef: Buffer.alloc(64, 0) };
  }

  // Synchronous check-and-set with no intervening await to prevent concurrent replay
  if (usedSignatures.has(txSignature)) {
    res.status(402).json({ error: "Payment signature already redeemed" });
    return { ok: false, paymentRef: Buffer.alloc(64, 0) };
  }
  const retainUntilSec = (txBlockTime ?? nowSec) + MAX_PAYMENT_AGE_SECONDS + 300;
  usedSignatures.set(txSignature, retainUntilSec);

  return { ok: true, paymentRef: Buffer.from(sigBytes), paymentTxSig: txSignature };
}

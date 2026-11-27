/**
 * Browser-compatible receipt decoding and verification.
 * Mirrors packages/anchor-client/src/receipt.ts without Node.js Buffer/crypto.
 */
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

export const RECEIPT_VERSION = 1;
export const RECEIPT_CANONICAL_LEN = 249;

export interface ReceiptDataBrowser {
  version: number;
  provider: PublicKey;
  buyer: PublicKey;
  specHash: Uint8Array;        // 32 bytes
  requestHash: Uint8Array;     // 32 bytes
  responseHash: Uint8Array;    // 32 bytes
  paymentReference: Uint8Array;// 64 bytes
  price: bigint;               // u64 LE
  timestamp: bigint;           // i64 LE
  nonce: bigint;               // u64 LE
}

function readU64LE(arr: Uint8Array, offset: number): bigint {
  const view = new DataView(arr.buffer, arr.byteOffset + offset, 8);
  const lo = BigInt(view.getUint32(0, true));
  const hi = BigInt(view.getUint32(4, true));
  return (hi << 32n) | lo;
}

function readI64LE(arr: Uint8Array, offset: number): bigint {
  const view = new DataView(arr.buffer, arr.byteOffset + offset, 8);
  return view.getBigInt64(0, true);
}

export function decodeReceiptBrowser(base64: string): ReceiptDataBrowser {
  const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  if (raw.length !== RECEIPT_CANONICAL_LEN) {
    throw new Error(`Invalid receipt length: expected ${RECEIPT_CANONICAL_LEN}, got ${raw.length}`);
  }

  let off = 0;
  const version = raw[off]; off += 1;
  const provider = new PublicKey(raw.slice(off, off + 32)); off += 32;
  const buyer = new PublicKey(raw.slice(off, off + 32)); off += 32;
  const specHash = raw.slice(off, off + 32); off += 32;
  const requestHash = raw.slice(off, off + 32); off += 32;
  const responseHash = raw.slice(off, off + 32); off += 32;
  const paymentReference = raw.slice(off, off + 64); off += 64;
  const price = readU64LE(raw, off); off += 8;
  const timestamp = readI64LE(raw, off); off += 8;
  const nonce = readU64LE(raw, off); off += 8;

  return {
    version,
    provider,
    buyer,
    specHash,
    requestHash,
    responseHash,
    paymentReference,
    price,
    timestamp,
    nonce,
  };
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function decodePaymentRefTxSig(paymentReference: Uint8Array): string | null {
  const allZero = paymentReference.every((b) => b === 0);
  if (allZero) return null;
  try {
    return bs58.encode(paymentReference);
  } catch {
    return null;
  }
}

/** SHA-256 in browser via SubtleCrypto */
export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const encoded = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const copy = new Uint8Array(encoded);
  const hash = await crypto.subtle.digest("SHA-256", copy);
  return new Uint8Array(hash);
}

/** Encode receipt fields back to canonical 249-byte format for hashing */
export function encodeReceiptBrowser(r: ReceiptDataBrowser): Uint8Array {
  const buf = new Uint8Array(RECEIPT_CANONICAL_LEN);
  const view = new DataView(buf.buffer);
  let off = 0;

  buf[off] = r.version; off += 1;
  buf.set(r.provider.toBytes(), off); off += 32;
  buf.set(r.buyer.toBytes(), off); off += 32;
  buf.set(r.specHash, off); off += 32;
  buf.set(r.requestHash, off); off += 32;
  buf.set(r.responseHash, off); off += 32;
  buf.set(r.paymentReference, off); off += 64;

  view.setUint32(off, Number(r.price & 0xffffffffn), true);
  view.setUint32(off + 4, Number(r.price >> 32n), true);
  off += 8;

  view.setBigInt64(off, r.timestamp, true);
  off += 8;

  view.setUint32(off, Number(r.nonce & 0xffffffffn), true);
  view.setUint32(off + 4, Number(r.nonce >> 32n), true);
  off += 8;

  return buf;
}

import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import BN from "bn.js";

export const RECEIPT_VERSION = 1;
export const RECEIPT_CANONICAL_LEN = 217;

export interface ReceiptData {
  version: number;
  provider: PublicKey;
  buyer: PublicKey;
  requestHash: Buffer;     // 32 bytes
  responseHash: Buffer;    // 32 bytes
  paymentReference: Buffer;// 64 bytes
  price: BN | bigint | number; // 8 bytes u64 LE
  timestamp: BN | bigint | number; // 8 bytes i64 LE
  nonce: BN | bigint | number; // 8 bytes u64 LE
}

export function encodeReceipt(receipt: ReceiptData): Buffer {
  const buf = Buffer.alloc(RECEIPT_CANONICAL_LEN);
  let offset = 0;

  // 1. Version (1 byte)
  buf.writeUInt8(receipt.version, offset);
  offset += 1;

  // 2. Provider (32 bytes)
  const providerBytes = receipt.provider.toBuffer();
  if (providerBytes.length !== 32) throw new Error("Invalid provider pubkey length");
  providerBytes.copy(buf, offset);
  offset += 32;

  // 3. Buyer (32 bytes)
  const buyerBytes = receipt.buyer.toBuffer();
  if (buyerBytes.length !== 32) throw new Error("Invalid buyer pubkey length");
  buyerBytes.copy(buf, offset);
  offset += 32;

  // 4. Request Hash (32 bytes)
  if (receipt.requestHash.length !== 32) throw new Error("Invalid requestHash length");
  receipt.requestHash.copy(buf, offset);
  offset += 32;

  // 5. Response Hash (32 bytes)
  if (receipt.responseHash.length !== 32) throw new Error("Invalid responseHash length");
  receipt.responseHash.copy(buf, offset);
  offset += 32;

  // 6. Payment Reference (64 bytes)
  if (receipt.paymentReference.length !== 64) throw new Error("Invalid paymentReference length");
  receipt.paymentReference.copy(buf, offset);
  offset += 64;

  // 7. Price (8 bytes u64 LE)
  const priceBN = new BN(receipt.price.toString());
  priceBN.toArrayLike(Buffer, "le", 8).copy(buf, offset);
  offset += 8;

  // 8. Timestamp (8 bytes i64 LE)
  const tsBN = new BN(receipt.timestamp.toString());
  tsBN.toArrayLike(Buffer, "le", 8).copy(buf, offset);
  offset += 8;

  // 9. Nonce (8 bytes u64 LE)
  const nonceBN = new BN(receipt.nonce.toString());
  nonceBN.toArrayLike(Buffer, "le", 8).copy(buf, offset);
  offset += 8;

  if (offset !== RECEIPT_CANONICAL_LEN) {
    throw new Error(`Expected offset ${RECEIPT_CANONICAL_LEN}, got ${offset}`);
  }

  return buf;
}

export function decodeReceipt(buf: Buffer): ReceiptData {
  if (buf.length !== RECEIPT_CANONICAL_LEN) {
    throw new Error(`Invalid buffer length: expected ${RECEIPT_CANONICAL_LEN}, got ${buf.length}`);
  }

  let offset = 0;
  const version = buf.readUInt8(offset);
  offset += 1;

  const provider = new PublicKey(buf.subarray(offset, offset + 32));
  offset += 32;

  const buyer = new PublicKey(buf.subarray(offset, offset + 32));
  offset += 32;

  const requestHash = Buffer.from(buf.subarray(offset, offset + 32));
  offset += 32;

  const responseHash = Buffer.from(buf.subarray(offset, offset + 32));
  offset += 32;

  const paymentReference = Buffer.from(buf.subarray(offset, offset + 64));
  offset += 64;

  const price = new BN(buf.subarray(offset, offset + 8), "le");
  offset += 8;

  const timestamp = new BN(buf.subarray(offset, offset + 8), "le");
  offset += 8;

  const nonce = new BN(buf.subarray(offset, offset + 8), "le");
  offset += 8;

  return {
    version,
    provider,
    buyer,
    requestHash,
    responseHash,
    paymentReference,
    price,
    timestamp,
    nonce,
  };
}

export function hashReceipt(receiptBytes: Buffer): Buffer {
  return createHash("sha256").update(receiptBytes).digest();
}


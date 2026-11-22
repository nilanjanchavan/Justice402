import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import BN from "bn.js";

export const RECEIPT_VERSION = 1;
export const RECEIPT_CANONICAL_LEN = 217;

const U64_MAX = new BN("ffffffffffffffff", 16);
const I64_MIN = new BN("-8000000000000000", 16);
const I64_MAX = new BN("7fffffffffffffff", 16);

export interface ReceiptData {
  version: number;
  provider: PublicKey;
  buyer: PublicKey;
  requestHash: Buffer;     // 32 bytes
  responseHash: Buffer;    // 32 bytes
  paymentReference: Buffer;// 64 bytes
  price: BN | bigint | number | string; // 8 bytes u64 LE
  timestamp: BN | bigint | number | string; // 8 bytes i64 LE
  nonce: BN | bigint | number | string; // 8 bytes u64 LE
}

function toU64BN(val: BN | bigint | number | string, fieldName: string): BN {
  if (typeof val === "number") {
    if (!Number.isInteger(val) || !Number.isSafeInteger(val)) {
      throw new Error(`${fieldName} must be a safe integer number`);
    }
  }
  let bn: BN;
  if (typeof val === "bigint") {
    bn = new BN(val.toString());
  } else if (BN.isBN(val)) {
    bn = val;
  } else {
    bn = new BN(val.toString());
  }

  if (bn.isNeg() || bn.gt(U64_MAX)) {
    throw new Error(`${fieldName} must be an unsigned 64-bit integer [0, 2^64 - 1]`);
  }
  return bn;
}

function toI64BN(val: BN | bigint | number | string, fieldName: string): BN {
  if (typeof val === "number") {
    if (!Number.isInteger(val) || !Number.isSafeInteger(val)) {
      throw new Error(`${fieldName} must be a safe integer number`);
    }
  }
  let bn: BN;
  if (typeof val === "bigint") {
    bn = new BN(val.toString());
  } else if (BN.isBN(val)) {
    bn = val;
  } else {
    bn = new BN(val.toString());
  }

  if (bn.lt(I64_MIN) || bn.gt(I64_MAX)) {
    throw new Error(`${fieldName} must be a signed 64-bit integer [-2^63, 2^63 - 1]`);
  }
  return bn;
}

export function encodeReceipt(receipt: ReceiptData): Buffer {
  if (receipt.version !== RECEIPT_VERSION) {
    throw new Error(`Invalid receipt version: expected ${RECEIPT_VERSION}, got ${receipt.version}`);
  }

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
  const priceBN = toU64BN(receipt.price, "price");
  priceBN.toArrayLike(Buffer, "le", 8).copy(buf, offset);
  offset += 8;

  // 8. Timestamp (8 bytes i64 LE two's complement)
  const tsBN = toI64BN(receipt.timestamp, "timestamp");
  tsBN.toTwos(64).toArrayLike(Buffer, "le", 8).copy(buf, offset);
  offset += 8;

  // 9. Nonce (8 bytes u64 LE)
  const nonceBN = toU64BN(receipt.nonce, "nonce");
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

  const timestamp = new BN(buf.subarray(offset, offset + 8), "le").fromTwos(64);
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

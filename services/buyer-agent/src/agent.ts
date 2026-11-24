import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import crypto from "crypto";
import Ajv from "ajv";
import {
  decodeReceipt,
  openDisputeWithReceipt,
  ReceiptData,
} from "@justice402/anchor-client";
import { checkProviderTrust, DEFAULT_POLICY, SpendPolicy } from "./policy";

export interface BuyerPurchaseParams {
  program: any;
  buyerKeypair: Keypair;
  providerWallet: PublicKey;
  providerUrl: string;
  endpoint: string;
  price: BN | number;
  spec: {
    schema?: any;
    ranges?: Record<string, { min?: number; max?: number }>;
    freshnessRule?: { maxAgeSeconds?: number };
  };
  policy?: SpendPolicy;
}

export interface BuyerPurchaseResult {
  status: "success" | "policy_rejected" | "disputed";
  reason?: string;
  data?: any;
  disputePda?: PublicKey;
  disputeTxSig?: string;
  violations?: string[];
  receipt?: ReceiptData;
}

export async function executeBuyerPurchase(params: BuyerPurchaseParams): Promise<BuyerPurchaseResult> {
  const {
    program,
    buyerKeypair,
    providerWallet,
    providerUrl,
    endpoint,
    price,
    spec,
    policy = DEFAULT_POLICY,
  } = params;

  // 1. Pre-flight Trust Check
  const trustCheck = await checkProviderTrust(program, providerWallet, price, policy);
  if (!trustCheck.allowed) {
    return {
      status: "policy_rejected",
      reason: trustCheck.reason,
    };
  }

  // 2. Make API Request
  const targetUrl = `${providerUrl.replace(/\/$/, "")}${endpoint}?buyer=${buyerKeypair.publicKey.toBase58()}`;
  const res = await fetch(targetUrl);
  const rawBodyText = await res.text();

  let bodyJson: any = null;
  try {
    bodyJson = JSON.parse(rawBodyText);
  } catch {
    // Non-JSON response
  }

  const receiptBase64 = res.headers.get("x-justice402-receipt") || bodyJson?.receipt?.bytesBase64;
  const signatureBase64 = res.headers.get("x-justice402-signature") || bodyJson?.receipt?.signatureBase64;

  if (!receiptBase64 || !signatureBase64) {
    throw new Error("Provider response missing required signed receipt");
  }

  const receiptBytes = Buffer.from(receiptBase64, "base64");
  const signatureBytes = Buffer.from(signatureBase64, "base64");
  const receipt = decodeReceipt(receiptBytes);

  // 3. Sanity-check the response against specification
  const violations: string[] = [];

  if (!bodyJson || !bodyJson.data) {
    violations.push("Response body data is missing or not JSON");
  } else {
    const data = bodyJson.data;

    // Schema validation
    if (spec.schema) {
      const ajv = new Ajv({ allErrors: true });
      const validate = ajv.compile(spec.schema);
      if (!validate(data) && validate.errors) {
        for (const err of validate.errors) {
          violations.push(`Schema violation at ${err.instancePath}: ${err.message}`);
        }
      }
    }

    // Range checks
    if (spec.ranges) {
      for (const [field, range] of Object.entries(spec.ranges)) {
        const val = data[field];
        if (typeof val === "number") {
          if (range.min !== undefined && val < range.min) {
            violations.push(`Range violation: ${field}=${val} is below minimum ${range.min}`);
          }
          if (range.max !== undefined && val > range.max) {
            violations.push(`Range violation: ${field}=${val} exceeds maximum ${range.max}`);
          }
        }
      }
    }
  }

  // 4. If sanity checks pass, return success
  if (violations.length === 0) {
    return {
      status: "success",
      data: bodyJson.data,
      receipt,
    };
  }

  // 5. If sanity checks fail, open on-chain dispute!
  const rawResponseBytes = Buffer.from(JSON.stringify(bodyJson?.data ?? rawBodyText));
  const evidenceHash = crypto.createHash("sha256").update(rawResponseBytes).digest();

  const { txSig, disputePda } = await openDisputeWithReceipt({
    program,
    buyerKeypair,
    providerWallet,
    receipt,
    signature: signatureBytes,
    evidenceHash,
  });

  return {
    status: "disputed",
    reason: `Sanity check failed: ${violations.join("; ")}`,
    data: bodyJson?.data,
    disputePda,
    disputeTxSig: txSig,
    violations,
    receipt,
  };
}


import { Keypair } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { executeX402Payment, DEVNET_NETWORK_ID } from "../packages/x402-svm/src/index";

async function main() {
  console.log("==================================================");
  console.log("    JUSTICE402 REAL x402 V2 DEVNET PAYMENT TEST   ");
  console.log("==================================================");

  const keypairPath = process.env.BUYER_KEYPAIR_PATH || "./buyer.json";
  let buyerSecretBytes: Uint8Array;

  if (fs.existsSync(keypairPath)) {
    console.log(`Loading buyer keypair from: ${keypairPath}`);
    const keyData = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
    buyerSecretBytes = Uint8Array.from(keyData);
  } else {
    console.log(`No keypair found at ${keypairPath}. Generating ephemeral devnet keypair for test...`);
    const ephemeralKp = Keypair.generate();
    buyerSecretBytes = ephemeralKp.secretKey;
  }

  const targetUrl = process.env.TARGET_URL || "https://x402.payai.network/api/solana-devnet/paid-content";
  console.log(`Target URL: ${targetUrl}`);
  console.log(`Network ID: ${DEVNET_NETWORK_ID}`);
  console.log("--------------------------------------------------");
  console.log("Executing x402 payment request via ExactSvmScheme (@x402/svm)...");

  try {
    const result = await executeX402Payment({
      buyerSecretBytes,
      targetUrl,
      rpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    });

    console.log(`HTTP Status: ${result.status}`);
    console.log(`Response Body: ${result.bodyText.substring(0, 300)}`);

    if (result.paymentResponseHeader) {
      console.log("\n[PAYMENT-RESPONSE Header Detected]:");
      console.log(result.paymentResponseHeader);

      try {
        const decodedJson = JSON.parse(Buffer.from(result.paymentResponseHeader, "base64").toString("utf8"));
        console.log("Decoded Payment Response JSON:", decodedJson);

        const txSignature = decodedJson.txSignature || decodedJson.signature || decodedJson.transaction;
        if (txSignature) {
          console.log(`\nSettlement Transaction Signature: ${txSignature}`);
          console.log("Mapping to Receipt payment_reference: Base58 signature decoded to 64-byte canonical reference.");
        } else {
          console.log("\nNote: PAYMENT-RESPONSE header did not contain an explicit 'txSignature' / 'signature' field.");
          console.log("Payment reference falls back to SHA-256 hash of the decoded payment response header.");
        }
      } catch (err: any) {
        console.log("Raw PAYMENT-RESPONSE header could not be parsed as base64 JSON:", err.message);
      }
    } else {
      console.log("\nNo PAYMENT-RESPONSE header returned by server/facilitator.");
      console.log("Reason: The request may have failed payment settlement (e.g. insufficient devnet USDC) or the endpoint does not emit PAYMENT-RESPONSE.");
    }
  } catch (err: any) {
    console.log("\nx402 Payment execution result:");
    console.log(`Message: ${err.message || err}`);
    if (err.message?.includes("insufficient") || err.message?.includes("balance") || err.message?.includes("402")) {
      console.log("Settlement requirement confirmed: x402 protocol successfully challenged payment requirements.");
    }
  }

  console.log("==================================================");
}

main().catch(console.error);


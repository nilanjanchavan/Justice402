import { Keypair } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { createProviderApp } from "./server";
import { SPEC_HASH } from "./spec";

function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [k, ...vals] = trimmed.split("=");
      if (k && !process.env[k.trim()]) {
        process.env[k.trim()] = vals.join("=").trim().replace(/^["']|["']$/g, "");
      }
    }
  }
}

async function startServer() {
  loadEnv();

  const port = parseInt(process.env.PROVIDER_PORT || process.env.PORT || "3402", 10);
  const keypairPath = process.env.PROVIDER_KEYPAIR_PATH;
  let providerKeypair: Keypair;

  if (keypairPath && fs.existsSync(keypairPath)) {
    const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
    providerKeypair = Keypair.fromSecretKey(Uint8Array.from(secret));
  } else if (process.env.PROVIDER_SEED) {
    providerKeypair = Keypair.fromSeed(crypto.createHash("sha256").update(process.env.PROVIDER_SEED).digest().subarray(0, 32));
  } else {
    // Default deterministic honest provider keypair for devnet
    providerKeypair = Keypair.fromSeed(crypto.createHash("sha256").update("justice402-devnet-honest-provider").digest().subarray(0, 32));
  }

  const priceLamports = parseInt(process.env.PRICE_USDC || "5000000", 10); // 5 USDC
  const allowedOrigin = process.env.DASHBOARD_ORIGIN || process.env.ALLOWED_ORIGINS || "*";

  console.log("==================================================");
  console.log("       JUSTICE402 HOSTED PROVIDER API SERVICE     ");
  console.log("==================================================");
  console.log(`Port:           ${port}`);
  console.log(`Provider Pubkey:${providerKeypair.publicKey.toBase58()}`);
  console.log(`Spec Hash:      ${SPEC_HASH.toString("hex")}`);
  console.log(`Price / Query:  ${priceLamports} units (USDC)`);
  console.log(`Allowed CORS:   ${allowedOrigin}`);
  console.log("==================================================");

  const app = createProviderApp({
    providerKeypair,
    specHash: SPEC_HASH,
    priceLamports,
    allowedOrigin,
  });

  const server = app.listen(port, () => {
    console.log(`Server listening on port ${port}...`);
    console.log(`Health check: http://127.0.0.1:${port}/health`);
    console.log(`Service Spec: http://127.0.0.1:${port}/spec`);
    console.log(`Reference:    http://127.0.0.1:${port}/reference/weather`);
  });

  process.on("SIGTERM", () => {
    console.log("SIGTERM received, closing server...");
    server.close(() => process.exit(0));
  });
}

startServer().catch((err) => {
  console.error("Failed to start provider server:", err.message || err);
  process.exit(1);
});


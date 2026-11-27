import { Connection, Keypair } from "@solana/web3.js";
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

function keypairFromSeedLabel(label: string): Keypair {
  return Keypair.fromSeed(
    crypto.createHash("sha256").update(label).digest().subarray(0, 32)
  );
}

async function startServer() {
  loadEnv();

  const port = parseInt(process.env.PROVIDER_PORT || process.env.PORT || "3402", 10);
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  const keypairPath = process.env.PROVIDER_KEYPAIR_PATH;
  let providerKeypair: Keypair;

  if (keypairPath && fs.existsSync(keypairPath)) {
    const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
    providerKeypair = Keypair.fromSecretKey(Uint8Array.from(secret));
  } else if (process.env.PROVIDER_SEED) {
    providerKeypair = keypairFromSeedLabel(process.env.PROVIDER_SEED);
  } else {
    providerKeypair = keypairFromSeedLabel("justice402-devnet-honest-provider");
  }

  const lyingProviderKeypair = keypairFromSeedLabel("justice402-devnet-lying-provider");
  const subtleProviderKeypair = keypairFromSeedLabel("justice402-devnet-subtle-provider");

  const priceLamports = parseInt(
    process.env.PRICE_LAMPORTS || process.env.PRICE_USDC || "10000000",
    10
  );
  const allowedOrigin =
    process.env.DASHBOARD_ORIGIN || process.env.ALLOWED_ORIGINS || "*";
  const requirePayment = process.env.REQUIRE_X402_PAYMENT !== "false";

  // Sync clock offset with Solana Devnet block time so signed receipts stay inside +/-60s skew
  let clockOffsetSec = 0;
  const conn = new Connection(rpcUrl, "confirmed");
  const syncClock = async () => {
    try {
      const slot = await conn.getSlot("confirmed");
      const blockTime = await conn.getBlockTime(slot);
      if (blockTime) {
        clockOffsetSec = blockTime - Math.floor(Date.now() / 1000);
      }
    } catch {
      // Keep last known offset
    }
  };
  await syncClock();
  const clockTimer = setInterval(syncClock, 60_000);
  clockTimer.unref();

  console.log("==================================================");
  console.log("       JUSTICE402 HOSTED PROVIDER API SERVICE     ");
  console.log("==================================================");
  console.log(`Port:           ${port}`);
  console.log(`RPC URL:        ${rpcUrl} (clock offset: ${clockOffsetSec}s)`);
  console.log(`Honest Pubkey:  ${providerKeypair.publicKey.toBase58()}`);
  console.log(`Lying Pubkey:   ${lyingProviderKeypair.publicKey.toBase58()}`);
  console.log(`Subtle Pubkey:  ${subtleProviderKeypair.publicKey.toBase58()}`);
  console.log(`Spec Hash:      ${SPEC_HASH.toString("hex")}`);
  console.log(`Price / Query:  ${priceLamports} lamports (${(priceLamports / 1e9).toFixed(4)} SOL)`);
  console.log(`x402 Enforce:   ${requirePayment}`);
  console.log(`Allowed CORS:   ${allowedOrigin}`);
  console.log("==================================================");

  const app = createProviderApp({
    providerKeypair,
    lyingProviderKeypair,
    subtleProviderKeypair,
    specHash: SPEC_HASH,
    priceLamports,
    allowedOrigin,
    requirePayment,
    rpcUrl,
    nowFn: () => Math.floor(Date.now() / 1000) + clockOffsetSec,
  });

  const server = app.listen(port, () => {
    console.log(`Server listening on port ${port}...`);
  });

  process.on("SIGTERM", () => {
    console.log("SIGTERM received, closing server...");
    clearInterval(clockTimer);
    server.close(() => process.exit(0));
  });
}

startServer().catch((err) => {
  console.error("Failed to start provider server:", err.message || err);
  process.exit(1);
});

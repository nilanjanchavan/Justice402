import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import crypto from "crypto";
import { ReceiptData, RECEIPT_VERSION } from "../packages/anchor-client/src/receipt";
import { runDeterministicSpecCheck } from "../services/arbiter/src/verifier";
import { WEATHER_SERVICE_SPEC, SPEC_HASH, SPEC_CANONICAL_JSON } from "../services/provider-api/src/spec";

describe("Deterministic Spec Check & Freshness Tests", () => {
  const dummyProvider = PublicKey.default;
  const dummyBuyer = PublicKey.default;
  const now = 1700000000;

  function createTestReceiptForResponse(rawResponse: Buffer): ReceiptData {
    return {
      version: RECEIPT_VERSION,
      provider: dummyProvider,
      buyer: dummyBuyer,
      specHash: SPEC_HASH,
      requestHash: crypto.createHash("sha256").update("/weather").digest(),
      responseHash: crypto.createHash("sha256").update(rawResponse).digest(),
      paymentReference: Buffer.alloc(64, 0),
      price: new BN(5_000_000),
      timestamp: now,
      nonce: new BN(1),
    };
  }

  it("1. Honest response passes ALL deterministic checks", () => {
    const honestData = {
      city: "SolanaBeach",
      temperature: 24.5,
      humidity: 55,
      observedAt: now - 30, // 30 seconds ago (fresh <= 300s)
    };
    const rawResponse = Buffer.from(JSON.stringify(honestData));
    const receipt = createTestReceiptForResponse(rawResponse);

    const result = runDeterministicSpecCheck({
      specContent: SPEC_CANONICAL_JSON,
      expectedSpecHash: SPEC_HASH,
      receipt,
      evidenceBytes: rawResponse,
      currentTime: now,
    });

    expect(result.isValid).to.be.true;
    expect(result.specHashMatch).to.be.true;
    expect(result.responseHashMatch).to.be.true;
    expect(result.schemaValid).to.be.true;
    expect(result.rangesValid).to.be.true;
    expect(result.freshnessValid).to.be.true;
    expect(result.errors.length).to.equal(0);
  });

  it("2. Stale response fails freshness ONLY (schema and ranges pass)", () => {
    const staleData = {
      city: "SolanaBeach",
      temperature: 24.5,
      humidity: 55,
      observedAt: now - 600, // 600 seconds ago (maxAge is 300s)
    };
    const rawResponse = Buffer.from(JSON.stringify(staleData));
    const receipt = createTestReceiptForResponse(rawResponse);

    const result = runDeterministicSpecCheck({
      specContent: SPEC_CANONICAL_JSON,
      expectedSpecHash: SPEC_HASH,
      receipt,
      evidenceBytes: rawResponse,
      currentTime: now,
    });

    expect(result.isValid).to.be.false;
    expect(result.specHashMatch).to.be.true;
    expect(result.responseHashMatch).to.be.true;
    expect(result.schemaValid).to.be.true;
    expect(result.rangesValid).to.be.true;
    expect(result.freshnessValid).to.be.false;
    expect(result.errors.length).to.equal(1);
    expect(result.errors[0]).to.include("Response stale: age is 600s, max allowed is 300s");
  });

  it("3. Missing observedAt field fails with clear error message", () => {
    const missingFieldData = {
      city: "SolanaBeach",
      temperature: 24.5,
      humidity: 55,
    };
    const rawResponse = Buffer.from(JSON.stringify(missingFieldData));
    const receipt = createTestReceiptForResponse(rawResponse);

    const result = runDeterministicSpecCheck({
      specContent: SPEC_CANONICAL_JSON,
      expectedSpecHash: SPEC_HASH,
      receipt,
      evidenceBytes: rawResponse,
      currentTime: now,
    });

    expect(result.isValid).to.be.false;
    expect(result.freshnessValid).to.be.false;
    expect(result.errors.some((e) => e.includes("Field 'observedAt' is missing from response"))).to.be.true;
  });

  it("4. Production default path uses receipt.timestamp when currentTime is omitted", () => {
    // observedAt is 45s before receipt.timestamp; wall-clock time is long past the freshness window
    const honestData = {
      city: "SolanaBeach",
      temperature: 24.5,
      humidity: 55,
      observedAt: now - 45, // 45s before receipt timestamp (<= 300s)
    };
    const rawResponse = Buffer.from(JSON.stringify(honestData));
    const receipt = createTestReceiptForResponse(rawResponse);

    // Omit currentTime to exercise production default path
    const result = runDeterministicSpecCheck({
      specContent: SPEC_CANONICAL_JSON,
      expectedSpecHash: SPEC_HASH,
      receipt,
      evidenceBytes: rawResponse,
    });

    expect(result.isValid).to.be.true;
    expect(result.freshnessValid).to.be.true;
    expect(result.errors.length).to.equal(0);
  });

  it("5. Production default path rejects stale response relative to receipt.timestamp when currentTime is omitted", () => {
    // observedAt is 400s before receipt.timestamp (> 300s maxAge)
    const staleData = {
      city: "SolanaBeach",
      temperature: 24.5,
      humidity: 55,
      observedAt: now - 400,
    };
    const rawResponse = Buffer.from(JSON.stringify(staleData));
    const receipt = createTestReceiptForResponse(rawResponse);

    // Omit currentTime to exercise production default path
    const result = runDeterministicSpecCheck({
      specContent: SPEC_CANONICAL_JSON,
      expectedSpecHash: SPEC_HASH,
      receipt,
      evidenceBytes: rawResponse,
    });

    expect(result.isValid).to.be.false;
    expect(result.freshnessValid).to.be.false;
    expect(result.errors.some((e) => e.includes("Response stale: age is 400s, max allowed is 300s"))).to.be.true;
  });
});


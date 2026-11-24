import crypto from "crypto";
import Ajv from "ajv";
import { ReceiptData } from "@justice402/anchor-client";

export interface SpecCheckResults {
  isValid: boolean;
  specHashMatch: boolean;
  responseHashMatch: boolean;
  schemaValid: boolean;
  rangesValid: boolean;
  freshnessValid: boolean;
  errors: string[];
}

export interface DeterministicCheckParams {
  specContent: string;
  expectedSpecHash: Buffer;
  receipt: ReceiptData;
  evidenceBytes: Buffer;
  currentTime?: number;
}

export function runDeterministicSpecCheck(params: DeterministicCheckParams): SpecCheckResults {
  const { specContent, expectedSpecHash, receipt, evidenceBytes, currentTime = Math.floor(Date.now() / 1000) } = params;
  const errors: string[] = [];

  // 1. Verify sha256(spec) == expectedSpecHash
  const computedSpecHash = crypto.createHash("sha256").update(specContent).digest();
  const specHashMatch = computedSpecHash.equals(expectedSpecHash);
  if (!specHashMatch) {
    errors.push(
      `Spec hash mismatch: expected ${expectedSpecHash.toString("hex")}, computed ${computedSpecHash.toString("hex")}`
    );
  }

  // 2. Verify sha256(evidenceBytes) == receipt.responseHash
  const computedResponseHash = crypto.createHash("sha256").update(evidenceBytes).digest();
  const responseHashMatch = computedResponseHash.equals(receipt.responseHash);
  if (!responseHashMatch) {
    errors.push(
      `Response hash mismatch: receipt claims ${receipt.responseHash.toString("hex")}, raw evidence hashes to ${computedResponseHash.toString("hex")}`
    );
  }

  // Parse spec JSON
  let specObj: any = null;
  try {
    specObj = JSON.parse(specContent);
  } catch (err: any) {
    errors.push(`Spec content is not valid JSON: ${err.message}`);
    return {
      isValid: false,
      specHashMatch,
      responseHashMatch,
      schemaValid: false,
      rangesValid: false,
      freshnessValid: false,
      errors,
    };
  }

  // Parse evidence JSON
  let evidenceObj: any = null;
  try {
    evidenceObj = JSON.parse(evidenceBytes.toString("utf8"));
  } catch (err: any) {
    errors.push(`Evidence body is not valid JSON: ${err.message}`);
    return {
      isValid: false,
      specHashMatch,
      responseHashMatch,
      schemaValid: false,
      rangesValid: false,
      freshnessValid: false,
      errors,
    };
  }

  // 3. Validate against JSON schema
  const ajv = new Ajv({ allErrors: true });
  let schemaValid = false;
  if (specObj.schema) {
    const validate = ajv.compile(specObj.schema);
    schemaValid = validate(evidenceObj) === true;
    if (!schemaValid && validate.errors) {
      for (const err of validate.errors) {
        errors.push(`Schema violation at ${err.instancePath || "/"}: ${err.message}`);
      }
    }
  } else {
    schemaValid = true;
  }

  // 4. Validate numerical ranges
  let rangesValid = true;
  if (specObj.ranges) {
    for (const [field, range] of Object.entries<any>(specObj.ranges)) {
      const val = evidenceObj[field];
      if (typeof val === "number") {
        if (range.min !== undefined && val < range.min) {
          rangesValid = false;
          errors.push(`Field '${field}' value ${val} below minimum allowed ${range.min}`);
        }
        if (range.max !== undefined && val > range.max) {
          rangesValid = false;
          errors.push(`Field '${field}' value ${val} exceeds maximum allowed ${range.max}`);
        }
      }
    }
  }

  // 5. Freshness check using observedAt
  let freshnessValid = true;
  if (evidenceObj.observedAt === undefined || evidenceObj.observedAt === null) {
    freshnessValid = false;
    errors.push("Field 'observedAt' is missing from response; cannot evaluate freshness");
  } else if (typeof evidenceObj.observedAt !== "number" || !Number.isInteger(evidenceObj.observedAt)) {
    freshnessValid = false;
    errors.push("Field 'observedAt' must be a valid integer unix timestamp");
  } else if (specObj.freshnessRule?.maxAgeSeconds) {
    const age = currentTime - evidenceObj.observedAt;
    if (age > specObj.freshnessRule.maxAgeSeconds || age < -60) {
      freshnessValid = false;
      errors.push(`Response stale: age is ${age}s, max allowed is ${specObj.freshnessRule.maxAgeSeconds}s`);
    }
  }

  const isValid = specHashMatch && responseHashMatch && schemaValid && rangesValid && freshnessValid;

  return {
    isValid,
    specHashMatch,
    responseHashMatch,
    schemaValid,
    rangesValid,
    freshnessValid,
    errors,
  };
}

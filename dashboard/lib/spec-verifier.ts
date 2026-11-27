/**
 * Client-side deterministic spec verification.
 * Checks specHash match, responseHash match, schema validation, ranges, freshness.
 */
import { sha256, toHex } from "./receipt-browser";

export interface SpecCheckResult {
  isValid: boolean;
  specHashMatch: boolean;
  responseHashMatch: boolean;
  schemaValid: boolean;
  rangesValid: boolean;
  freshnessValid: boolean;
  errors: string[];
}

export interface SpecDef {
  service: string;
  description: string;
  endpoint: string;
  schema: {
    type: string;
    properties: Record<string, any>;
    required: string[];
    additionalProperties?: boolean;
  };
  ranges: Record<string, { min: number; max: number }>;
  freshnessRule: { maxAgeSeconds: number };
}

export async function verifyResponseAgainstSpec(params: {
  specJson: string;
  expectedSpecHash: Uint8Array;
  responseData: any;
  rawResponseBytes: Uint8Array;
  receiptResponseHash: Uint8Array;
  receiptTimestamp: bigint;
}): Promise<SpecCheckResult> {
  const { specJson, expectedSpecHash, responseData, rawResponseBytes, receiptResponseHash, receiptTimestamp } = params;
  const errors: string[] = [];

  // 1. Spec hash match
  const computedSpecHash = await sha256(specJson);
  const specHashMatch = toHex(computedSpecHash) === toHex(expectedSpecHash);
  if (!specHashMatch) {
    errors.push(`Spec hash mismatch: expected ${toHex(expectedSpecHash)}, computed ${toHex(computedSpecHash)}`);
  }

  // 2. Response hash match
  const computedResponseHash = await sha256(rawResponseBytes);
  const responseHashMatch = toHex(computedResponseHash) === toHex(receiptResponseHash);
  if (!responseHashMatch) {
    errors.push(`Response hash mismatch: receipt claims ${toHex(receiptResponseHash)}, computed ${toHex(computedResponseHash)}`);
  }

  // Parse spec
  let spec: SpecDef;
  try {
    spec = JSON.parse(specJson);
  } catch {
    errors.push("Spec content is not valid JSON");
    return { isValid: false, specHashMatch, responseHashMatch, schemaValid: false, rangesValid: false, freshnessValid: false, errors };
  }

  // 3. Schema validation (simplified - check required fields and types)
  let schemaValid = true;
  if (spec.schema) {
    const props = spec.schema.properties || {};
    const required = spec.schema.required || [];
    for (const field of required) {
      if (!(field in responseData)) {
        schemaValid = false;
        errors.push(`Schema violation: required field '${field}' is missing`);
      }
    }
    for (const [field, def] of Object.entries(props)) {
      if (field in responseData) {
        const val = responseData[field];
        const expectedType = def.type;
        if (expectedType === "string" && typeof val !== "string") {
          schemaValid = false;
          errors.push(`Schema violation: '${field}' should be string, got ${typeof val}`);
        }
        if (expectedType === "number" && typeof val !== "number") {
          schemaValid = false;
          errors.push(`Schema violation: '${field}' should be number, got ${typeof val}`);
        }
        if (expectedType === "integer" && (!Number.isInteger(val))) {
          schemaValid = false;
          errors.push(`Schema violation: '${field}' should be integer, got ${val}`);
        }
      }
    }
    if (spec.schema.additionalProperties === false) {
      const allowedKeys = new Set(Object.keys(props));
      for (const key of Object.keys(responseData)) {
        if (!allowedKeys.has(key)) {
          schemaValid = false;
          errors.push(`Schema violation: additional property '${key}' not allowed`);
        }
      }
    }
  }

  // 4. Range checks
  let rangesValid = true;
  if (spec.ranges) {
    for (const [field, range] of Object.entries(spec.ranges)) {
      const val = responseData[field];
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

  // 5. Freshness check
  let freshnessValid = true;
  if (responseData.observedAt === undefined || responseData.observedAt === null) {
    freshnessValid = false;
    errors.push("Field 'observedAt' is missing from response; cannot evaluate freshness");
  } else if (typeof responseData.observedAt !== "number" || !Number.isInteger(responseData.observedAt)) {
    freshnessValid = false;
    errors.push("Field 'observedAt' must be a valid integer unix timestamp");
  } else if (spec.freshnessRule?.maxAgeSeconds) {
    const refTime = Number(receiptTimestamp);
    const age = refTime - responseData.observedAt;
    if (age > spec.freshnessRule.maxAgeSeconds || age < -60) {
      freshnessValid = false;
      errors.push(`Response stale: age is ${age}s, max allowed is ${spec.freshnessRule.maxAgeSeconds}s`);
    }
  }

  const isValid = specHashMatch && responseHashMatch && schemaValid && rangesValid && freshnessValid;
  return { isValid, specHashMatch, responseHashMatch, schemaValid, rangesValid, freshnessValid, errors };
}


import crypto from "crypto";

export interface ServiceSpec {
  service: string;
  description: string;
  endpoint: string;
  schema: Record<string, any>;
  ranges: Record<string, { min: number; max: number }>;
  freshnessRule: { maxAgeSeconds: number };
}

export const WEATHER_SERVICE_SPEC: ServiceSpec = {
  service: "weather-oracle-v1",
  description: "Live weather service reporting verified temperature and humidity metrics",
  endpoint: "/weather",
  schema: {
    type: "object",
    properties: {
      city: { type: "string" },
      temperature: { type: "number", minimum: -50, maximum: 60 },
      humidity: { type: "number", minimum: 0, maximum: 100 },
      observedAt: { type: "integer", minimum: 0 },
    },
    required: ["city", "temperature", "humidity", "observedAt"],
    additionalProperties: false,
  },
  ranges: {
    temperature: { min: -50, max: 60 },
    humidity: { min: 0, max: 100 },
  },
  freshnessRule: {
    maxAgeSeconds: 300,
  },
};

export const SPEC_CANONICAL_JSON = JSON.stringify(WEATHER_SERVICE_SPEC);
export const SPEC_HASH = crypto.createHash("sha256").update(SPEC_CANONICAL_JSON).digest();

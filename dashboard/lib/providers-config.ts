import { OnChainProvider } from "./solana";

export interface ProviderConfig {
  name: string;
  endpoint: string;
  wallet: string;
  description: string;
  badge: "honest" | "lying" | "subtle" | "community";
  specJson?: string;
  specHash?: string;
  hostedProxy?: boolean;
  hasRegistryMetadata?: boolean;
  priceLamports?: string;
  chainState?: OnChainProvider;
}

export interface RegistryMetadata {
  wallet: string;
  name: string;
  endpointUrl: string;
  specJson: string;
  specHash: string;
  hostedProxy: boolean;
  priceLamports: string | number;
  description: string;
  badge: "honest" | "lying" | "subtle" | "community";
}

const PROVIDER_API_URL =
  process.env.NEXT_PUBLIC_PROVIDER_API_URL || "http://127.0.0.1:3402";

export const DEFAULT_WEATHER_SPEC_TEMPLATE = JSON.stringify(
  {
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
  },
  null,
  2
);

export const DEVNET_PROVIDERS: ProviderConfig[] = [
  {
    name: "Honest Weather Provider",
    endpoint: `${PROVIDER_API_URL}/weather`,
    wallet: "B6aqccJWm4GF8t7nPQREAvX48SJKSzrGxXj4eNUko8kU",
    description:
      "Returns accurate, spec-compliant weather data (24.5°C, 55%). All verification checks pass.",
    badge: "honest",
  },
  {
    name: "Lying Weather Provider",
    endpoint: `${PROVIDER_API_URL}/weather-lying`,
    wallet: "HjhJXmv1ZMuc2QaNMEvVMzDSKFSg2ftCajyiuVj6oCbx",
    description:
      "Returns out-of-range & stale data: temperature=9999°C, humidity=-50%, stale observedAt. Fails audit -> BuyerWins.",
    badge: "lying",
  },
  {
    name: "Plausible-Wrong Provider",
    endpoint: `${PROVIDER_API_URL}/weather-plausible-wrong`,
    wallet: "DyymyZfsaSPNpbBFpZTzxK1k7PXPEirPJ39hcTbN1L2Q",
    description:
      "Returns plausible values (38.0°C vs ground truth 24.5°C). Passes deterministic schema/range checks.",
    badge: "subtle",
  },
];

function resolveEndpointUrl(rawUrl: string, wallet: string): string {
  if (!rawUrl) return `${PROVIDER_API_URL}/providers/hosted/${wallet}`;
  if (rawUrl.startsWith("/")) return `${PROVIDER_API_URL}${rawUrl}`;
  return rawUrl;
}

/**
 * Merges live on-chain Provider accounts with seeded presets & backend registry metadata.
 * Community providers missing registry metadata retain `hasRegistryMetadata: false` so hosted calls stay blocked until published.
 */
export function mergeProvidersWithRegistry(
  onChainProviders: OnChainProvider[],
  registryEntries: RegistryMetadata[]
): ProviderConfig[] {
  const seededMap = new Map(DEVNET_PROVIDERS.map((p) => [p.wallet, p]));
  const regMap = new Map(registryEntries.map((r) => [r.wallet, r]));
  const seen = new Set<string>();
  const result: ProviderConfig[] = [];

  for (const seed of DEVNET_PROVIDERS) {
    seen.add(seed.wallet);
    const chain = onChainProviders.find((cp) => cp.wallet === seed.wallet);
    const reg = regMap.get(seed.wallet);
    result.push({
      ...seed,
      specJson: reg?.specJson,
      specHash: reg?.specHash || chain?.specHashHex,
      priceLamports: String(reg?.priceLamports || "10000000"),
      hostedProxy: true,
      hasRegistryMetadata: true,
      chainState: chain,
    });
  }

  for (const chain of onChainProviders) {
    if (seen.has(chain.wallet)) continue;
    seen.add(chain.wallet);
    const reg = regMap.get(chain.wallet);
    const seeded = seededMap.get(chain.wallet);
    result.push({
      name: reg?.name || seeded?.name || `Community Provider (${chain.wallet.slice(0, 6)}…)`,
      endpoint: reg
        ? resolveEndpointUrl(reg.endpointUrl, chain.wallet)
        : `${PROVIDER_API_URL}/providers/hosted/${chain.wallet}`,
      wallet: chain.wallet,
      description:
        reg?.description ||
        "On-chain registered provider (metadata pending in public registry).",
      badge: reg?.badge || "community",
      specJson: reg?.specJson,
      specHash: reg?.specHash || chain.specHashHex,
      hostedProxy: Boolean(reg?.hostedProxy),
      hasRegistryMetadata: Boolean(reg),
      priceLamports: String(reg?.priceLamports || "10000000"),
      chainState: chain,
    });
  }

  return result;
}

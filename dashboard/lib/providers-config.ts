/**
 * Known Devnet provider configurations for the interactive playground.
 */
export interface ProviderConfig {
  name: string;
  endpoint: string;
  wallet: string;
  description: string;
  badge: "honest" | "lying" | "subtle";
}

const PROVIDER_API_URL =
  process.env.NEXT_PUBLIC_PROVIDER_API_URL || "http://127.0.0.1:3402";

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

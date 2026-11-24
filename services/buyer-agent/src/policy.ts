import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { getProviderTrust, ProviderTrust } from "@justice402/anchor-client";

export interface SpendPolicy {
  minBondMultiplier: number; // K (e.g. 3 => bond must be >= 3 * price)
  maxLossRate: number;        // e.g. 0.5 => losses / (wins + losses) <= 0.5
}

export const DEFAULT_POLICY: SpendPolicy = {
  minBondMultiplier: 3,
  maxLossRate: 0.5,
};

export interface TrustCheckResult {
  allowed: boolean;
  reason?: string;
  trust?: ProviderTrust;
}

export async function checkProviderTrust(
  program: any,
  providerWallet: PublicKey,
  price: BN | number,
  policy: SpendPolicy = DEFAULT_POLICY
): Promise<TrustCheckResult> {
  const trust = await getProviderTrust(program, providerWallet);
  const priceBN = new BN(price.toString());
  const minRequiredBond = priceBN.muln(policy.minBondMultiplier);

  // 1. Bond check: bond >= K * price
  if (trust.bond.lt(minRequiredBond)) {
    return {
      allowed: false,
      reason: `Provider bond (${trust.bond.toString()}) is less than required ${policy.minBondMultiplier}x price (${minRequiredBond.toString()})`,
      trust,
    };
  }

  // 2. Track record loss rate check
  const totalRulings = trust.wins.add(trust.losses);
  if (!totalRulings.isZero()) {
    const losses = trust.losses.toNumber();
    const total = totalRulings.toNumber();
    const lossRate = losses / total;
    if (lossRate > policy.maxLossRate) {
      return {
        allowed: false,
        reason: `Provider loss rate (${(lossRate * 100).toFixed(1)}%) exceeds maximum allowed threshold (${(policy.maxLossRate * 100).toFixed(1)}%)`,
        trust,
      };
    }
  }

  return { allowed: true, trust };
}


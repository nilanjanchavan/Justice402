import { Connection, PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey("D8uK7oT6f1pcZzK2Dq1NhL7wdNp51sS5ZhuNy4wf8WYD");
export const CONFIG_PDA = new PublicKey("HNzoeY5QFZSFhdB1eZ3PLFHRqfxgNxEFmc56CWN3WEG");
export const MIN_INSURED_BOND_LAMPORTS = 10_000_000n;
export const MIN_INSURED_BOND_SOL = Number(MIN_INSURED_BOND_LAMPORTS) / 1_000_000_000;

export interface OnChainProvider {
  pda: string;
  wallet: string;
  bondLamports: bigint;
  lockedLamports: bigint;
  bondSol: number;
  lockedSol: number;
  withdrawRequestedAt: number;
  specHashHex: string;
  openDisputes: number;
  disputesBuyerWon: number;
  disputesProviderWon: number;
  disputesTimedOut: number;
  totalSlashedSol: number;
}

export interface OnChainDispute {
  pda: string;
  receiptHashHex: string;
  buyer: string;
  provider: string;
  specHashHex: string;
  priceSol: number;
  claimAmountSol: number;
  depositAmountSol: number;
  status: "Open" | "BuyerWins" | "ProviderWins" | "TimedOut";
  openedAt: number;
  evidenceHashHex: string;
}

export interface OnChainConfig {
  arbiter: string;
  usdcMint: string;
  disputeWindowSec: number;
  resolveTimeoutSec: number;
  withdrawDelaySec: number;
  perRulingPayoutCapSol: number;
  disputeDepositSol: number;
}

export function availableBondLamports(
  p: Pick<OnChainProvider, "bondLamports" | "lockedLamports">
): bigint {
  return p.bondLamports > p.lockedLamports ? p.bondLamports - p.lockedLamports : 0n;
}

export function availableBondSol(
  p: Pick<OnChainProvider, "bondLamports" | "lockedLamports">
): number {
  return Number(availableBondLamports(p)) / 1_000_000_000;
}

export function isProviderInsured(
  p: Pick<OnChainProvider, "bondLamports" | "lockedLamports">,
  minRequiredLamports: bigint = MIN_INSURED_BOND_LAMPORTS
): boolean {
  return availableBondLamports(p) >= minRequiredLamports;
}

function readU64BigInt(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset + offset, 8);
  return view.getBigUint64(0, true);
}

function readU64LE(data: Uint8Array, offset: number): number {
  const view = new DataView(data.buffer, data.byteOffset + offset, 8);
  const lo = view.getUint32(0, true);
  const hi = view.getUint32(4, true);
  return hi * 4294967296 + lo;
}

function readI64LE(data: Uint8Array, offset: number): number {
  const view = new DataView(data.buffer, data.byteOffset + offset, 8);
  const val = view.getBigInt64(0, true);
  return Number(val);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const DISPUTE_STATUSES: Array<"Open" | "BuyerWins" | "ProviderWins" | "TimedOut"> = [
  "Open",
  "BuyerWins",
  "ProviderWins",
  "TimedOut",
];

export async function fetchOnChainState(rpcUrl: string): Promise<{
  providers: OnChainProvider[];
  disputes: OnChainDispute[];
  config: OnChainConfig | null;
}> {
  const connection = new Connection(rpcUrl, "confirmed");
  const [configPda] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("config")],
    PROGRAM_ID
  );

  const [providerAccounts, disputeAccounts, configInfo] = await Promise.all([
    connection.getProgramAccounts(PROGRAM_ID, {
      filters: [{ dataSize: 137 }],
    }),
    connection.getProgramAccounts(PROGRAM_ID, {
      filters: [{ dataSize: 234 }],
    }),
    connection.getAccountInfo(configPda).catch(() => null),
  ]);

  const providers: OnChainProvider[] = providerAccounts.map(({ pubkey, account }) => {
    const d = account.data;
    const bondLamports = readU64BigInt(d, 40);
    const lockedLamports = readU64BigInt(d, 48);
    return {
      pda: pubkey.toBase58(),
      wallet: new PublicKey(d.subarray(8, 40)).toBase58(),
      bondLamports,
      lockedLamports,
      bondSol: Number(bondLamports) / 1_000_000_000,
      lockedSol: Number(lockedLamports) / 1_000_000_000,
      withdrawRequestedAt: readI64LE(d, 56),
      specHashHex: toHex(d.subarray(64, 96)),
      openDisputes: readU64LE(d, 96),
      disputesBuyerWon: readU64LE(d, 104),
      disputesProviderWon: readU64LE(d, 112),
      disputesTimedOut: readU64LE(d, 120),
      totalSlashedSol: readU64LE(d, 128) / 1_000_000_000,
    };
  });

  const disputes: OnChainDispute[] = disputeAccounts
    .map(({ pubkey, account }) => {
      const d = account.data;
      const statusIdx = d[160] ?? 0;
      return {
        pda: pubkey.toBase58(),
        receiptHashHex: toHex(d.subarray(8, 40)),
        buyer: new PublicKey(d.subarray(40, 72)).toBase58(),
        provider: new PublicKey(d.subarray(72, 104)).toBase58(),
        specHashHex: toHex(d.subarray(104, 136)),
        priceSol: readU64LE(d, 136) / 1_000_000_000,
        claimAmountSol: readU64LE(d, 144) / 1_000_000_000,
        depositAmountSol: readU64LE(d, 152) / 1_000_000_000,
        status: DISPUTE_STATUSES[statusIdx] || "Open",
        openedAt: readI64LE(d, 161),
        evidenceHashHex: toHex(d.subarray(169, 201)),
      };
    })
    .sort((a, b) => b.openedAt - a.openedAt);

  let config: OnChainConfig | null = null;
  if (configInfo && configInfo.data.length >= 112) {
    const d = configInfo.data;
    config = {
      arbiter: new PublicKey(d.subarray(8, 40)).toBase58(),
      usdcMint: new PublicKey(d.subarray(40, 72)).toBase58(),
      disputeWindowSec: readI64LE(d, 72),
      resolveTimeoutSec: readI64LE(d, 80),
      withdrawDelaySec: readI64LE(d, 88),
      perRulingPayoutCapSol: readU64LE(d, 96) / 1_000_000_000,
      disputeDepositSol: readU64LE(d, 104) / 1_000_000_000,
    };
  }

  return { providers, disputes, config };
}

import { Connection, PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey("2kqYmJMLeSUQ9pgwpJuewNhjr4CMkw3dE9phTpFKNJoJ");

export interface OnChainProvider {
  pda: string;
  wallet: string;
  bondUsdc: number;
  lockedUsdc: number;
  withdrawRequestedAt: number;
  specHashHex: string;
  openDisputes: number;
  disputesBuyerWon: number;
  disputesProviderWon: number;
  disputesTimedOut: number;
  totalSlashedUsdc: number;
}

export interface OnChainDispute {
  pda: string;
  receiptHashHex: string;
  buyer: string;
  provider: string;
  specHashHex: string;
  priceUsdc: number;
  claimAmountUsdc: number;
  depositAmountUsdc: number;
  status: "Open" | "BuyerWins" | "ProviderWins" | "TimedOut";
  openedAt: number;
  evidenceHashHex: string;
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
}> {
  const connection = new Connection(rpcUrl, "confirmed");

  const [providerAccounts, disputeAccounts] = await Promise.all([
    connection.getProgramAccounts(PROGRAM_ID, {
      filters: [{ dataSize: 137 }],
    }),
    connection.getProgramAccounts(PROGRAM_ID, {
      filters: [{ dataSize: 234 }],
    }),
  ]);

  const providers: OnChainProvider[] = providerAccounts.map(({ pubkey, account }) => {
    const d = account.data;
    return {
      pda: pubkey.toBase58(),
      wallet: new PublicKey(d.subarray(8, 40)).toBase58(),
      bondUsdc: readU64LE(d, 40) / 1_000_000,
      lockedUsdc: readU64LE(d, 48) / 1_000_000,
      withdrawRequestedAt: readI64LE(d, 56),
      specHashHex: toHex(d.subarray(64, 96)),
      openDisputes: readU64LE(d, 96),
      disputesBuyerWon: readU64LE(d, 104),
      disputesProviderWon: readU64LE(d, 112),
      disputesTimedOut: readU64LE(d, 120),
      totalSlashedUsdc: readU64LE(d, 128) / 1_000_000,
    };
  });

  const disputes: OnChainDispute[] = disputeAccounts.map(({ pubkey, account }) => {
    const d = account.data;
    const statusIdx = d[160] ?? 0;
    return {
      pda: pubkey.toBase58(),
      receiptHashHex: toHex(d.subarray(8, 40)),
      buyer: new PublicKey(d.subarray(40, 72)).toBase58(),
      provider: new PublicKey(d.subarray(72, 104)).toBase58(),
      specHashHex: toHex(d.subarray(104, 136)),
      priceUsdc: readU64LE(d, 136) / 1_000_000,
      claimAmountUsdc: readU64LE(d, 144) / 1_000_000,
      depositAmountUsdc: readU64LE(d, 152) / 1_000_000,
      status: DISPUTE_STATUSES[statusIdx] || "Open",
      openedAt: readI64LE(d, 161),
      evidenceHashHex: toHex(d.subarray(169, 201)),
    };
  });

  return { providers, disputes };
}


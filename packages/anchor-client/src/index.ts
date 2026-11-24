import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export * from "./receipt";

export interface ProviderTrust {
  wallet: PublicKey;
  bond: BN;
  locked: BN;
  withdrawRequestedAt: BN;
  specHash: Buffer;
  openDisputes: BN;
  wins: BN;
  losses: BN;
  disputesProviderWon: BN;
  disputesBuyerWon: BN;
  totalSlashed: BN;
}

export async function getProviderTrust(
  program: any,
  providerWallet: PublicKey
): Promise<ProviderTrust> {
  const [providerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("provider"), providerWallet.toBuffer()],
    program.programId
  );
  const account = await program.account.provider.fetch(providerPda);
  return {
    wallet: account.wallet,
    bond: account.bond,
    locked: account.locked,
    withdrawRequestedAt: account.withdrawRequestedAt,
    specHash: Buffer.from(account.specHash),
    openDisputes: account.openDisputes,
    wins: account.disputesProviderWon,
    losses: account.disputesBuyerWon,
    disputesProviderWon: account.disputesProviderWon,
    disputesBuyerWon: account.disputesBuyerWon,
    totalSlashed: account.totalSlashed,
  };
}

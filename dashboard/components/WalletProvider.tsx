"use client";

import React, { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";

import "@solana/wallet-adapter-react-ui/styles.css";

// Wallet-adapter packages can ship React 19 @types/react; keep JSX typing compatible with Next 14 (React 18).
const ConnProvider = ConnectionProvider as unknown as React.ComponentType<{
  endpoint: string;
  children: React.ReactNode;
}>;
const WalletsProvider = SolanaWalletProvider as unknown as React.ComponentType<{
  wallets: any[];
  autoConnect?: boolean;
  children: React.ReactNode;
}>;
const ModalProvider = WalletModalProvider as unknown as React.ComponentType<{
  children: React.ReactNode;
}>;

interface Props {
  rpcUrl: string;
  children: React.ReactNode;
}

export default function WalletProvider({ rpcUrl, children }: Props) {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

  return (
    <ConnProvider endpoint={rpcUrl}>
      <WalletsProvider wallets={wallets} autoConnect>
        <ModalProvider>{children}</ModalProvider>
      </WalletsProvider>
    </ConnProvider>
  );
}

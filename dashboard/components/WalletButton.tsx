"use client";

import React, { useCallback, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useToast } from "./Toast";

export default function WalletButton() {
  const { publicKey, disconnect, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const { connection } = useConnection();
  const { toast } = useToast();
  const [airdropping, setAirdropping] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [showMenu, setShowMenu] = useState(false);

  const refreshBalance = useCallback(async () => {
    if (!publicKey) return;
    try {
      const bal = await connection.getBalance(publicKey);
      setBalance(bal / LAMPORTS_PER_SOL);
    } catch {
      setBalance(null);
    }
  }, [publicKey, connection]);

  React.useEffect(() => {
    if (publicKey) {
      refreshBalance();
      const id = setInterval(refreshBalance, 15000);
      return () => clearInterval(id);
    } else {
      setBalance(null);
    }
  }, [publicKey, refreshBalance]);

  const handleAirdrop = useCallback(async () => {
    if (!publicKey || airdropping) return;
    setAirdropping(true);
    try {
      const sig = await connection.requestAirdrop(publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      await refreshBalance();
      toast({
        type: "success",
        text: "Airdropped 1.00 Devnet SOL",
        link: {
          label: "Explorer",
          href: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
        },
      });
    } catch (err: any) {
      const msg = err?.message || "Airdrop failed";
      const isRateLimit = msg.includes("429") || msg.toLowerCase().includes("airdrop");
      toast({
        type: "warning",
        text: isRateLimit
          ? "Devnet public faucet rate-limited. Claim free SOL at faucet.solana.com"
          : `Airdrop error: ${msg}`,
        link: { label: "faucet.solana.com", href: "https://faucet.solana.com" },
      });
    } finally {
      setAirdropping(false);
    }
  }, [publicKey, connection, airdropping, refreshBalance, toast]);

  if (!connected || !publicKey) {
    return (
      <button
        type="button"
        onClick={() => setVisible(true)}
        className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
      >
        Connect Wallet
      </button>
    );
  }

  const addr = publicKey.toBase58();
  const lowBalance = balance !== null && balance < 0.05;

  return (
    <div className="relative inline-flex items-center gap-1.5">
      {lowBalance && (
        <button
          type="button"
          onClick={handleAirdrop}
          disabled={airdropping}
          className="px-2.5 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-200 text-xs font-mono transition-colors disabled:opacity-50"
          title="Wallet balance low — request 1 Devnet SOL"
        >
          {airdropping ? "Airdropping…" : "+ 1 SOL"}
        </button>
      )}

      <button
        type="button"
        onClick={() => setShowMenu(!showMenu)}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-900 border border-white/10 hover:bg-zinc-800 text-xs font-mono text-zinc-200 transition-colors"
      >
        <span className="w-2 h-2 rounded-full bg-emerald-400" />
        <span>
          {addr.slice(0, 4)}…{addr.slice(-4)}
        </span>
        {balance !== null && (
          <span className={`tabular-nums ${lowBalance ? "text-amber-300" : "text-zinc-400"}`}>
            {balance.toFixed(3)} SOL
          </span>
        )}
      </button>

      {showMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 bg-zinc-900 border border-white/10 rounded-lg p-2 min-w-[200px] shadow-xl space-y-1">
            <button
              type="button"
              onClick={() => {
                handleAirdrop();
                setShowMenu(false);
              }}
              disabled={airdropping}
              className="w-full text-left px-3 py-2 rounded-md text-xs text-amber-200 hover:bg-white/5 transition-colors disabled:opacity-50"
            >
              {airdropping ? "Requesting…" : "⬇ Airdrop 1 SOL (Devnet)"}
            </button>
            <button
              type="button"
              onClick={() => {
                refreshBalance();
                setShowMenu(false);
              }}
              className="w-full text-left px-3 py-2 rounded-md text-xs text-zinc-300 hover:bg-white/5 transition-colors"
            >
              ↻ Refresh Balance
            </button>
            <button
              type="button"
              onClick={() => {
                disconnect();
                setShowMenu(false);
              }}
              className="w-full text-left px-3 py-2 rounded-md text-xs text-rose-300 hover:bg-white/5 transition-colors"
            >
              Disconnect
            </button>
          </div>
        </>
      )}
    </div>
  );
}

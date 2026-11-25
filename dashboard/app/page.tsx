"use client";

import React, { useState, useEffect, useCallback } from "react";
import fallbackRunData from "../data/demo-run-fallback.json";
import {
  fetchOnChainState,
  OnChainDispute,
  OnChainProvider,
  PROGRAM_ID,
} from "../lib/solana";

interface StepRecord {
  step: number;
  title: string;
  status: string;
  description: string;
  txSignature?: string;
  explorerUrl?: string;
  details?: any;
}

interface ProviderHealth {
  status: string;
  provider?: string;
  specHash?: string;
  uptime?: number;
  network?: string;
}

const DEFAULT_RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
const DEFAULT_PROVIDER_URL =
  process.env.NEXT_PUBLIC_PROVIDER_API_URL || "http://127.0.0.1:3402";

export default function DashboardPage() {
  const [activeTab, setActiveTab] = useState<
    "timeline" | "providers" | "disputes" | "architecture"
  >("timeline");
  const [demoData, setDemoData] = useState<any>(fallbackRunData);
  const [isUsingFallback, setIsUsingFallback] = useState<boolean>(true);

  const [rpcUrl, setRpcUrl] = useState<string>(DEFAULT_RPC_URL);
  const [onChainProviders, setOnChainProviders] = useState<OnChainProvider[]>([]);
  const [onChainDisputes, setOnChainDisputes] = useState<OnChainDispute[]>([]);
  const [chainLoading, setChainLoading] = useState<boolean>(false);
  const [chainError, setChainError] = useState<string | null>(null);
  const [providerHealth, setProviderHealth] = useState<ProviderHealth | null>(null);

  const isLocalhostRpc =
    rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost");

  const loadLiveState = useCallback(async (targetRpc: string) => {
    setChainLoading(true);
    setChainError(null);
    try {
      const { providers, disputes } = await fetchOnChainState(targetRpc);
      setOnChainProviders(providers);
      setOnChainDisputes(disputes);
    } catch (err: any) {
      setChainError(err?.message || "Unable to reach Solana RPC");
      setOnChainProviders([]);
      setOnChainDisputes([]);
    } finally {
      setChainLoading(false);
    }
  }, []);

  useEffect(() => {
    let initialRpc = DEFAULT_RPC_URL;
    if (
      typeof window !== "undefined" &&
      !process.env.NEXT_PUBLIC_SOLANA_RPC_URL &&
      (window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1")
    ) {
      initialRpc = "http://127.0.0.1:8899";
      setRpcUrl(initialRpc);
    }

    fetch("/demo-run.json")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && data.steps && data.isSample !== true) {
          setDemoData(data);
          setIsUsingFallback(false);
        }
      })
      .catch(() => {});

    fetch(`${DEFAULT_PROVIDER_URL}/health`)
      .then((res) => (res.ok ? res.json() : null))
      .then((h) => {
        if (h && h.status === "ok") setProviderHealth(h);
      })
      .catch(() => setProviderHealth(null));

    loadLiveState(initialRpc);
  }, [loadLiveState]);

  const handleClusterSwitch = (nextRpc: string) => {
    setRpcUrl(nextRpc);
    loadLiveState(nextRpc);
  };

  const programIdStr = demoData.programId || PROGRAM_ID.toBase58();
  const hasLiveProviders = onChainProviders.length > 0;
  const hasLiveDisputes = onChainDisputes.length > 0;

  const totalStakedUsdc = hasLiveProviders
    ? onChainProviders.reduce((acc, p) => acc + p.bondUsdc, 0)
    : 195.0;
  const totalSlashedUsdc = hasLiveProviders
    ? onChainProviders.reduce((acc, p) => acc + p.totalSlashedUsdc, 0)
    : 5.0;
  const providerCount = hasLiveProviders ? onChainProviders.length : 2;
  const disputeCount = hasLiveDisputes ? onChainDisputes.length : 1;

  const explorerTxUrl = (sig: string, explicitUrl?: string) => {
    if (isLocalhostRpc) {
      return `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent("http://127.0.0.1:8899")}`;
    }
    return explicitUrl || `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
  };

  return (
    <main className="max-w-6xl mx-auto px-4 py-8 sm:px-6 lg:px-8">
      {/* Header */}
      <header className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-5 pb-7 mb-7 border-b border-white/[0.08]">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-white">
              Justice<span className="text-emerald-400">402</span>
            </h1>
            <span className="text-[11px] font-mono uppercase tracking-wider bg-emerald-500/10 text-emerald-300 px-2.5 py-1 rounded-full border border-emerald-500/25">
              v1.0 • {isLocalhostRpc ? "Localnet" : "Devnet"}
            </span>
          </div>
          <p className="text-sm text-zinc-400 mt-1.5 max-w-xl leading-relaxed">
            On-chain insurance for HTTP x402 API payments on Solana. Instant settlement, staked USDC bonds, and cryptographic receipts.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
          {/* Cluster Switcher */}
          <div className="flex items-center bg-zinc-900/80 border border-white/[0.08] rounded-xl p-1">
            <button
              onClick={() => handleClusterSwitch("http://127.0.0.1:8899")}
              className={`px-3 py-1.5 rounded-lg transition-all ${
                isLocalhostRpc
                  ? "bg-emerald-500/15 text-emerald-300 font-medium shadow-sm"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              Localhost
            </button>
            <button
              onClick={() => handleClusterSwitch("https://api.devnet.solana.com")}
              className={`px-3 py-1.5 rounded-lg transition-all ${
                !isLocalhostRpc
                  ? "bg-emerald-500/15 text-emerald-300 font-medium shadow-sm"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              Devnet
            </button>
          </div>

          <a
            href={`https://explorer.solana.com/address/${programIdStr}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
            className="bg-zinc-900/80 hover:bg-zinc-800/80 border border-white/[0.08] px-3 py-2 rounded-xl text-zinc-300 transition-colors"
          >
            <span className="text-zinc-500">Program:</span>{" "}
            <span className="text-emerald-400">
              {programIdStr.slice(0, 5)}...{programIdStr.slice(-4)}
            </span>
          </a>

          <div
            className={`px-3 py-2 rounded-xl flex items-center gap-2 border ${
              providerHealth
                ? "bg-emerald-950/40 border-emerald-500/25 text-emerald-300"
                : "bg-zinc-900/80 border-white/[0.08] text-zinc-400"
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                providerHealth ? "bg-emerald-400 animate-pulse" : "bg-zinc-500"
              }`}
            ></span>
            <span>{providerHealth ? "Provider API Online" : "Provider API Offline"}</span>
          </div>

          <button
            onClick={() => loadLiveState(rpcUrl)}
            className="bg-zinc-900/80 hover:bg-zinc-800 border border-white/[0.08] text-zinc-200 px-3 py-2 rounded-xl transition-colors"
            title="Refresh on-chain accounts"
          >
            {chainLoading ? "Syncing..." : "↻ Refresh"}
          </button>
        </div>
      </header>

      {/* KPI Metric Strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3.5 mb-8">
        <div className="bg-zinc-900/50 backdrop-blur-md border border-white/[0.07] rounded-2xl p-4">
          <span className="text-xs font-medium text-zinc-400 block mb-1">
            Total Bond Staked
          </span>
          <span className="font-display text-2xl font-bold text-white tabular-nums">
            {totalStakedUsdc.toFixed(2)}{" "}
            <span className="text-xs font-mono font-normal text-emerald-400">USDC</span>
          </span>
        </div>
        <div className="bg-zinc-900/50 backdrop-blur-md border border-white/[0.07] rounded-2xl p-4">
          <span className="text-xs font-medium text-zinc-400 block mb-1">
            Registered Providers
          </span>
          <span className="font-display text-2xl font-bold text-white tabular-nums">
            {providerCount}{" "}
            <span className="text-xs font-mono font-normal text-zinc-500">
              {hasLiveProviders ? "on-chain" : "sample"}
            </span>
          </span>
        </div>
        <div className="bg-zinc-900/50 backdrop-blur-md border border-white/[0.07] rounded-2xl p-4">
          <span className="text-xs font-medium text-zinc-400 block mb-1">
            Disputes Tracked
          </span>
          <span className="font-display text-2xl font-bold text-white tabular-nums">
            {disputeCount}{" "}
            <span className="text-xs font-mono font-normal text-zinc-500">
              {hasLiveDisputes ? "on-chain" : "sample"}
            </span>
          </span>
        </div>
        <div className="bg-zinc-900/50 backdrop-blur-md border border-white/[0.07] rounded-2xl p-4">
          <span className="text-xs font-medium text-zinc-400 block mb-1">
            Total Bond Slashed
          </span>
          <span className="font-display text-2xl font-bold text-rose-400 tabular-nums">
            {totalSlashedUsdc.toFixed(2)}{" "}
            <span className="text-xs font-mono font-normal text-rose-300/70">USDC</span>
          </span>
        </div>
      </section>

      {chainError && (
        <div className="mb-6 bg-amber-950/30 border border-amber-500/25 text-amber-200 px-4 py-3 rounded-xl text-xs font-mono">
          RPC notice ({rpcUrl}): {chainError}. Displaying sample fallback data where live state is unavailable.
        </div>
      )}

      {/* Navigation Tabs */}
      <nav className="inline-flex flex-wrap gap-1.5 bg-zinc-900/70 border border-white/[0.07] rounded-2xl p-1.5 mb-8">
        {[
          { id: "timeline", label: "Demo Run Timeline" },
          {
            id: "providers",
            label: `Providers (${hasLiveProviders ? onChainProviders.length : "Sample"})`,
          },
          {
            id: "disputes",
            label: `Disputes & Settlement (${hasLiveDisputes ? onChainDisputes.length : "Sample"})`,
          },
          { id: "architecture", label: "Architecture & Trust" },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`px-4 py-2 text-sm font-medium rounded-xl transition-all whitespace-nowrap ${
              activeTab === tab.id
                ? "bg-white text-zinc-950 shadow-sm"
                : "text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* TAB 1: DEMO RUN TIMELINE */}
      {activeTab === "timeline" && (
        <section className="space-y-6">
          <div className="bg-zinc-900/50 backdrop-blur-md border border-white/[0.07] rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-white">
                {demoData.network || "Devnet"} Execution Timeline
              </h2>
              <p className="text-xs sm:text-sm text-zinc-400 mt-0.5">
                {isUsingFallback
                  ? "Sample execution trace illustrating on-chain transaction signatures, Ed25519 introspection proofs, and settlement results."
                  : `Recorded live execution at ${new Date(demoData.executedAt).toLocaleString()} on ${demoData.network}.`}
              </p>
            </div>
            {isUsingFallback ? (
              <span className="text-xs font-mono font-medium uppercase bg-amber-500/10 text-amber-300 border border-amber-500/25 px-3 py-1 rounded-full whitespace-nowrap">
                Sample Data (Pending Devnet Run)
              </span>
            ) : (
              <span className="text-xs font-mono font-medium uppercase bg-emerald-500/10 text-emerald-300 border border-emerald-500/25 px-3 py-1 rounded-full whitespace-nowrap">
                Live Execution Trace
              </span>
            )}
          </div>

          <div className="relative border-l border-white/10 ml-3 sm:ml-5 space-y-6 pb-4">
            {demoData.steps.map((s: StepRecord) => (
              <div key={s.step} className="relative pl-6 sm:pl-8 group">
                <div className="absolute -left-[7px] top-6 w-3.5 h-3.5 rounded-full bg-zinc-950 border-2 border-emerald-400 group-hover:scale-110 transition-transform flex items-center justify-center">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-400"></div>
                </div>

                <div className="bg-zinc-900/60 backdrop-blur-md border border-white/[0.07] rounded-2xl p-5 hover:border-white/[0.15] transition-colors">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2.5">
                      <span className="text-[11px] font-mono font-semibold text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 rounded-full">
                        STEP {s.step}
                      </span>
                      <h3 className="font-display text-base font-semibold text-white">
                        {s.title}
                      </h3>
                    </div>
                    <span className="text-[11px] font-mono px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                      {s.status}
                    </span>
                  </div>

                  <p className="text-sm text-zinc-300 mb-3.5 leading-relaxed">
                    {s.description}
                  </p>

                  {s.details && (
                    <div className="bg-black/40 border border-white/[0.06] rounded-xl p-3.5 text-xs font-mono text-zinc-400 mb-3 overflow-x-auto">
                      <pre className="leading-relaxed">
                        {JSON.stringify(s.details, null, 2)}
                      </pre>
                    </div>
                  )}

                  {s.txSignature && (
                    <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-white/[0.06]">
                      <span className="text-xs text-zinc-500 font-mono">Tx:</span>
                      <a
                        href={explorerTxUrl(s.txSignature, s.explorerUrl)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs font-mono text-emerald-400 hover:text-emerald-300 hover:underline break-all"
                      >
                        {s.txSignature} ↗
                      </a>
                      {isUsingFallback && (
                        <span className="text-[10px] font-mono text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20">
                          SAMPLE DATA
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* TAB 2: LIVE PROVIDERS */}
      {activeTab === "providers" && (
        <section className="space-y-6">
          <div className="bg-zinc-900/50 backdrop-blur-md border border-white/[0.07] rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-lg font-semibold text-white">
                On-Chain Registered Providers
              </h2>
              <p className="text-xs sm:text-sm text-zinc-400 mt-0.5">
                Providers stake USDC bonds in the Solana program and commit to an immutable{" "}
                <code className="font-mono text-zinc-300">spec_hash</code>.
              </p>
            </div>
            <span
              className={`text-xs font-mono font-medium uppercase px-3 py-1 rounded-full border ${
                hasLiveProviders
                  ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/25"
                  : "bg-amber-500/10 text-amber-300 border-amber-500/25"
              }`}
            >
              {hasLiveProviders ? `Live RPC (${onChainProviders.length})` : "Sample Data"}
            </span>
          </div>

          {hasLiveProviders ? (
            <div className="grid grid-cols-1 gap-4">
              {onChainProviders.map((p) => {
                const isSlashed = p.disputesBuyerWon > 0 || p.totalSlashedUsdc > 0;
                const totalResolved = p.disputesBuyerWon + p.disputesProviderWon;
                const lossRate =
                  totalResolved > 0
                    ? Math.round((p.disputesBuyerWon / totalResolved) * 100)
                    : 0;
                return (
                  <div
                    key={p.pda}
                    className="bg-zinc-900/60 backdrop-blur-md border border-white/[0.07] rounded-2xl p-5 hover:border-white/[0.15] transition-colors"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                      <div>
                        <h3 className="font-mono font-medium text-white text-sm">
                          {p.wallet}
                        </h3>
                        <p className="text-xs font-mono text-zinc-500 mt-0.5">
                          PDA: {p.pda}
                        </p>
                      </div>
                      <span
                        className={`text-xs font-mono px-2.5 py-1 rounded-full border ${
                          isSlashed
                            ? "bg-rose-500/10 text-rose-300 border-rose-500/25"
                            : "bg-emerald-500/10 text-emerald-300 border-emerald-500/25"
                        }`}
                      >
                        {isSlashed
                          ? `SLASHED • LOSS RATE ${lossRate}%`
                          : "TRUSTED • 0 LOSSES"}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
                      <div className="bg-black/40 p-3 rounded-xl border border-white/[0.06]">
                        <span className="text-zinc-500 block mb-0.5">Staked Bond</span>
                        <span className="text-white font-semibold text-sm tabular-nums">
                          {p.bondUsdc.toFixed(2)} USDC
                        </span>
                      </div>
                      <div className="bg-black/40 p-3 rounded-xl border border-white/[0.06]">
                        <span className="text-zinc-500 block mb-0.5">Locked / Open</span>
                        <span className="text-zinc-200 font-semibold text-sm tabular-nums">
                          {p.lockedUsdc.toFixed(2)} USDC ({p.openDisputes})
                        </span>
                      </div>
                      <div className="bg-black/40 p-3 rounded-xl border border-white/[0.06]">
                        <span className="text-zinc-500 block mb-0.5">Losses / Slashed</span>
                        <span
                          className={`font-semibold text-sm tabular-nums ${
                            isSlashed ? "text-rose-400" : "text-emerald-400"
                          }`}
                        >
                          {p.disputesBuyerWon} ({p.totalSlashedUsdc.toFixed(2)} USDC)
                        </span>
                      </div>
                      <div className="bg-black/40 p-3 rounded-xl border border-white/[0.06]">
                        <span className="text-zinc-500 block mb-0.5">Spec Hash</span>
                        <span className="text-zinc-300 font-medium truncate block">
                          {p.specHashHex.slice(0, 14)}...
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              <div className="bg-zinc-900/60 backdrop-blur-md border border-white/[0.07] rounded-2xl p-5">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                  <div>
                    <h3 className="font-display font-semibold text-white">
                      Honest Weather Service (Sample)
                    </h3>
                    <p className="text-xs font-mono text-zinc-400">
                      Endpoint: /weather (Passes spec)
                    </p>
                  </div>
                  <span className="text-xs font-mono px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/25">
                    TRUSTED • 100% PASS RATE
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
                  <div className="bg-black/40 p-3 rounded-xl border border-white/[0.06]">
                    <span className="text-zinc-500 block mb-0.5">Staked Bond</span>
                    <span className="text-white font-semibold text-sm">100.00 USDC</span>
                  </div>
                  <div className="bg-black/40 p-3 rounded-xl border border-white/[0.06]">
                    <span className="text-zinc-500 block mb-0.5">Locked</span>
                    <span className="text-zinc-200 font-semibold text-sm">0.00 USDC</span>
                  </div>
                  <div className="bg-black/40 p-3 rounded-xl border border-white/[0.06]">
                    <span className="text-zinc-500 block mb-0.5">Losses / Slashed</span>
                    <span className="text-emerald-400 font-semibold text-sm">0 (0.00 USDC)</span>
                  </div>
                  <div className="bg-black/40 p-3 rounded-xl border border-white/[0.06]">
                    <span className="text-zinc-500 block mb-0.5">Spec Hash</span>
                    <span className="text-zinc-400 font-medium truncate block">098199b4578...</span>
                  </div>
                </div>
              </div>

              <div className="bg-zinc-900/60 backdrop-blur-md border border-white/[0.07] rounded-2xl p-5">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                  <div>
                    <h3 className="font-display font-semibold text-white">
                      Corrupted / Lying Provider (Sample)
                    </h3>
                    <p className="text-xs font-mono text-zinc-400">
                      Endpoint: /weather-lying (Gross range violations)
                    </p>
                  </div>
                  <span className="text-xs font-mono px-2.5 py-1 rounded-full bg-rose-500/10 text-rose-300 border border-rose-500/25">
                    SLASHED • LOSS RATE 100%
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
                  <div className="bg-black/40 p-3 rounded-xl border border-white/[0.06]">
                    <span className="text-zinc-500 block mb-0.5">Remaining Bond</span>
                    <span className="text-white font-semibold text-sm">95.00 USDC</span>
                  </div>
                  <div className="bg-black/40 p-3 rounded-xl border border-white/[0.06]">
                    <span className="text-zinc-500 block mb-0.5">Active Disputes</span>
                    <span className="text-zinc-200 font-semibold text-sm">0 Open</span>
                  </div>
                  <div className="bg-black/40 p-3 rounded-xl border border-white/[0.06]">
                    <span className="text-zinc-500 block mb-0.5">Losses / Slashed</span>
                    <span className="text-rose-400 font-semibold text-sm">1 (5.00 USDC)</span>
                  </div>
                  <div className="bg-black/40 p-3 rounded-xl border border-white/[0.06]">
                    <span className="text-zinc-500 block mb-0.5">Buyer Spend Policy</span>
                    <span className="text-rose-300 font-semibold">REJECTED PRE-FLIGHT</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* TAB 3: DISPUTES & SETTLEMENT */}
      {activeTab === "disputes" && (
        <section className="space-y-6">
          <div className="bg-zinc-900/50 backdrop-blur-md border border-white/[0.07] rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-lg font-semibold text-white">
                On-Chain Disputes Lifecycle
              </h2>
              <p className="text-xs sm:text-sm text-zinc-400 mt-0.5">
                Disputes require a 1 USDC dispute deposit to prevent griefing. Ruled disputes pay out from provider bond.
              </p>
            </div>
            <span
              className={`text-xs font-mono font-medium uppercase px-3 py-1 rounded-full border ${
                hasLiveDisputes
                  ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/25"
                  : "bg-amber-500/10 text-amber-300 border-amber-500/25"
              }`}
            >
              {hasLiveDisputes ? `Live RPC (${onChainDisputes.length})` : "Sample Data"}
            </span>
          </div>

          <div className="overflow-x-auto bg-zinc-900/60 backdrop-blur-md border border-white/[0.07] rounded-2xl">
            <table className="w-full text-left text-xs sm:text-sm font-mono">
              <thead className="bg-black/40 text-zinc-400 border-b border-white/[0.07]">
                <tr>
                  <th className="p-4 font-medium">Dispute PDA</th>
                  <th className="p-4 font-medium">Claim</th>
                  <th className="p-4 font-medium">Deposit</th>
                  <th className="p-4 font-medium">Status</th>
                  <th className="p-4 font-medium">Resolution Payout</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {hasLiveDisputes ? (
                  onChainDisputes.map((d) => (
                    <tr key={d.pda} className="hover:bg-white/[0.02] transition-colors">
                      <td className="p-4 text-emerald-400 font-medium">
                        {d.pda.slice(0, 8)}...{d.pda.slice(-6)}
                      </td>
                      <td className="p-4 tabular-nums">{d.claimAmountUsdc.toFixed(2)} USDC</td>
                      <td className="p-4 tabular-nums">{d.depositAmountUsdc.toFixed(2)} USDC</td>
                      <td className="p-4">
                        <span
                          className={`px-2.5 py-0.5 rounded-full text-xs border ${
                            d.status === "BuyerWins"
                              ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/25"
                              : d.status === "Open"
                              ? "bg-amber-500/10 text-amber-300 border-amber-500/25"
                              : "bg-zinc-800 text-zinc-300 border-white/10"
                          }`}
                        >
                          {d.status}
                        </span>
                      </td>
                      <td className="p-4 text-white font-semibold tabular-nums">
                        {d.status === "BuyerWins" || d.status === "TimedOut"
                          ? `${(d.claimAmountUsdc + d.depositAmountUsdc).toFixed(2)} USDC (Claim + Deposit)`
                          : d.status === "Open"
                          ? "Pending Arbiter"
                          : "0.00 USDC (Deposit Forfeited)"}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="p-4 text-emerald-400 font-medium">
                      8vKYbW2Qo...jf98M (Sample)
                    </td>
                    <td className="p-4">5.00 USDC</td>
                    <td className="p-4">1.00 USDC</td>
                    <td className="p-4">
                      <span className="bg-emerald-500/10 text-emerald-300 border border-emerald-500/25 px-2.5 py-0.5 rounded-full text-xs">
                        BuyerWins
                      </span>
                    </td>
                    <td className="p-4 text-white font-semibold">
                      6.00 USDC (Claim + Deposit)
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* TAB 4: ARCHITECTURE & TRUST */}
      {activeTab === "architecture" && (
        <section className="space-y-6 text-sm text-zinc-300">
          <div className="bg-zinc-900/60 backdrop-blur-md border border-white/[0.07] rounded-2xl p-6 space-y-5">
            <h2 className="font-display text-xl font-bold text-white">
              Why Justice402 is Insurance, Not Escrow
            </h2>
            <p className="leading-relaxed text-zinc-300">
              In traditional API escrow schemes, funds are locked during HTTP execution, introducing latency, third-party
              custody, and custom payment protocols. Justice402 preserves standard, instant x402 V2 settlement. Buyers pay
              directly; providers back their service promises with an on-chain bond staked on Solana.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
              <div className="bg-black/40 p-4 rounded-xl border border-white/[0.06]">
                <h3 className="font-display font-semibold text-emerald-400 mb-1.5">
                  Provider-Signed Receipts
                </h3>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Canonical 249-byte receipts signed via Ed25519 commit to the request, response, price, spec hash, and timestamp.
                </p>
              </div>
              <div className="bg-black/40 p-4 rounded-xl border border-white/[0.06]">
                <h3 className="font-display font-semibold text-emerald-400 mb-1.5">
                  Deterministic Spec Audits
                </h3>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Off-chain JSON Schema, numerical bounds, and freshness rules are verified against the on-chain{" "}
                  <code className="font-mono text-zinc-300">spec_hash</code>.
                </p>
              </div>
              <div className="bg-black/40 p-4 rounded-xl border border-white/[0.06]">
                <h3 className="font-display font-semibold text-emerald-400 mb-1.5">
                  Trusted Human Arbiter
                </h3>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  The human arbiter wallet audits evidence before signing. Liveness is covered by permissionless timeouts.
                </p>
              </div>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}

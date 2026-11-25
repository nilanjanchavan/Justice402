"use client";

import React, { useState, useEffect, useCallback, useId } from "react";
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
  details?: Record<string, any>;
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

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(value).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="text-[11px] font-mono px-2 py-0.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06] transition-colors"
      aria-label={`Copy ${label || "value"}`}
    >
      {copied ? "✓ Copied" : "Copy"}
    </button>
  );
}

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

  const tableCaptionId = useId();
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

  const programIdStr = PROGRAM_ID.toBase58();
  const hasLiveProviders = onChainProviders.length > 0;
  const hasLiveDisputes = onChainDisputes.length > 0;

  const totalStakedSol = hasLiveProviders
    ? onChainProviders.reduce((acc, p) => acc + p.bondSol, 0)
    : 0.15;
  const totalSlashedSol = hasLiveProviders
    ? onChainProviders.reduce((acc, p) => acc + p.totalSlashedSol, 0)
    : 0.01;
  const providerCount = hasLiveProviders ? onChainProviders.length : 2;
  const disputeCount = hasLiveDisputes ? onChainDisputes.length : 1;

  const explorerTxUrl = (sig: string, explicitUrl?: string) => {
    if (isLocalhostRpc) {
      return `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent("http://127.0.0.1:8899")}`;
    }
    return explicitUrl || `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
  };

  const tabs = [
    { id: "timeline", label: "Execution Timeline" },
    {
      id: "providers",
      label: `Providers (${hasLiveProviders ? onChainProviders.length : "Sample"})`,
    },
    {
      id: "disputes",
      label: `Disputes (${hasLiveDisputes ? onChainDisputes.length : "Sample"})`,
    },
    { id: "architecture", label: "Architecture" },
  ] as const;

  return (
    <div className="w-full min-h-screen flex flex-col">
      {/* Full-Width Top Navigation Bar */}
      <header className="w-full border-b border-white/10 px-6 lg:px-10 py-5 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="flex flex-col sm:flex-row sm:items-baseline gap-2 sm:gap-4">
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-white">
            Justice<span className="text-emerald-400">402</span>
          </h1>
          <span className="text-xs font-mono text-zinc-400">
            v1.0 · {isLocalhostRpc ? "Localnet" : "Devnet"} · Bonded x402 Payment Insurance
          </span>
        </div>

        {/* Utility Controls */}
        <div className="flex flex-wrap items-center gap-3 text-xs font-mono text-zinc-300">
          <div className="inline-flex items-center bg-zinc-900 border border-white/10 rounded-lg p-0.5">
            <button
              type="button"
              onClick={() => handleClusterSwitch("http://127.0.0.1:8899")}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                isLocalhostRpc
                  ? "bg-zinc-800 text-white font-medium"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Localhost
            </button>
            <button
              type="button"
              onClick={() => handleClusterSwitch("https://api.devnet.solana.com")}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                !isLocalhostRpc
                  ? "bg-zinc-800 text-white font-medium"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Devnet
            </button>
          </div>

          <span className="text-zinc-700" aria-hidden="true">|</span>

          <a
            href={`https://explorer.solana.com/address/${programIdStr}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
            className="text-zinc-400 hover:text-emerald-300 transition-colors"
            title={`Program ID: ${programIdStr}`}
          >
            {programIdStr.slice(0, 5)}…{programIdStr.slice(-4)} ↗
          </a>

          <span className="text-zinc-700" aria-hidden="true">|</span>

          <span
            className={`inline-flex items-center gap-1.5 ${
              providerHealth ? "text-emerald-300" : "text-zinc-400"
            }`}
          >
            <span aria-hidden="true">{providerHealth ? "●" : "○"}</span>
            <span>API {providerHealth ? "Online" : "Offline"}</span>
          </span>

          <button
            type="button"
            onClick={() => loadLiveState(rpcUrl)}
            className="ml-1 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-zinc-200 transition-colors"
            title="Refresh on-chain accounts"
          >
            {chainLoading ? "Syncing…" : "↻ Refresh"}
          </button>
        </div>
      </header>

      <main className="w-full flex-1 px-6 lg:px-10 py-6 space-y-6">
        {/* Full-Width Unified KPI Strip */}
        <section
          aria-label="Protocol metrics"
          className="grid grid-cols-2 lg:grid-cols-4 bg-zinc-900/50 border border-white/10 rounded-xl divide-y lg:divide-y-0 lg:divide-x divide-white/10"
        >
          <div className="p-4 sm:p-5">
            <span className="text-xs text-zinc-400 block mb-1">Total Bond Staked</span>
            <span className="font-display text-2xl font-semibold text-white tabular-nums">
              {totalStakedSol.toFixed(4)}{" "}
              <span className="text-xs font-mono font-normal text-zinc-400">SOL</span>
            </span>
          </div>
          <div className="p-4 sm:p-5">
            <span className="text-xs text-zinc-400 block mb-1">Registered Providers</span>
            <span className="font-display text-2xl font-semibold text-white tabular-nums">
              {providerCount}{" "}
              <span className="text-xs font-mono font-normal text-zinc-500">
                {hasLiveProviders ? "on-chain" : "sample"}
              </span>
            </span>
          </div>
          <div className="p-4 sm:p-5">
            <span className="text-xs text-zinc-400 block mb-1">Disputes Tracked</span>
            <span className="font-display text-2xl font-semibold text-white tabular-nums">
              {disputeCount}{" "}
              <span className="text-xs font-mono font-normal text-zinc-500">
                {hasLiveDisputes ? "on-chain" : "sample"}
              </span>
            </span>
          </div>
          <div className="p-4 sm:p-5">
            <span className="text-xs text-zinc-400 block mb-1">Total Bond Slashed</span>
            <span className="font-display text-2xl font-semibold text-rose-300 tabular-nums">
              {totalSlashedSol.toFixed(4)}{" "}
              <span className="text-xs font-mono font-normal text-rose-300/70">SOL</span>
            </span>
          </div>
        </section>

        {chainError && (
          <div
            role="status"
            className="bg-amber-950/30 border border-amber-500/30 text-amber-200 px-4 py-2.5 rounded-lg text-xs font-mono"
          >
            ⚠ RPC notice ({rpcUrl}): {chainError}. Showing sample fallback data.
          </div>
        )}

        {/* Navigation Tabs */}
        <div
          role="tablist"
          aria-label="Justice402 dashboard sections"
          className="flex flex-nowrap overflow-x-auto gap-4 border-b border-white/10"
        >
          {tabs.map((tab) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`tab-${tab.id}`}
                aria-selected={selected}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-none px-2 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                  selected
                    ? "text-white"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* TAB 1: EXECUTION TIMELINE (2-column widescreen layout) */}
        <div
          role="tabpanel"
          aria-labelledby="tab-timeline"
          hidden={activeTab !== "timeline"}
        >
          {activeTab === "timeline" && (
            <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left: Step Trace */}
              <div className="lg:col-span-8 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
                  <p className="text-xs font-mono text-zinc-400">
                    {isUsingFallback
                      ? "Trace source: Sample fallback data (pending live devnet run)"
                      : `Trace source: ${demoData.network} · ${new Date(demoData.executedAt).toLocaleString()}`}
                  </p>
                  <span
                    className={`text-xs font-mono ${
                      isUsingFallback ? "text-amber-300" : "text-emerald-300"
                    }`}
                  >
                    {isUsingFallback ? "⚠ Sample Data" : "✓ Live Trace"}
                  </span>
                </div>

                <div className="divide-y divide-white/10 bg-zinc-900/40 border border-white/10 rounded-xl">
                  {demoData.steps.map((s: StepRecord) => (
                    <div key={s.step} className="p-5 sm:p-6">
                      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1.5">
                        <div className="flex items-baseline gap-3">
                          <span className="font-mono text-xs text-zinc-500">
                            {String(s.step).padStart(2, "0")}
                          </span>
                          <h3 className="font-display text-base font-semibold text-white">
                            {s.title}
                          </h3>
                        </div>
                        <span className="font-mono text-xs text-emerald-300">
                          ✓ {s.status}
                        </span>
                      </div>

                      <p className="text-sm text-zinc-400 mb-4 pl-7 leading-relaxed">
                        {s.description}
                      </p>

                      {s.details && (
                        <dl className="pl-7 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs font-mono mb-3">
                          {Object.entries(s.details).map(([k, v]) => (
                            <div
                              key={k}
                              className="flex items-baseline justify-between gap-3 py-1 border-b border-white/[0.05]"
                            >
                              <dt className="text-zinc-500 shrink-0">{k}</dt>
                              <dd
                                className="text-zinc-200 truncate text-right"
                                title={typeof v === "object" ? JSON.stringify(v) : String(v)}
                              >
                                {typeof v === "object" ? JSON.stringify(v) : String(v)}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      )}

                      {s.txSignature && (
                        <div className="pl-7 flex flex-wrap items-center justify-between gap-2 pt-2">
                          <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                            <span className="text-zinc-500">Tx:</span>
                            <a
                              href={explorerTxUrl(s.txSignature, s.explorerUrl)}
                              target="_blank"
                              rel="noreferrer"
                              className="text-emerald-300 hover:underline break-all"
                            >
                              {s.txSignature.slice(0, 20)}…{s.txSignature.slice(-12)} ↗
                            </a>
                            {isUsingFallback && (
                              <span className="text-[11px] text-amber-300">(Sample)</span>
                            )}
                          </div>
                          <CopyButton value={s.txSignature} label="transaction signature" />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Right: Live Environment & Spec Inspector */}
              <aside className="lg:col-span-4 space-y-4 lg:sticky lg:top-6">
                <div className="bg-zinc-900/50 border border-white/10 rounded-xl p-5 space-y-4">
                  <h2 className="font-display text-sm font-semibold text-white">
                    Cluster & Program State
                  </h2>
                  <dl className="space-y-2.5 text-xs font-mono">
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-zinc-500">RPC Endpoint</dt>
                      <dd className="text-zinc-200 truncate">{rpcUrl}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-zinc-500">Program ID</dt>
                      <dd className="flex items-center gap-1.5 text-zinc-200">
                        <span>{programIdStr.slice(0, 6)}…{programIdStr.slice(-4)}</span>
                        <CopyButton value={programIdStr} label="program ID" />
                      </dd>
                    </div>
                    {demoData.buyer && (
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-zinc-500">Demo Buyer</dt>
                        <dd className="flex items-center gap-1.5 text-zinc-200">
                          <span>{demoData.buyer.slice(0, 6)}…{demoData.buyer.slice(-4)}</span>
                          <CopyButton value={demoData.buyer} label="buyer wallet" />
                        </dd>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-zinc-500">Receipt Format</dt>
                      <dd className="text-zinc-200">249 bytes (Ed25519)</dd>
                    </div>
                  </dl>
                </div>

                <div className="bg-zinc-900/50 border border-white/10 rounded-xl p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <h2 className="font-display text-sm font-semibold text-white">
                      Provider API Health
                    </h2>
                    <span
                      className={`text-xs font-mono ${
                        providerHealth ? "text-emerald-300" : "text-zinc-500"
                      }`}
                    >
                      {providerHealth ? "● Online" : "○ Offline"}
                    </span>
                  </div>
                  {providerHealth ? (
                    <dl className="space-y-2 text-xs font-mono">
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-zinc-500">Endpoint</dt>
                        <dd className="text-zinc-200 truncate">{DEFAULT_PROVIDER_URL}</dd>
                      </div>
                      {providerHealth.provider && (
                        <div className="flex items-center justify-between gap-2">
                          <dt className="text-zinc-500">Signer</dt>
                          <dd className="text-zinc-200">
                            {providerHealth.provider.slice(0, 6)}…{providerHealth.provider.slice(-4)}
                          </dd>
                        </div>
                      )}
                      {providerHealth.specHash && (
                        <div className="flex items-center justify-between gap-2">
                          <dt className="text-zinc-500">Spec Hash</dt>
                          <dd className="text-zinc-300">
                            {providerHealth.specHash.slice(0, 12)}…
                          </dd>
                        </div>
                      )}
                    </dl>
                  ) : (
                    <p className="text-xs text-zinc-500 leading-relaxed">
                      Start the local provider service with{" "}
                      <code className="font-mono text-zinc-300">npm run start:provider</code> to inspect live health and specs.
                    </p>
                  )}
                </div>
              </aside>
            </section>
          )}
        </div>

        {/* TAB 2: PROVIDERS (Full-width multi-column grid) */}
        <div
          role="tabpanel"
          aria-labelledby="tab-providers"
          hidden={activeTab !== "providers"}
        >
          {activeTab === "providers" && (
            <section className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
                <p className="text-xs font-mono text-zinc-400">
                  Registered provider bonds and immutable <code className="text-zinc-200">spec_hash</code> track records
                </p>
                <span
                  className={`text-xs font-mono ${
                    hasLiveProviders ? "text-emerald-300" : "text-amber-300"
                  }`}
                >
                  {hasLiveProviders ? `✓ Live RPC (${onChainProviders.length})` : "⚠ Sample Data"}
                </span>
              </div>

              {hasLiveProviders ? (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  {onChainProviders.map((p) => {
                    const isSlashed = p.disputesBuyerWon > 0 || p.totalSlashedSol > 0;
                    const totalResolved = p.disputesBuyerWon + p.disputesProviderWon;
                    const lossRate =
                      totalResolved > 0
                        ? Math.round((p.disputesBuyerWon / totalResolved) * 100)
                        : 0;
                    return (
                      <div
                        key={p.pda}
                        className="bg-zinc-900/40 border border-white/10 rounded-xl p-5 sm:p-6"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2 mb-4">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="min-w-0">
                              <div className="font-mono text-sm font-medium text-white truncate">
                                {p.wallet}
                              </div>
                              <div className="font-mono text-xs text-zinc-500 mt-0.5 truncate">
                                PDA: {p.pda}
                              </div>
                            </div>
                            <CopyButton value={p.wallet} label="provider wallet" />
                          </div>
                          <span
                            className={`text-xs font-mono shrink-0 ${
                              isSlashed ? "text-rose-300" : "text-emerald-300"
                            }`}
                          >
                            {isSlashed
                              ? `✕ Slashed (${lossRate}% loss)`
                              : "✓ Trusted (0 losses)"}
                          </span>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs font-mono pt-3 border-t border-white/[0.06]">
                          <div>
                            <span className="text-zinc-500 block mb-0.5">Staked Bond</span>
                            <span className="text-white font-medium text-sm tabular-nums">
                              {p.bondSol.toFixed(4)} SOL
                            </span>
                          </div>
                          <div>
                            <span className="text-zinc-500 block mb-0.5">Locked / Open</span>
                            <span className="text-zinc-200 font-medium text-sm tabular-nums">
                              {p.lockedSol.toFixed(4)} SOL ({p.openDisputes})
                            </span>
                          </div>
                          <div>
                            <span className="text-zinc-500 block mb-0.5">Slashed</span>
                            <span
                              className={`font-medium text-sm tabular-nums ${
                                isSlashed ? "text-rose-300" : "text-emerald-300"
                              }`}
                            >
                              {p.disputesBuyerWon} ({p.totalSlashedSol.toFixed(4)} SOL)
                            </span>
                          </div>
                          <div>
                            <span className="text-zinc-500 block mb-0.5">Spec Hash</span>
                            <span className="text-zinc-300 truncate block">
                              {p.specHashHex.slice(0, 12)}…
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <div className="bg-zinc-900/40 border border-white/10 rounded-xl p-5 sm:p-6">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                      <div>
                        <div className="font-display font-semibold text-white">
                          Honest Weather Service (Sample)
                        </div>
                        <div className="font-mono text-xs text-zinc-400">
                          /weather · Spec compliant
                        </div>
                      </div>
                      <span className="text-xs font-mono text-emerald-300">
                        ✓ Trusted (0 losses)
                      </span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs font-mono pt-3 border-t border-white/[0.06]">
                      <div>
                        <span className="text-zinc-500 block mb-0.5">Staked Bond</span>
                        <span className="text-white font-medium text-sm">100.00 USDC</span>
                      </div>
                      <div>
                        <span className="text-zinc-500 block mb-0.5">Locked</span>
                        <span className="text-zinc-200 font-medium text-sm">0.00 USDC</span>
                      </div>
                      <div>
                        <span className="text-zinc-500 block mb-0.5">Slashed</span>
                        <span className="text-emerald-300 font-medium text-sm">0 (0.00 USDC)</span>
                      </div>
                      <div>
                        <span className="text-zinc-500 block mb-0.5">Spec Hash</span>
                        <span className="text-zinc-300 truncate block">098199b4578…</span>
                      </div>
                    </div>
                  </div>

                  <div className="bg-zinc-900/40 border border-white/10 rounded-xl p-5 sm:p-6">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                      <div>
                        <div className="font-display font-semibold text-white">
                          Lying Provider (Sample)
                        </div>
                        <div className="font-mono text-xs text-zinc-400">
                          /weather-lying · Out-of-range responses
                        </div>
                      </div>
                      <span className="text-xs font-mono text-rose-300">
                        ✕ Slashed (100% loss)
                      </span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs font-mono pt-3 border-t border-white/[0.06]">
                      <div>
                        <span className="text-zinc-500 block mb-0.5">Remaining Bond</span>
                        <span className="text-white font-medium text-sm">95.00 USDC</span>
                      </div>
                      <div>
                        <span className="text-zinc-500 block mb-0.5">Active Disputes</span>
                        <span className="text-zinc-200 font-medium text-sm">0 Open</span>
                      </div>
                      <div>
                        <span className="text-zinc-500 block mb-0.5">Slashed</span>
                        <span className="text-rose-300 font-medium text-sm">1 (5.00 USDC)</span>
                      </div>
                      <div>
                        <span className="text-zinc-500 block mb-0.5">Buyer Policy</span>
                        <span className="text-rose-300 font-medium">Rejected</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>

        {/* TAB 3: DISPUTES (Full-width table) */}
        <div
          role="tabpanel"
          aria-labelledby="tab-disputes"
          hidden={activeTab !== "disputes"}
        >
          {activeTab === "disputes" && (
            <section className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
                <p className="text-xs font-mono text-zinc-400">
                  1.00 USDC anti-griefing deposit required per dispute; payouts settle from provider bond
                </p>
                <span
                  className={`text-xs font-mono ${
                    hasLiveDisputes ? "text-emerald-300" : "text-amber-300"
                  }`}
                >
                  {hasLiveDisputes ? `✓ Live RPC (${onChainDisputes.length})` : "⚠ Sample Data"}
                </span>
              </div>

              <div
                tabIndex={0}
                role="region"
                aria-labelledby={tableCaptionId}
                className="table-wrapper bg-zinc-900/40 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-400/50"
              >
                <table className="disputes-table w-full text-left text-xs sm:text-sm font-mono">
                  <caption id={tableCaptionId} className="sr-only">
                    On-chain disputes and settlement payouts
                  </caption>
                  <thead className="bg-zinc-950/90 text-zinc-400 border-b border-white/10">
                    <tr>
                      <th scope="col" className="p-4 font-medium">Dispute PDA</th>
                      <th scope="col" className="p-4 font-medium">Claim</th>
                      <th scope="col" className="p-4 font-medium">Deposit</th>
                      <th scope="col" className="p-4 font-medium">Status</th>
                      <th scope="col" className="p-4 font-medium">Resolution Payout</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {hasLiveDisputes ? (
                      onChainDisputes.map((d) => (
                        <tr key={d.pda} className="hover:bg-white/[0.02] transition-colors">
                          <th scope="row" className="p-4 text-zinc-100 font-medium text-left">
                            <span className="inline-flex items-center gap-2">
                              <span>{d.pda}</span>
                              <CopyButton value={d.pda} label="dispute PDA" />
                            </span>
                          </th>
                          <td className="p-4 tabular-nums text-zinc-300">{d.claimAmountSol.toFixed(4)} SOL</td>
                          <td className="p-4 tabular-nums text-zinc-300">{d.depositAmountSol.toFixed(4)} SOL</td>
                          <td className="p-4">
                            <span
                              className={`text-xs ${
                                d.status === "BuyerWins"
                                  ? "text-emerald-300"
                                  : d.status === "Open"
                                  ? "text-amber-300"
                                  : "text-zinc-300"
                              }`}
                            >
                              {d.status === "BuyerWins"
                                ? "✓ BuyerWins"
                                : d.status === "Open"
                                ? "⧗ Open"
                                : d.status}
                            </span>
                          </td>
                          <td className="p-4 text-white font-medium tabular-nums">
                            {d.status === "BuyerWins" || d.status === "TimedOut"
                              ? `${(d.claimAmountSol + d.depositAmountSol).toFixed(4)} SOL (Claim + Deposit)`
                              : d.status === "Open"
                              ? "Pending Arbiter"
                              : "0.0000 SOL (Deposit Forfeited)"}
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <th scope="row" className="p-4 text-zinc-100 font-medium text-left">
                          8vKYbW2Qo…jf98M (Sample)
                        </th>
                        <td className="p-4 text-zinc-300">5.00 USDC</td>
                        <td className="p-4 text-zinc-300">1.00 USDC</td>
                        <td className="p-4 text-emerald-300">✓ BuyerWins</td>
                        <td className="p-4 text-white font-medium">
                          6.00 USDC (Claim + Deposit)
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>

        {/* TAB 4: ARCHITECTURE */}
        <div
          role="tabpanel"
          aria-labelledby="tab-architecture"
          hidden={activeTab !== "architecture"}
        >
          {activeTab === "architecture" && (
            <section className="bg-zinc-900/40 border border-white/10 rounded-xl p-6 lg:p-8 space-y-6 text-sm text-zinc-300">
              <div>
                <h2 className="font-display text-lg font-semibold text-white mb-2">
                  Why Justice402 is Insurance, Not Escrow
                </h2>
                <p className="leading-relaxed text-zinc-400 max-w-3xl">
                  Traditional API escrow locks funds during HTTP execution, adding latency and custody risk. Justice402 preserves instant x402 V2 settlement: buyers pay directly, and providers back their service guarantees with an on-chain USDC bond.
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-5 border-t border-white/10">
                <div>
                  <h3 className="font-display font-medium text-white mb-1.5">
                    Provider-Signed Receipts
                  </h3>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    249-byte Ed25519 receipts commit to the request, response, price, spec hash, and timestamp.
                  </p>
                </div>
                <div>
                  <h3 className="font-display font-medium text-white mb-1.5">
                    Deterministic Spec Audits
                  </h3>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    JSON Schema, numeric ranges, and freshness rules are checked against the on-chain{" "}
                    <code className="font-mono text-zinc-200">spec_hash</code>.
                  </p>
                </div>
                <div>
                  <h3 className="font-display font-medium text-white mb-1.5">
                    Human Arbiter & Timeout
                  </h3>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    A human arbiter reviews evidence before signing rulings; permissionless timeouts protect buyers if the arbiter stalls.
                  </p>
                </div>
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

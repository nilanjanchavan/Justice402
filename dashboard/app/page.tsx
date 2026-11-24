"use client";

import React, { useState, useEffect } from "react";
import fallbackRunData from "../data/demo-run-fallback.json";

interface StepRecord {
  step: number;
  title: string;
  status: string;
  description: string;
  txSignature?: string;
  explorerUrl?: string;
  details?: any;
}

export default function DashboardPage() {
  const [activeTab, setActiveTab] = useState<"timeline" | "providers" | "disputes" | "architecture">("timeline");
  const [demoData, setDemoData] = useState<any>(fallbackRunData);

  useEffect(() => {
    // Attempt to load latest demo-run.json if served
    fetch("/demo-run.json")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && data.steps) setDemoData(data);
      })
      .catch(() => {});
  }, []);

  const PROGRAM_ID = demoData.programId || "2kqYmJMLeSUQ9pgwpJuewNhjr4CMkw3dE9phTpFKNJoJ";

  return (
    <main className="max-w-6xl mx-auto px-4 py-8 sm:px-6 lg:px-8">
      {/* Header */}
      <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-slate-800 pb-6 mb-8">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white flex items-center gap-2">
              <span className="text-emerald-400">Justice402</span>
              <span className="text-xs font-mono uppercase bg-emerald-500/10 text-emerald-400 px-2.5 py-1 rounded-full border border-emerald-500/20">
                v1.0 Devnet
              </span>
            </h1>
          </div>
          <p className="text-sm text-slate-400 mt-1">
            Insurance for x402 API Payments on Solana — Instant Settlement, Staked Bond, Provider-Signed Receipts.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
          <div className="bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-lg text-slate-300">
            <span className="text-slate-500">Program:</span>{" "}
            <a
              href={`https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`}
              target="_blank"
              rel="noreferrer"
              className="text-emerald-400 hover:underline"
            >
              {PROGRAM_ID.slice(0, 6)}...{PROGRAM_ID.slice(-4)}
            </a>
          </div>
          <div className="bg-emerald-950/60 border border-emerald-800/40 text-emerald-300 px-3 py-1.5 rounded-lg flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
            Solana Devnet
          </div>
        </div>
      </header>

      {/* Navigation Tabs */}
      <nav className="flex space-x-2 border-b border-slate-800 mb-8 pb-1 overflow-x-auto">
        <button
          onClick={() => setActiveTab("timeline")}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
            activeTab === "timeline"
              ? "bg-slate-800 text-white shadow-sm"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
          }`}
        >
          Demo Run Timeline
        </button>
        <button
          onClick={() => setActiveTab("providers")}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
            activeTab === "providers"
              ? "bg-slate-800 text-white shadow-sm"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
          }`}
        >
          Live Providers ({">"}= 3)
        </button>
        <button
          onClick={() => setActiveTab("disputes")}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
            activeTab === "disputes"
              ? "bg-slate-800 text-white shadow-sm"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
          }`}
        >
          Disputes & Settlement
        </button>
        <button
          onClick={() => setActiveTab("architecture")}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
            activeTab === "architecture"
              ? "bg-slate-800 text-white shadow-sm"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
          }`}
        >
          Architecture & Trust
        </button>
      </nav>

      {/* TAB 1: DEMO RUN TIMELINE */}
      {activeTab === "timeline" && (
        <section className="space-y-6">
          <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-5 mb-6">
            <h2 className="text-lg font-bold text-white mb-1">Devnet Execution Timeline</h2>
            <p className="text-xs sm:text-sm text-slate-400">
              Listing real on-chain transaction signatures, Ed25519 introspection proofs, and settlement results.
              Click any transaction to verify on Solana Explorer.
            </p>
          </div>

          <div className="relative border-l-2 border-slate-800 ml-4 sm:ml-6 space-y-8 pb-4">
            {demoData.steps.map((s: StepRecord) => (
              <div key={s.step} className="relative pl-6 sm:pl-8 group">
                {/* Dot */}
                <div className="absolute -left-[9px] top-1.5 w-4 h-4 rounded-full bg-slate-950 border-2 border-emerald-400 group-hover:scale-110 transition-transform flex items-center justify-center">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-400"></div>
                </div>

                <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition-colors">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded">
                        STEP {s.step}
                      </span>
                      <h3 className="text-base font-semibold text-white">{s.title}</h3>
                    </div>
                    <span className="text-xs font-mono px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800/50">
                      {s.status}
                    </span>
                  </div>

                  <p className="text-sm text-slate-300 mb-3">{s.description}</p>

                  {s.details && (
                    <div className="bg-slate-950/70 border border-slate-800/60 rounded-lg p-3 text-xs font-mono text-slate-400 mb-3 overflow-x-auto">
                      <pre>{JSON.stringify(s.details, null, 2)}</pre>
                    </div>
                  )}

                  {s.txSignature && (
                    <div className="flex items-center gap-2 mt-2 pt-2 border-t border-slate-800/60">
                      <span className="text-xs text-slate-500 font-mono">Devnet Tx:</span>
                      <a
                        href={s.explorerUrl || `https://explorer.solana.com/tx/${s.txSignature}?cluster=devnet`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs font-mono text-emerald-400 hover:text-emerald-300 hover:underline break-all flex items-center gap-1"
                      >
                        {s.txSignature} ↗
                      </a>
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
          <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-5 mb-4">
            <h2 className="text-lg font-bold text-white mb-1">On-Chain Registered Providers</h2>
            <p className="text-xs sm:text-sm text-slate-400">
              Providers maintain staked bonds in the Solana program and commit to an immutable `spec_hash`.
              Disputes won and lost update their public track record.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4">
            {/* Provider 1: Honest */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div>
                  <h3 className="font-semibold text-white">Honest Weather Service</h3>
                  <p className="text-xs font-mono text-slate-400">Endpoint: /weather (Passes spec)</p>
                </div>
                <span className="text-xs font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  TRUSTED • 100% PASS RATE
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
                <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800/60">
                  <span className="text-slate-500 block">Staked Bond</span>
                  <span className="text-white font-bold text-sm">100.0 USDC</span>
                </div>
                <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800/60">
                  <span className="text-slate-500 block">Locked</span>
                  <span className="text-slate-300 font-bold text-sm">0.0 USDC</span>
                </div>
                <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800/60">
                  <span className="text-slate-500 block">Losses / Slashed</span>
                  <span className="text-emerald-400 font-bold text-sm">0 (0.0 USDC)</span>
                </div>
                <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800/60">
                  <span className="text-slate-500 block">Spec Hash</span>
                  <span className="text-slate-400 font-bold truncate block">098199b4578...</span>
                </div>
              </div>
            </div>

            {/* Provider 2: Gross Liar */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div>
                  <h3 className="font-semibold text-white">Corrupted / Lying Provider</h3>
                  <p className="text-xs font-mono text-slate-400">Endpoint: /weather-lying (Gross range violations)</p>
                </div>
                <span className="text-xs font-mono px-2 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20">
                  SLASHED • LOSS RATE 100%
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
                <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800/60">
                  <span className="text-slate-500 block">Remaining Bond</span>
                  <span className="text-white font-bold text-sm">95.0 USDC</span>
                </div>
                <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800/60">
                  <span className="text-slate-500 block">Active Disputes</span>
                  <span className="text-slate-300 font-bold text-sm">0 Open</span>
                </div>
                <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800/60">
                  <span className="text-slate-500 block">Losses / Slashed</span>
                  <span className="text-rose-400 font-bold text-sm">1 (5.0 USDC)</span>
                </div>
                <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800/60">
                  <span className="text-slate-500 block">Buyer Spend Policy</span>
                  <span className="text-rose-300 font-bold">REJECTED PRE-FLIGHT</span>
                </div>
              </div>
            </div>

            {/* Provider 3: Plausible-Wrong */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div>
                  <h3 className="font-semibold text-white">Subtle Contradiction Provider</h3>
                  <p className="text-xs font-mono text-slate-400">Endpoint: /weather-plausible-wrong (Contradicts Oracle)</p>
                </div>
                <span className="text-xs font-mono px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  SEMANTIC CONTRADICTION
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
                <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800/60">
                  <span className="text-slate-500 block">Staked Bond</span>
                  <span className="text-white font-bold text-sm">100.0 USDC</span>
                </div>
                <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800/60">
                  <span className="text-slate-500 block">Returned Temp</span>
                  <span className="text-amber-400 font-bold text-sm">38.0°C</span>
                </div>
                <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800/60">
                  <span className="text-slate-500 block">Ground Truth Oracle</span>
                  <span className="text-emerald-400 font-bold text-sm">24.5°C</span>
                </div>
                <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800/60">
                  <span className="text-slate-500 block">Discrepancy</span>
                  <span className="text-rose-400 font-bold">+13.5°C Δ</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* TAB 3: DISPUTES & SETTLEMENT */}
      {activeTab === "disputes" && (
        <section className="space-y-6">
          <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-5 mb-4">
            <h2 className="text-lg font-bold text-white mb-1">On-Chain Disputes Lifecycle</h2>
            <p className="text-xs sm:text-sm text-slate-400">
              Disputes require a 1 USDC dispute deposit to prevent griefing. Ruled disputes pay out from provider bond.
            </p>
          </div>

          <div className="overflow-x-auto bg-slate-900/80 border border-slate-800 rounded-xl">
            <table className="w-full text-left text-xs sm:text-sm font-mono">
              <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="p-3">Dispute PDA</th>
                  <th className="p-3">Claim</th>
                  <th className="p-3">Deposit</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Resolution Payout</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                <tr>
                  <td className="p-3 text-emerald-400 font-bold">8vKYbW2Qo...jf98M</td>
                  <td className="p-3">5.0 USDC</td>
                  <td className="p-3">1.0 USDC</td>
                  <td className="p-3">
                    <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded text-xs">
                      BuyerWins
                    </span>
                  </td>
                  <td className="p-3 text-white font-bold">6.0 USDC (Claim + Deposit)</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* TAB 4: ARCHITECTURE & TRUST */}
      {activeTab === "architecture" && (
        <section className="space-y-6 text-sm text-slate-300">
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 space-y-4">
            <h2 className="text-xl font-bold text-white">Why Justice402 is Insurance, Not Escrow</h2>
            <p>
              In traditional API escrow schemes, funds are locked during HTTP execution, introducing latency, third-party
              custody, and custom payment protocols. Justice402 preserves standard, instant x402 V2 settlement. Buyers pay
              directly; providers back their service promises with an on-chain bond staked on Solana.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4">
              <div className="bg-slate-950 p-4 rounded-lg border border-slate-800">
                <h3 className="font-bold text-emerald-400 mb-1">Provider-Signed Receipts</h3>
                <p className="text-xs text-slate-400">
                  Canonical 249-byte receipts signed via Ed25519 commit to the request, response, price, spec hash, and timestamp.
                </p>
              </div>
              <div className="bg-slate-950 p-4 rounded-lg border border-slate-800">
                <h3 className="font-bold text-emerald-400 mb-1">Deterministic Spec Audits</h3>
                <p className="text-xs text-slate-400">
                  Off-chain JSON Schema, numerical bounds, and freshness rules are verified against on-chain spec_hash.
                </p>
              </div>
              <div className="bg-slate-950 p-4 rounded-lg border border-slate-800">
                <h3 className="font-bold text-emerald-400 mb-1">Trusted Human Arbiter</h3>
                <p className="text-xs text-slate-400">
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

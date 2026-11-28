"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { CONFIG_PDA, OnChainConfig, OnChainDispute } from "../lib/solana";
import { getDisputeEvidence } from "../lib/live-run";
import { useToast } from "./Toast";

const DEFAULT_PROVIDER_URL =
  process.env.NEXT_PUBLIC_PROVIDER_API_URL || "http://127.0.0.1:3402";

interface ArbiterStatusInfo {
  configured: boolean;
  arbiterWallet: string | null;
  portalArbiterWallet: string | null;
  portalWalletConfigured: boolean;
  portalPasswordConfigured: boolean;
  onChainConfigArbiter: string | null;
  onChainConfigMatchesPortal: boolean;
}

export default function ArbiterTab({
  disputes,
  onChainConfig,
  onRefresh,
  onRunUpdate,
  isLocalhostRpc,
}: {
  disputes: OnChainDispute[];
  onChainConfig: OnChainConfig | null;
  onRefresh: () => void;
  onRunUpdate: (runData: any) => void;
  isLocalhostRpc: boolean;
}) {
  const { publicKey, connected, signMessage } = useWallet();
  const { setVisible } = useWalletModal();
  const { toast } = useToast();

  const [password, setPassword] = useState("");
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authExpiresAt, setAuthExpiresAt] = useState<number>(0);
  const [unlocking, setUnlocking] = useState(false);

  const [statusInfo, setStatusInfo] = useState<ArbiterStatusInfo | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [audits, setAudits] = useState<Record<string, any>>({});
  const [auditingPdas, setAuditingPdas] = useState<Set<string>>(() => new Set());
  const [settlingPdas, setSettlingPdas] = useState<Set<string>>(() => new Set());
  const [manualPayloads, setManualPayloads] = useState<Record<string, string>>({});
  const [showResolved, setShowResolved] = useState(false);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  const connectedAddress = publicKey?.toBase58() || "";
  const authorizedArbiter = statusInfo?.portalArbiterWallet || "";
  const isAuthorizedWallet = Boolean(
    authorizedArbiter && connected && connectedAddress === authorizedArbiter
  );

  const fetchBackendStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const res = await fetch(`${DEFAULT_PROVIDER_URL}/arbiter/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatusInfo(data);
    } catch (err: any) {
      setStatusInfo(null);
      setStatusError(err?.message || "Unable to reach arbiter status endpoint");
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBackendStatus();
  }, [fetchBackendStatus]);

  // Shared 1s clock while portal workbench is unlocked so deadlines & button states stay live
  useEffect(() => {
    if (!authToken) return;
    setNowSec(Math.floor(Date.now() / 1000));
    const interval = setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [authToken]);

  // Immediately clear expired/wrong-wallet tokens and schedule timer at authExpiresAt
  useEffect(() => {
    if (!authToken) return;
    const msLeft = authExpiresAt - Date.now();
    if (!isAuthorizedWallet || msLeft <= 0) {
      setAuthToken(null);
      return;
    }
    const timer = setTimeout(() => {
      setAuthToken(null);
    }, msLeft);
    return () => clearTimeout(timer);
  }, [authToken, isAuthorizedWallet, authExpiresAt]);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!connected || !publicKey) {
      setVisible(true);
      return;
    }
    if (!isAuthorizedWallet) {
      toast({
        type: "error",
        text: authorizedArbiter
          ? `Only ${authorizedArbiter} can unlock the Arbiter Portal.`
          : "Arbiter portal wallet is not configured on the backend yet (set ARBITER_PORTAL_WALLET on Render).",
      });
      return;
    }
    if (!signMessage) {
      toast({
        type: "error",
        text: "Connected wallet must support signMessage to prove arbiter ownership.",
      });
      return;
    }

    setUnlocking(true);
    try {
      const chRes = await fetch(
        `${DEFAULT_PROVIDER_URL}/arbiter/challenge?wallet=${encodeURIComponent(connectedAddress)}`
      );
      const chData = await chRes.json();
      if (!chRes.ok || !chData.nonce || !chData.message) {
        throw new Error(chData.error || `Challenge error (${chRes.status})`);
      }

      const msgBytes = new TextEncoder().encode(chData.message);
      const sigBytes = await signMessage(msgBytes);
      const signatureBase64 = btoa(String.fromCharCode(...Array.from(sigBytes)));

      const res = await fetch(`${DEFAULT_PROVIDER_URL}/arbiter/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password,
          walletAddress: connectedAddress,
          nonce: chData.nonce,
          signatureBase64,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Authentication failed (${res.status})`);
      }

      setAuthToken(data.token);
      setAuthExpiresAt(data.expiresAt);
      setPassword("");
      toast({ type: "success", text: "Arbiter Portal unlocked." });
    } catch (err: any) {
      const msg = err?.message || "Failed to authenticate";
      toast({
        type: msg.toLowerCase().includes("user rejected") ? "warning" : "error",
        text: msg,
      });
    } finally {
      setUnlocking(false);
    }
  };

  const handleAuditPreview = async (dispute: OnChainDispute) => {
    setAuditingPdas((prev) => new Set(prev).add(dispute.pda));
    try {
      const cached = getDisputeEvidence(dispute.pda);
      let payload = cached?.responsePayload;
      if (manualPayloads[dispute.pda]?.trim()) {
        payload = JSON.parse(manualPayloads[dispute.pda]);
      }

      const res = await fetch(`${DEFAULT_PROVIDER_URL}/arbiter/audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          disputePda: dispute.pda,
          responsePayload: payload,
          receiptBase64: cached?.receiptBase64,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Audit failed (${res.status})`);

      setAudits((prev) => ({ ...prev, [dispute.pda]: data }));
      if (!data.hasEvidence) {
        toast({
          type: "info",
          text: data.message || "Paste evidence JSON payload to preview deterministic checks.",
        });
      }
    } catch (err: any) {
      toast({ type: "error", text: err?.message || "Audit error" });
    } finally {
      setAuditingPdas((prev) => {
        const next = new Set(prev);
        next.delete(dispute.pda);
        return next;
      });
    }
  };

  const handleSettleDispute = async (
    dispute: OnChainDispute,
    ruling: "BuyerWins" | "ProviderWins"
  ) => {
    const requestToken = authToken;
    if (!requestToken || !isAuthorizedWallet || Date.now() >= authExpiresAt) {
      setAuthToken(null);
      toast({ type: "error", text: "Arbiter session expired or missing. Unlock again." });
      return;
    }

    const resolveTimeout = onChainConfig?.resolveTimeoutSec || 180;
    const deadline = dispute.openedAt + resolveTimeout;
    if (Math.floor(Date.now() / 1000) >= deadline) {
      toast({
        type: "warning",
        text: "Resolve timeout elapsed for this dispute — use Claim Timeout Refund instead.",
      });
      return;
    }

    setSettlingPdas((prev) => new Set(prev).add(dispute.pda));
    try {
      const cached = getDisputeEvidence(dispute.pda);
      let payload = cached?.responsePayload;
      if (manualPayloads[dispute.pda]?.trim()) {
        payload = JSON.parse(manualPayloads[dispute.pda]);
      }

      const res = await fetch(`${DEFAULT_PROVIDER_URL}/arbiter/resolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Arbiter-Token": requestToken,
          "X-Arbiter-Wallet": connectedAddress,
        },
        body: JSON.stringify({
          disputePda: dispute.pda,
          responsePayload: payload,
          receiptBase64: cached?.receiptBase64,
          rulingOverride: ruling,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) {
          setAuthToken((cur) => (cur === requestToken ? null : cur));
        }
        throw new Error(data.error || `Resolution failed (${res.status})`);
      }

      toast({
        type: data.ruling === "BuyerWins" ? "success" : "info",
        text: `Settled ${dispute.pda.slice(0, 8)}… as ${data.ruling}!`,
        link: data.explorerUrl ? { label: "Explorer", href: data.explorerUrl } : undefined,
      });

      onRunUpdate({
        executedAt: new Date().toISOString(),
        network: isLocalhostRpc ? "Solana Localnet" : "Solana Devnet",
        isSample: false,
        buyer: dispute.buyer,
        steps: [
          {
            step: 1,
            title: "Arbiter Portal Dispute Audit",
            status: "SUCCESS",
            description: `Authorized portal arbiter (${authorizedArbiter.slice(0, 6)}…) inspected dispute ${dispute.pda}.`,
            details: {
              disputePda: dispute.pda,
              provider: dispute.provider,
              claim: `${dispute.claimAmountSol.toFixed(4)} SOL`,
            },
          },
          {
            step: 2,
            title: `On-Chain Ruling Signed: ${data.ruling}`,
            status: "SUCCESS",
            description:
              data.ruling === "BuyerWins"
                ? "Provider bond slashed on Solana Devnet and claim + deposit refunded to buyer."
                : "Dispute dismissed; locked provider bond released and deposit forfeited to provider.",
            txSignature: data.txSignature,
            explorerUrl: data.explorerUrl,
            details: {
              ruling: data.ruling,
              rulingHash: data.rulingHashHex,
            },
          },
        ],
      });

      onRefresh();
    } catch (err: any) {
      toast({ type: "error", text: err?.message || "Failed to settle dispute" });
    } finally {
      setSettlingPdas((prev) => {
        const next = new Set(prev);
        next.delete(dispute.pda);
        return next;
      });
    }
  };

  const resolvedConfigArbiter =
    onChainConfig?.arbiter || statusInfo?.onChainConfigArbiter || null;
  const configKnown = Boolean(resolvedConfigArbiter);
  const configMatchesPortal = Boolean(
    configKnown && authorizedArbiter && resolvedConfigArbiter === authorizedArbiter
  );
  const openDisputes = disputes.filter((d) => d.status === "Open");
  const visibleDisputes = showResolved ? disputes : openDisputes;

  return (
    <section className="space-y-6">
      {/* On-Chain Config Status Banner */}
      <div className="bg-zinc-900/50 border border-white/10 rounded-xl p-4 text-xs font-mono space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-zinc-400">
            Global Config (<span className="text-zinc-200">{CONFIG_PDA.toBase58().slice(0, 8)}…</span>) On-Chain Arbiter:
          </span>
          <span
            className={
              !configKnown
                ? "text-zinc-400"
                : configMatchesPortal
                ? "text-emerald-300"
                : "text-amber-300"
            }
          >
            {resolvedConfigArbiter ||
              (statusLoading ? "Fetching Config…" : "Unavailable (RPC/API pending)")}
          </span>
        </div>
        {configKnown && authorizedArbiter && !configMatchesPortal && (
          <p className="text-[11px] text-amber-200/90 leading-relaxed">
            Notice: On-chain Config currently authorizes <code className="text-white">{resolvedConfigArbiter}</code> (backend <code className="text-white">ARBITER_SECRET_KEY</code>). Once you unlock this portal with the designated portal wallet and <code className="text-white">ARBITER_PORTAL_PASSWORD</code>, rulings settle via the authorized Config signer. To allow direct browser signing by the portal wallet, the Anchor program would need a Config arbiter update / re-initialization.
          </p>
        )}
      </div>

      {!authToken ? (
        <div className="max-w-xl bg-zinc-900/50 border border-white/10 rounded-xl p-6 space-y-5">
          <div>
            <h2 className="font-display text-base font-semibold text-white">
              Password-Gated Arbiter Portal
            </h2>
            <p className="text-xs text-zinc-400 mt-1">
              Restricted exclusively to the configured portal arbiter wallet{" "}
              <code className="font-mono text-zinc-200 break-all">
                {authorizedArbiter ||
                  (statusLoading ? "(checking backend…)" : "(unavailable)")}
              </code>
              , verified server-side via wallet signature + <code className="font-mono text-zinc-200">ARBITER_PORTAL_PASSWORD</code>.
            </p>
          </div>

          <div className="bg-zinc-950/60 border border-white/10 rounded-lg p-3.5 text-xs font-mono space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-zinc-500">Connected Wallet</span>
              {connected ? (
                <span
                  className={
                    isAuthorizedWallet
                      ? "text-emerald-300"
                      : !authorizedArbiter
                      ? "text-zinc-400"
                      : "text-rose-300"
                  }
                >
                  {isAuthorizedWallet
                    ? `✓ Authorized (${connectedAddress.slice(0, 6)}…${connectedAddress.slice(-4)})`
                    : !authorizedArbiter
                    ? statusLoading
                      ? "Checking backend…"
                      : "Portal wallet status unavailable"
                    : `✕ Wrong Wallet (${connectedAddress.slice(0, 6)}…${connectedAddress.slice(-4)})`}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setVisible(true)}
                  className="text-emerald-300 underline"
                >
                  Connect Wallet
                </button>
              )}
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="text-zinc-500">Backend Portal Wallet Env</span>
              <span
                className={
                  statusLoading || statusError
                    ? "text-zinc-400"
                    : statusInfo?.portalWalletConfigured
                    ? "text-emerald-300"
                    : "text-amber-300"
                }
              >
                {statusLoading
                  ? "Checking…"
                  : statusError
                  ? "Unavailable (backend unreachable)"
                  : statusInfo?.portalWalletConfigured && authorizedArbiter
                  ? `✓ ${authorizedArbiter.slice(0, 6)}…${authorizedArbiter.slice(-4)}`
                  : "⚠ Set ARBITER_PORTAL_WALLET on Render"}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="text-zinc-500">Backend Portal Password Env</span>
              <span
                className={
                  statusLoading || statusError
                    ? "text-zinc-400"
                    : statusInfo?.portalPasswordConfigured
                    ? "text-emerald-300"
                    : "text-amber-300"
                }
              >
                {statusLoading
                  ? "Checking…"
                  : statusError
                  ? "Unavailable (backend unreachable)"
                  : statusInfo?.portalPasswordConfigured
                  ? "✓ Configured"
                  : "⚠ Set ARBITER_PORTAL_PASSWORD on Render"}
              </span>
            </div>
          </div>

          <form onSubmit={handleUnlock} className="space-y-3">
            <div>
              <label
                htmlFor="arbiter-portal-password"
                className="block text-xs font-mono text-zinc-400 mb-1.5"
              >
                Arbiter Portal Password
              </label>
              <input
                id="arbiter-portal-password"
                type="password"
                required
                placeholder="Enter ARBITER_PORTAL_PASSWORD…"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-white/10 text-xs font-mono text-white focus:outline-none focus:border-emerald-500/50"
              />
            </div>

            <button
              type="submit"
              disabled={unlocking || !isAuthorizedWallet}
              className="w-full px-4 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-mono font-medium transition-colors disabled:opacity-50"
            >
              {unlocking
                ? "Sign Challenge & Verify with Backend…"
                : "🔓 Sign Challenge & Unlock Arbiter Workbench"}
            </button>
          </form>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="text-xs font-mono px-2.5 py-1 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
                🔓 Arbiter Authenticated ({authorizedArbiter.slice(0, 6)}…)
              </span>
              <span className="text-xs font-mono text-zinc-400">
                {openDisputes.length} open dispute(s)
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowResolved(!showResolved)}
                className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-white/10 text-xs font-mono text-zinc-300 hover:bg-zinc-800"
              >
                {showResolved ? "Show Open Only" : `Show All (${disputes.length})`}
              </button>
              <button
                type="button"
                onClick={() => setAuthToken(null)}
                className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-white/10 text-xs font-mono text-rose-300 hover:bg-zinc-800"
              >
                Lock Portal
              </button>
            </div>
          </div>

          {visibleDisputes.length === 0 ? (
            <div className="bg-zinc-900/40 border border-white/10 rounded-xl p-8 text-center text-xs font-mono text-zinc-400">
              No open disputes pending arbitration on Devnet.
            </div>
          ) : (
            <div className="space-y-4">
              {visibleDisputes.map((d) => {
                const audit = audits[d.pda];
                const cachedEvidence = getDisputeEvidence(d.pda);
                const isOpen = d.status === "Open";
                const resolveTimeout = onChainConfig?.resolveTimeoutSec || 180;
                const deadline = d.openedAt + resolveTimeout;
                const remainingSec = deadline - nowSec;
                const isAuditing = auditingPdas.has(d.pda);
                const isSettling = settlingPdas.has(d.pda);

                return (
                  <div
                    key={d.pda}
                    className="bg-zinc-900/40 border border-white/10 rounded-xl p-5 space-y-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1 text-xs font-mono">
                        <div className="text-white font-semibold">
                          Dispute PDA: {d.pda}
                        </div>
                        <div className="text-zinc-400">
                          Buyer: <span className="text-zinc-200">{d.buyer}</span> · Provider:{" "}
                          <span className="text-zinc-200">{d.provider}</span>
                        </div>
                        <div className="text-zinc-400">
                          Claim: <span className="text-white">{d.claimAmountSol.toFixed(4)} SOL</span> · Deposit:{" "}
                          <span className="text-white">{d.depositAmountSol.toFixed(4)} SOL</span> · Evidence Hash:{" "}
                          <span className="text-zinc-300">{d.evidenceHashHex.slice(0, 16)}…</span>
                        </div>
                      </div>

                      <div className="text-right font-mono text-xs space-y-1">
                        <span
                          className={`inline-block px-2.5 py-0.5 rounded ${
                            d.status === "Open"
                              ? "bg-amber-500/15 text-amber-300 border border-amber-500/30"
                              : d.status === "BuyerWins"
                              ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                              : "bg-zinc-800 text-zinc-300 border border-white/10"
                          }`}
                        >
                          {d.status}
                        </span>
                        {isOpen && (
                          <div className="text-[11px] text-zinc-400">
                            {remainingSec > 0
                              ? `Resolve window: ${remainingSec}s left`
                              : "Resolve timeout elapsed (use Claim Timeout)"}
                          </div>
                        )}
                      </div>
                    </div>

                    {isOpen && (
                      <div className="space-y-3 pt-3 border-t border-white/[0.06]">
                        {!cachedEvidence && (
                          <div>
                            <label
                              htmlFor={`evidence-${d.pda}`}
                              className="block text-[11px] font-mono text-zinc-500 mb-1"
                            >
                              Optional Evidence JSON Override (if not auto-cached on server)
                            </label>
                            <input
                              id={`evidence-${d.pda}`}
                              type="text"
                              placeholder='{"city":"SolanaBeach","temperature":9999,"humidity":-50,"observedAt":...}'
                              value={manualPayloads[d.pda] || ""}
                              onChange={(e) =>
                                setManualPayloads((p) => ({ ...p, [d.pda]: e.target.value }))
                              }
                              className="w-full px-3 py-1.5 rounded bg-zinc-950 border border-white/10 text-xs font-mono text-zinc-200"
                            />
                          </div>
                        )}

                        {audit?.hasEvidence && audit.auditReport && (
                          <div className="bg-zinc-950/70 border border-white/10 rounded-lg p-3 space-y-2">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                              <span className="text-zinc-400">Deterministic Audit Report</span>
                              <span
                                className={
                                  audit.recommendedRuling === "BuyerWins"
                                    ? "text-rose-300 font-semibold"
                                    : audit.recommendedRuling === "ProviderWins"
                                    ? "text-emerald-300 font-semibold"
                                    : "text-amber-300 font-semibold"
                                }
                              >
                                Recommended: {audit.recommendedRuling || "None (Commitment Mismatch)"}
                              </span>
                            </div>
                            <pre className="text-[11px] font-mono text-zinc-300 overflow-x-auto">
                              {audit.reportText}
                            </pre>
                          </div>
                        )}

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleAuditPreview(d)}
                            disabled={isAuditing}
                            className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-xs font-mono text-zinc-200 transition-colors disabled:opacity-50"
                          >
                            {isAuditing ? "Auditing…" : "🔍 Run Deterministic Audit"}
                          </button>

                          <button
                            type="button"
                            onClick={() => handleSettleDispute(d, "BuyerWins")}
                            disabled={isSettling || remainingSec <= 0}
                            className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-mono text-white font-medium transition-colors disabled:opacity-50"
                          >
                            {isSettling
                              ? "Signing…"
                              : "✓ Settle BuyerWins (Slash Provider)"}
                          </button>

                          <button
                            type="button"
                            onClick={() => handleSettleDispute(d, "ProviderWins")}
                            disabled={isSettling || remainingSec <= 0}
                            className="px-3 py-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-xs font-mono text-zinc-300 transition-colors disabled:opacity-50"
                          >
                            {isSettling ? "Signing…" : "Settle ProviderWins (Dismiss)"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

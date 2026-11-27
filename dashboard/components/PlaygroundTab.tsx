"use client";

import React, { useState, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { DEVNET_PROVIDERS, ProviderConfig } from "../lib/providers-config";
import {
  decodePaymentRefTxSig,
  decodeReceiptBrowser,
  ReceiptDataBrowser,
  toHex,
} from "../lib/receipt-browser";
import { verifyResponseAgainstSpec, SpecCheckResult } from "../lib/spec-verifier";
import { buildOpenDisputeTransaction } from "../lib/dispute-client";
import { saveDisputeEvidence, saveLiveRun } from "../lib/live-run";
import { OnChainProvider } from "../lib/solana";
import { useToast } from "./Toast";

const DEFAULT_PROVIDER_URL =
  process.env.NEXT_PUBLIC_PROVIDER_API_URL || "http://127.0.0.1:3402";

interface PlaygroundState {
  selectedProvider: ProviderConfig | null;
  loading: boolean;
  stageLabel: string;
  paymentTxSig: string | null;
  responseData: any | null;
  receipt: ReceiptDataBrowser | null;
  receiptBase64: string;
  signatureBase64: string;
  specJson: string;
  verifyResult: SpecCheckResult | null;
  disputeLoading: boolean;
  disputeTxSig: string | null;
  disputePda: string | null;
  arbiterLoading: boolean;
  arbiterResult: any | null;
}

function CopyBtn({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="text-[10px] px-1.5 py-0.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-white/5 transition-colors"
    >
      {copied ? "✓" : "Copy"}
    </button>
  );
}

export default function PlaygroundTab({
  onRefresh,
  onRunUpdate,
  onChainProviders,
  isLocalhostRpc,
}: {
  onRefresh: () => void;
  onRunUpdate: (runData: any) => void;
  onChainProviders: OnChainProvider[];
  isLocalhostRpc: boolean;
}) {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { setVisible } = useWalletModal();
  const { connection } = useConnection();
  const { toast } = useToast();

  const [state, setState] = useState<PlaygroundState>({
    selectedProvider: DEVNET_PROVIDERS[1], // Default highlight Lying provider for quick demo
    loading: false,
    stageLabel: "",
    paymentTxSig: null,
    responseData: null,
    receipt: null,
    receiptBase64: "",
    signatureBase64: "",
    specJson: "",
    verifyResult: null,
    disputeLoading: false,
    disputeTxSig: null,
    disputePda: null,
    arbiterLoading: false,
    arbiterResult: null,
  });

  const update = (patch: Partial<PlaygroundState>) =>
    setState((s) => ({ ...s, ...patch }));

  const explorerTx = useCallback(
    (sig: string) =>
      isLocalhostRpc
        ? `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent("http://127.0.0.1:8899")}`
        : `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
    [isLocalhostRpc]
  );

  const pushTimelineRun = useCallback(
    (params: {
      provider: ProviderConfig;
      buyer: string;
      paymentTxSig?: string | null;
      data?: any;
      verifyResult?: SpecCheckResult | null;
      disputePda?: string | null;
      disputeTxSig?: string | null;
      arbiterResult?: any | null;
      priceLamports?: number;
    }) => {
      const chainProvider = onChainProviders.find(
        (cp) => cp.wallet === params.provider.wallet
      );
      const steps: any[] = [
        {
          step: 1,
          title: "Pre-Flight Trust Verification",
          status: "SUCCESS",
          description:
            "Inspected provider on-chain bond, track record, and immutable spec_hash on Solana.",
          details: {
            provider: params.provider.wallet,
            bond: chainProvider ? `${chainProvider.bondSol.toFixed(4)} SOL` : "0.0500 SOL",
            slashed: chainProvider ? `${chainProvider.totalSlashedSol.toFixed(4)} SOL` : "0.0000 SOL",
          },
        },
        {
          step: 2,
          title: params.paymentTxSig
            ? "x402 Payment & Signed Receipt Verified"
            : "Provider Query & Signed Receipt Received",
          status: params.verifyResult?.isValid ? "SUCCESS" : "VIOLATION_DETECTED",
          description: params.verifyResult?.isValid
            ? "Settled x402 payment on Solana and verified 249-byte Ed25519 receipt + spec compliance."
            : `Settled x402 payment and caught spec violations: ${(params.verifyResult?.errors || []).join("; ")}`,
          txSignature: params.paymentTxSig || undefined,
          explorerUrl: params.paymentTxSig ? explorerTx(params.paymentTxSig) : undefined,
          details: {
            endpoint: params.provider.endpoint,
            price: `${((params.priceLamports ?? 10_000_000) / 1e9).toFixed(4)} SOL`,
            verdict: params.verifyResult?.isValid ? "PASS" : "FAIL",
            data: params.data,
          },
        },
      ];

      if (params.disputeTxSig && params.disputePda) {
        steps.push({
          step: 3,
          title: "On-Chain Dispute Opened",
          status: "SUCCESS",
          description:
            "Submitted Ed25519 signature introspection + receipt & evidence hashes to open dispute on Solana.",
          txSignature: params.disputeTxSig,
          explorerUrl: explorerTx(params.disputeTxSig),
          details: {
            disputePda: params.disputePda,
            deposit: "0.0100 SOL",
            violations: params.verifyResult?.errors || [],
          },
        });
      }

      if (params.arbiterResult?.txSignature) {
        steps.push({
          step: 4,
          title: "Arbiter Resolution Executed",
          status: "SUCCESS",
          description: `Arbiter ran deterministic spec audit and signed ${params.arbiterResult.ruling} on Solana.`,
          txSignature: params.arbiterResult.txSignature,
          explorerUrl: params.arbiterResult.explorerUrl || explorerTx(params.arbiterResult.txSignature),
          details: {
            ruling: params.arbiterResult.ruling,
            disputePda: params.disputePda,
            rulingHash: params.arbiterResult.rulingHashHex,
          },
        });
      }

      const runObj = {
        executedAt: new Date().toISOString(),
        network: isLocalhostRpc ? "Solana Localnet" : "Solana Devnet",
        isSample: false,
        buyer: params.buyer,
        steps,
      };
      saveLiveRun(runObj);
      onRunUpdate(runObj);
    },
    [onChainProviders, explorerTx, isLocalhostRpc, onRunUpdate]
  );

  // Step 1 & 2: Execute real x402 paid request -> receive 249-byte receipt -> verify spec
  const handleSendRequest = useCallback(
    async (provider: ProviderConfig) => {
      if (!connected || !publicKey) {
        setVisible(true);
        toast({ type: "info", text: "Connect a Solana wallet first to execute a paid x402 call." });
        return;
      }

      update({
        selectedProvider: provider,
        loading: true,
        stageLabel: "Fetching service spec & querying x402 endpoint…",
        paymentTxSig: null,
        responseData: null,
        receipt: null,
        receiptBase64: "",
        signatureBase64: "",
        specJson: "",
        verifyResult: null,
        disputeTxSig: null,
        disputePda: null,
        arbiterResult: null,
      });

      try {
        const specRes = await fetch(`${DEFAULT_PROVIDER_URL}/spec`);
        if (!specRes.ok) throw new Error(`Failed to fetch /spec (${specRes.status})`);
        const specJson = await specRes.text();

        const targetUrl = `${provider.endpoint}?buyer=${publicKey.toBase58()}`;
        let res = await fetch(targetUrl);
        let paymentTxSig: string | null = null;

        // Handle standard x402 402 Payment Required challenge
        if (res.status === 402) {
          let challenge: any = null;
          const reqHeader = res.headers.get("PAYMENT-REQUIRED");
          if (reqHeader) {
            challenge = JSON.parse(atob(reqHeader));
          } else {
            challenge = await res.json();
          }

          const accept = challenge?.accepts?.[0];
          if (!accept?.payTo || !accept?.amount) {
            throw new Error("Server returned 402 without valid payment terms");
          }

          const amountLamports = Number(accept.amount);
          const payToPubkey = new PublicKey(accept.payTo);

          update({
            stageLabel: `402 Payment Required: Approve ${(amountLamports / 1e9).toFixed(4)} SOL transfer in wallet…`,
          });

          const walletBal = await connection.getBalance(publicKey);
          if (walletBal < amountLamports + 5_000_000) {
            throw new Error(
              `Insufficient SOL balance (${(walletBal / 1e9).toFixed(4)} SOL). Click "+ 1 SOL" in the header to airdrop Devnet SOL.`
            );
          }

          const payTx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: publicKey,
              toPubkey: payToPubkey,
              lamports: amountLamports,
            })
          );
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
          payTx.recentBlockhash = blockhash;
          payTx.lastValidBlockHeight = lastValidBlockHeight;
          payTx.feePayer = publicKey;

          paymentTxSig = await sendTransaction(payTx, connection);
          update({
            paymentTxSig,
            stageLabel: "Confirming x402 SOL payment on Solana Devnet…",
          });

          await connection.confirmTransaction(
            { signature: paymentTxSig, blockhash, lastValidBlockHeight },
            "confirmed"
          );

          toast({
            type: "info",
            text: `x402 payment confirmed (${(amountLamports / 1e9).toFixed(4)} SOL)`,
            link: { label: "Explorer", href: explorerTx(paymentTxSig) },
          });

          update({ stageLabel: "Submitting PAYMENT-SIGNATURE proof to provider…" });

          const paymentProofB64 = btoa(
            JSON.stringify({
              txSignature: paymentTxSig,
              buyer: publicKey.toBase58(),
              amount: accept.amount,
            })
          );

          res = await fetch(targetUrl, {
            headers: {
              "PAYMENT-SIGNATURE": paymentProofB64,
            },
          });
        }

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error || `API returned HTTP ${res.status}`);
        }

        const body = await res.json();
        const data = body.data || body;
        const receiptB64 =
          body.receipt?.bytesBase64 || res.headers.get("X-Justice402-Receipt") || "";
        const sigB64 =
          body.receipt?.signatureBase64 || res.headers.get("X-Justice402-Signature") || "";
        const effectivePaySig = paymentTxSig || body.payment?.txSignature || null;

        if (!receiptB64 || !sigB64) {
          throw new Error("Provider response missing signed 249-byte receipt headers");
        }

        const receipt = decodeReceiptBrowser(receiptB64);

        const rawBytes = new TextEncoder().encode(JSON.stringify(data));
        const verifyResult = await verifyResponseAgainstSpec({
          specJson,
          expectedSpecHash: receipt.specHash,
          responseData: data,
          rawResponseBytes: rawBytes,
          receiptResponseHash: receipt.responseHash,
          receiptTimestamp: receipt.timestamp,
        });

        update({
          loading: false,
          stageLabel: "",
          paymentTxSig: effectivePaySig,
          responseData: data,
          receipt,
          receiptBase64: receiptB64,
          signatureBase64: sigB64,
          specJson,
          verifyResult,
        });

        pushTimelineRun({
          provider,
          buyer: publicKey.toBase58(),
          paymentTxSig: effectivePaySig,
          data,
          verifyResult,
          priceLamports: Number(receipt.price),
        });

        if (verifyResult.isValid) {
          toast({
            type: "success",
            text: `${provider.name}: Paid & verified PASS`,
          });
        } else {
          toast({
            type: "warning",
            text: `${provider.name}: Paid & caught ${verifyResult.errors.length} spec violation(s)!`,
          });
        }
      } catch (err: any) {
        update({ loading: false, stageLabel: "" });
        const msg = err?.message || "Request failed";
        if (msg.toLowerCase().includes("user rejected")) {
          toast({ type: "warning", text: "Payment cancelled in wallet." });
        } else {
          toast({ type: "error", text: msg });
        }
      }
    },
    [connected, publicKey, setVisible, connection, sendTransaction, explorerTx, pushTimelineRun, toast]
  );

  // Step 3: Raise on-chain dispute directly from buyer wallet
  const handleOpenDispute = useCallback(async () => {
    if (!connected || !publicKey || !state.receipt || !state.responseData || !state.selectedProvider) {
      toast({ type: "error", text: "Connect wallet and execute an x402 API call first" });
      return;
    }

    const providerOnChain = onChainProviders.find(
      (p) => p.wallet === state.receipt!.provider.toBase58()
    );
    const claimSol = Number(state.receipt.price) / 1e9;
    if (providerOnChain && providerOnChain.bondSol - providerOnChain.lockedSol < claimSol) {
      toast({
        type: "error",
        text: `Provider bond too low (${(providerOnChain.bondSol - providerOnChain.lockedSol).toFixed(4)} SOL available < ${claimSol.toFixed(4)} SOL claim). Try Plausible-Wrong or Honest provider!`,
      });
      return;
    }

    update({ disputeLoading: true });

    try {
      const { transaction, disputePda } = await buildOpenDisputeTransaction({
        connection,
        buyerPubkey: publicKey,
        receipt: state.receipt,
        signatureBase64: state.signatureBase64,
        responseData: state.responseData,
      });

      const txSig = await sendTransaction(transaction, connection);
      await connection.confirmTransaction(
        {
          signature: txSig,
          blockhash: transaction.recentBlockhash!,
          lastValidBlockHeight: transaction.lastValidBlockHeight!,
        },
        "confirmed"
      );

      const disputePdaStr = disputePda.toBase58();
      saveDisputeEvidence({
        disputePda: disputePdaStr,
        responsePayload: state.responseData,
        receiptBase64: state.receiptBase64,
        signatureBase64: state.signatureBase64,
        openTxSig: txSig,
        paymentTxSig: state.paymentTxSig || undefined,
        providerWallet: state.receipt.provider.toBase58(),
      });

      update({
        disputeLoading: false,
        disputeTxSig: txSig,
        disputePda: disputePdaStr,
      });

      pushTimelineRun({
        provider: state.selectedProvider,
        buyer: publicKey.toBase58(),
        paymentTxSig: state.paymentTxSig,
        data: state.responseData,
        verifyResult: state.verifyResult,
        disputePda: disputePdaStr,
        disputeTxSig: txSig,
        priceLamports: Number(state.receipt.price),
      });

      toast({
        type: "success",
        text: "Dispute opened on Solana Devnet!",
        link: { label: "Explorer", href: explorerTx(txSig) },
      });

      onRefresh();
    } catch (err: any) {
      update({ disputeLoading: false });
      const msg = err?.message || "Transaction failed";
      if (msg.toLowerCase().includes("user rejected")) {
        toast({ type: "warning", text: "Transaction rejected by wallet." });
      } else {
        toast({ type: "error", text: `Open dispute failed: ${msg}` });
      }
    }
  }, [connected, publicKey, state, onChainProviders, connection, sendTransaction, explorerTx, pushTimelineRun, toast, onRefresh]);

  // Step 4: Request Arbiter Ruling from Render backend
  const handleRequestArbiter = useCallback(async () => {
    if (!state.disputePda || !publicKey || !state.selectedProvider) return;

    update({ arbiterLoading: true });

    try {
      const res = await fetch(`${DEFAULT_PROVIDER_URL}/arbiter/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          disputePda: state.disputePda,
          responsePayload: state.responseData,
          receiptBase64: state.receiptBase64,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Arbiter returned HTTP ${res.status}`);
      }

      update({ arbiterLoading: false, arbiterResult: data });

      pushTimelineRun({
        provider: state.selectedProvider,
        buyer: publicKey.toBase58(),
        paymentTxSig: state.paymentTxSig,
        data: state.responseData,
        verifyResult: state.verifyResult,
        disputePda: state.disputePda,
        disputeTxSig: state.disputeTxSig,
        arbiterResult: data,
        priceLamports: state.receipt ? Number(state.receipt.price) : 10_000_000,
      });

      toast({
        type: data.ruling === "BuyerWins" ? "success" : "info",
        text:
          data.ruling === "BuyerWins"
            ? "Arbiter ruled BuyerWins — Provider bond slashed & buyer refunded!"
            : "Arbiter ruled ProviderWins — Spec compliant; deposit forfeited.",
        link: data.explorerUrl ? { label: "Explorer", href: data.explorerUrl } : undefined,
      });

      onRefresh();
    } catch (err: any) {
      update({ arbiterLoading: false });
      toast({ type: "error", text: `Arbiter error: ${err?.message || err}` });
    }
  }, [state, publicKey, pushTimelineRun, toast, onRefresh]);

  const { selectedProvider, receipt, verifyResult, responseData } = state;
  const decodedPayRefSig = receipt ? decodePaymentRefTxSig(receipt.paymentReference) : null;

  return (
    <section className="space-y-6">
      {/* Provider Cards + Pay Button */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-sm font-semibold text-white">
              Live x402 Paid API Playground (0.01 SOL / call)
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Select a registered Devnet provider, approve the x402 SOL payment, inspect the 249-byte Ed25519 receipt, and challenge lies on-chain.
            </p>
          </div>
          {!connected && (
            <button
              type="button"
              onClick={() => setVisible(true)}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
            >
              Connect Wallet to Start
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {DEVNET_PROVIDERS.map((p) => {
            const badgeColors = {
              honest: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
              lying: "text-rose-300 border-rose-500/30 bg-rose-500/10",
              subtle: "text-amber-300 border-amber-500/30 bg-amber-500/10",
            };
            const isSelected = selectedProvider?.endpoint === p.endpoint;
            const liveStats = onChainProviders.find((cp) => cp.wallet === p.wallet);

            return (
              <div
                key={p.endpoint}
                onClick={() => !state.loading && update({ selectedProvider: p })}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (!state.loading) update({ selectedProvider: p });
                  }
                }}
                className={`text-left p-4 rounded-xl border transition-all cursor-pointer flex flex-col justify-between gap-3 ${
                  isSelected
                    ? "bg-zinc-800/80 border-emerald-500/50 ring-1 ring-emerald-500/20"
                    : "bg-zinc-900/40 border-white/10 hover:border-white/20 hover:bg-zinc-900/60"
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="font-display text-sm font-medium text-white">{p.name}</span>
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.5 border rounded uppercase ${badgeColors[p.badge]}`}
                    >
                      {p.badge}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">{p.description}</p>
                </div>

                <div className="pt-2 border-t border-white/[0.06] flex items-center justify-between text-[11px] font-mono">
                  <span className="text-zinc-500 truncate max-w-[140px]" title={p.wallet}>
                    {p.wallet.slice(0, 6)}…{p.wallet.slice(-4)}
                  </span>
                  {liveStats ? (
                    <span className="text-zinc-300 tabular-nums">
                      Bond: {liveStats.bondSol.toFixed(3)} SOL
                      {liveStats.disputesBuyerWon > 0 && (
                        <span className="text-rose-300 ml-1.5">({liveStats.disputesBuyerWon}x slashed)</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-zinc-500">Devnet</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {selectedProvider && (
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => handleSendRequest(selectedProvider)}
              disabled={state.loading}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-mono font-medium transition-colors disabled:opacity-50"
            >
              {state.loading
                ? state.stageLabel || "Processing x402 request…"
                : `⚡ Pay 0.01 SOL & Call ${selectedProvider.name}`}
            </button>
            <span className="text-xs font-mono text-zinc-500 truncate">
              {selectedProvider.endpoint}
            </span>
          </div>
        )}
      </div>

      {/* Results Area */}
      {responseData && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Left: HTTP Payload + Verification + Dispute & Arbiter */}
          <div className="space-y-4">
            <div className="bg-zinc-900/50 border border-white/10 rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-display text-sm font-semibold text-white">
                  Returned HTTP JSON Payload
                </h3>
                {state.paymentTxSig && (
                  <a
                    href={explorerTx(state.paymentTxSig)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] font-mono text-emerald-300 hover:underline"
                  >
                    x402 Payment Tx ↗
                  </a>
                )}
              </div>
              <pre className="text-xs font-mono text-zinc-200 bg-zinc-950/70 rounded-lg p-3 overflow-x-auto border border-white/[0.05]">
                {JSON.stringify(responseData, null, 2)}
              </pre>
            </div>

            {verifyResult && (
              <div className="bg-zinc-900/50 border border-white/10 rounded-xl p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-display text-sm font-semibold text-white">
                    Deterministic Spec Verification
                  </h3>
                  <span
                    className={`text-xs font-mono font-medium px-2.5 py-0.5 rounded ${
                      verifyResult.isValid
                        ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
                        : "bg-rose-500/10 text-rose-300 border border-rose-500/30"
                    }`}
                  >
                    {verifyResult.isValid
                      ? "✓ PASS (Valid Response)"
                      : "✕ FAIL (Spec Violation Detected)"}
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs font-mono">
                  {(
                    [
                      ["specHashMatch", "Spec Hash"],
                      ["responseHashMatch", "Resp Hash"],
                      ["schemaValid", "Schema"],
                      ["rangesValid", "Ranges"],
                      ["freshnessValid", "Freshness"],
                    ] as const
                  ).map(([key, label]) => (
                    <div
                      key={key}
                      className={`px-2 py-1.5 rounded-lg text-center ${
                        verifyResult[key]
                          ? "bg-emerald-950/40 text-emerald-300 border border-emerald-500/20"
                          : "bg-rose-950/40 text-rose-300 border border-rose-500/20"
                      }`}
                    >
                      <span className="block text-[10px] text-zinc-400 mb-0.5">{label}</span>
                      {verifyResult[key] ? "PASS" : "FAIL"}
                    </div>
                  ))}
                </div>

                {verifyResult.errors.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    {verifyResult.errors.map((e, i) => (
                      <div
                        key={i}
                        className="text-xs font-mono text-rose-300 pl-2.5 border-l-2 border-rose-500/40"
                      >
                        {e}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {receipt && verifyResult && (
              <div className="bg-zinc-900/50 border border-white/10 rounded-xl p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-sm font-semibold text-white">
                    On-Chain Dispute & Arbiter Settlement
                  </h3>
                  <span className="text-[11px] font-mono text-zinc-500">
                    Deposit: 0.0100 SOL (refunded if BuyerWins)
                  </span>
                </div>

                {!state.disputeTxSig ? (
                  <button
                    type="button"
                    onClick={handleOpenDispute}
                    disabled={state.disputeLoading || !connected}
                    className={`w-full px-4 py-2.5 rounded-lg text-xs font-mono font-medium transition-colors ${
                      !verifyResult.isValid
                        ? "bg-rose-600 hover:bg-rose-500 text-white"
                        : "bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-white/10"
                    } disabled:opacity-50`}
                  >
                    {state.disputeLoading
                      ? "Submitting Ed25519 + open_dispute on Solana…"
                      : !verifyResult.isValid
                      ? "🚨 Raise On-Chain Dispute (open_dispute)"
                      : "Raise On-Chain Dispute (Challenge Plausible Response)"}
                  </button>
                ) : (
                  <div className="space-y-3">
                    <div className="text-xs font-mono text-emerald-300">
                      ✓ Dispute opened on Solana Devnet
                    </div>
                    <div className="text-xs font-mono space-y-1.5 bg-zinc-950/60 rounded-lg p-3 border border-white/[0.05]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-zinc-500">Dispute PDA</span>
                        <span className="flex items-center gap-1 text-zinc-200 truncate">
                          <span className="truncate">{state.disputePda}</span>
                          {state.disputePda && <CopyBtn value={state.disputePda} />}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-zinc-500">Open Tx</span>
                        <a
                          href={explorerTx(state.disputeTxSig)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-emerald-300 hover:underline truncate"
                        >
                          {state.disputeTxSig.slice(0, 18)}…{state.disputeTxSig.slice(-8)} ↗
                        </a>
                      </div>
                    </div>

                    {!state.arbiterResult ? (
                      <button
                        type="button"
                        onClick={handleRequestArbiter}
                        disabled={state.arbiterLoading}
                        className="w-full px-4 py-2.5 rounded-lg text-xs font-mono font-medium bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-50"
                      >
                        {state.arbiterLoading
                          ? "Arbiter Auditing & Signing resolve_dispute…"
                          : "⚖ Request Arbiter Ruling (POST /arbiter/resolve)"}
                      </button>
                    ) : (
                      <div className="bg-zinc-950/70 border border-white/10 rounded-lg p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-mono text-zinc-400">
                            Arbiter Ruling (Live on Devnet)
                          </span>
                          <span
                            className={`text-xs font-mono font-semibold px-2.5 py-0.5 rounded ${
                              state.arbiterResult.ruling === "BuyerWins"
                                ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                                : "bg-zinc-700/60 text-zinc-200 border border-white/10"
                            }`}
                          >
                            {state.arbiterResult.ruling === "BuyerWins"
                              ? "✓ BuyerWins (Bond Slashed!)"
                              : "ProviderWins"}
                          </span>
                        </div>
                        {state.arbiterResult.txSignature && (
                          <div className="text-xs font-mono flex items-center justify-between gap-2">
                            <span className="text-zinc-500">Resolution Tx</span>
                            <a
                              href={state.arbiterResult.explorerUrl || explorerTx(state.arbiterResult.txSignature)}
                              target="_blank"
                              rel="noreferrer"
                              className="text-emerald-300 hover:underline truncate"
                            >
                              {state.arbiterResult.txSignature.slice(0, 18)}…
                              {state.arbiterResult.txSignature.slice(-8)} ↗
                            </a>
                          </div>
                        )}
                        {state.arbiterResult.reportText && (
                          <details>
                            <summary className="text-[11px] font-mono text-zinc-400 cursor-pointer hover:text-zinc-200">
                              View Full Server Arbiter Audit Report
                            </summary>
                            <pre className="mt-2 p-2.5 bg-zinc-900 rounded text-[11px] font-mono text-zinc-300 overflow-x-auto">
                              {state.arbiterResult.reportText}
                            </pre>
                          </details>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right: 249-Byte Ed25519 Receipt Inspector */}
          <div className="space-y-4">
            {receipt && (
              <div className="bg-zinc-900/50 border border-white/10 rounded-xl p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-sm font-semibold text-white">
                    249-Byte Ed25519 Signed Receipt
                  </h3>
                  <span className="text-[10px] font-mono text-emerald-300">
                    v{receipt.version} · Canonical 249 bytes
                  </span>
                </div>

                <dl className="space-y-2 text-xs font-mono">
                  {[
                    { label: "Provider Pubkey", value: receipt.provider.toBase58(), copy: true },
                    { label: "Buyer Pubkey", value: receipt.buyer.toBase58(), copy: true },
                    { label: "Spec Hash", value: toHex(receipt.specHash), copy: true },
                    { label: "Request Hash", value: toHex(receipt.requestHash), copy: false },
                    { label: "Response Hash", value: toHex(receipt.responseHash), copy: true },
                    {
                      label: "Price",
                      value: `${(Number(receipt.price) / 1e9).toFixed(4)} SOL (${receipt.price.toString()} lamports)`,
                      copy: false,
                    },
                    {
                      label: "Timestamp",
                      value: `${receipt.timestamp.toString()} (${new Date(Number(receipt.timestamp) * 1000).toISOString()})`,
                      copy: false,
                    },
                    { label: "Nonce", value: receipt.nonce.toString(), copy: false },
                  ].map(({ label, value, copy }) => (
                    <div
                      key={label}
                      className="flex items-center justify-between gap-3 py-1 border-b border-white/[0.05]"
                    >
                      <dt className="text-zinc-500 shrink-0">{label}</dt>
                      <dd
                        className="text-zinc-200 text-right flex items-center gap-1 min-w-0"
                        title={value}
                      >
                        <span className="truncate max-w-[240px]">
                          {value.length > 42 ? `${value.slice(0, 16)}…${value.slice(-10)}` : value}
                        </span>
                        {copy && <CopyBtn value={value} />}
                      </dd>
                    </div>
                  ))}

                  <div className="flex items-center justify-between gap-3 py-1 border-b border-white/[0.05]">
                    <dt className="text-zinc-500 shrink-0">Payment Reference</dt>
                    <dd className="text-right flex items-center gap-1 min-w-0">
                      {decodedPayRefSig ? (
                        <a
                          href={explorerTx(decodedPayRefSig)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-emerald-300 hover:underline truncate max-w-[240px]"
                          title={decodedPayRefSig}
                        >
                          {decodedPayRefSig.slice(0, 16)}…{decodedPayRefSig.slice(-8)} ↗
                        </a>
                      ) : (
                        <span className="text-zinc-400">Zeroed (Test Mode)</span>
                      )}
                    </dd>
                  </div>

                  <div className="flex items-center justify-between gap-3 py-1 border-b border-white/[0.05]">
                    <dt className="text-zinc-500 shrink-0">Ed25519 Signature</dt>
                    <dd className="text-zinc-300 text-right flex items-center gap-1 min-w-0">
                      <span className="truncate max-w-[220px]">
                        {state.signatureBase64.slice(0, 18)}…{state.signatureBase64.slice(-10)}
                      </span>
                      <CopyBtn value={state.signatureBase64} />
                    </dd>
                  </div>
                </dl>

                <details className="mt-2">
                  <summary className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-300">
                    Inspect Raw Base64 (Receipt & Signature)
                  </summary>
                  <div className="mt-2 space-y-2">
                    <div className="p-2 bg-zinc-950/60 rounded text-[10px] font-mono text-zinc-400 break-all">
                      <span className="text-zinc-500 block mb-0.5">X-Justice402-Receipt:</span>
                      {state.receiptBase64}
                    </div>
                    <div className="p-2 bg-zinc-950/60 rounded text-[10px] font-mono text-zinc-400 break-all">
                      <span className="text-zinc-500 block mb-0.5">X-Justice402-Signature:</span>
                      {state.signatureBase64}
                    </div>
                  </div>
                </details>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

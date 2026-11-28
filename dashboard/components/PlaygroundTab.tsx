"use client";

import React, { useState, useCallback, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  DEFAULT_WEATHER_SPEC_TEMPLATE,
  ProviderConfig,
} from "../lib/providers-config";
import {
  decodePaymentRefTxSig,
  decodeReceiptBrowser,
  ReceiptDataBrowser,
  toHex,
} from "../lib/receipt-browser";
import { verifyResponseAgainstSpec, SpecCheckResult } from "../lib/spec-verifier";
import { buildOpenDisputeTransaction } from "../lib/dispute-client";
import { saveDisputeEvidence, saveLiveRun } from "../lib/live-run";
import {
  availableBondSol,
  isProviderInsured,
  MIN_INSURED_BOND_SOL,
} from "../lib/solana";
import { useToast } from "./Toast";

const DEFAULT_PROVIDER_URL =
  process.env.NEXT_PUBLIC_PROVIDER_API_URL || "http://127.0.0.1:3402";

interface PlaygroundState {
  selectedWallet: string | null;
  simulateLie: boolean;
  loading: boolean;
  stageLabel: string;
  paymentTxSig: string | null;
  responseData: any | null;
  receipt: ReceiptDataBrowser | null;
  receiptBase64: string;
  signatureBase64: string;
  needsProviderSig: boolean;
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
  providers,
  onRefresh,
  onRunUpdate,
  onGoToProviders,
  isLocalhostRpc,
}: {
  providers: ProviderConfig[];
  onRefresh: () => void;
  onRunUpdate: (runData: any) => void;
  onGoToProviders: () => void;
  isLocalhostRpc: boolean;
}) {
  const { publicKey, connected, sendTransaction, signMessage } = useWallet();
  const { setVisible } = useWalletModal();
  const { connection } = useConnection();
  const { toast } = useToast();

  const [state, setState] = useState<PlaygroundState>({
    selectedWallet: providers[1]?.wallet || providers[0]?.wallet || null,
    simulateLie: false,
    loading: false,
    stageLabel: "",
    paymentTxSig: null,
    responseData: null,
    receipt: null,
    receiptBase64: "",
    signatureBase64: "",
    needsProviderSig: false,
    specJson: "",
    verifyResult: null,
    disputeLoading: false,
    disputeTxSig: null,
    disputePda: null,
    arbiterLoading: false,
    arbiterResult: null,
  });

  useEffect(() => {
    if (!state.selectedWallet && providers.length > 0) {
      setState((s) => ({ ...s, selectedWallet: providers[1]?.wallet || providers[0].wallet }));
    }
  }, [providers, state.selectedWallet]);

  const update = (patch: Partial<PlaygroundState>) =>
    setState((s) => ({ ...s, ...patch }));

  const selectedProvider =
    providers.find((p) => p.wallet === state.selectedWallet) || providers[0] || null;

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
      const cp = params.provider.chainState;
      const steps: any[] = [
        {
          step: 1,
          title: "Pre-Flight Bond & Coverage Verification",
          status: "SUCCESS",
          description:
            "Verified provider available bond (staked - locked) and immutable spec_hash on Solana Devnet.",
          details: {
            provider: params.provider.wallet,
            availableBond: cp ? `${availableBondSol(cp).toFixed(4)} SOL` : "0.0500 SOL",
            slashed: cp ? `${cp.totalSlashedSol.toFixed(4)} SOL` : "0.0000 SOL",
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
    [explorerTx, isLocalhostRpc, onRunUpdate]
  );

  // Fetch URL directly or fallback through /providers/proxy if custom external API lacks CORS headers
  async function fetchX402Endpoint(url: string, paymentProofB64?: string) {
    const headers: Record<string, string> = {};
    if (paymentProofB64) headers["PAYMENT-SIGNATURE"] = paymentProofB64;

    const isHostedSameBackend = url.startsWith(DEFAULT_PROVIDER_URL);
    if (isHostedSameBackend) {
      const res = await fetch(url, { headers });
      const body = await res.json().catch(() => ({}));
      return {
        status: res.status,
        paymentRequiredHeader: res.headers.get("PAYMENT-REQUIRED"),
        receiptHeader: res.headers.get("X-Justice402-Receipt"),
        signatureHeader: res.headers.get("X-Justice402-Signature"),
        body,
      };
    }

    try {
      const res = await fetch(url, { headers });
      const body = await res.json().catch(() => ({}));
      return {
        status: res.status,
        paymentRequiredHeader: res.headers.get("PAYMENT-REQUIRED"),
        receiptHeader: res.headers.get("X-Justice402-Receipt"),
        signatureHeader: res.headers.get("X-Justice402-Signature"),
        body,
      };
    } catch {
      const proxyRes = await fetch(`${DEFAULT_PROVIDER_URL}/providers/proxy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUrl: url, paymentSignature: paymentProofB64 }),
      });
      const proxyData = await proxyRes.json();
      if (!proxyRes.ok) throw new Error(proxyData.error || "Proxy request failed");
      return {
        status: proxyData.status,
        paymentRequiredHeader: proxyData.headers?.["payment-required"] || null,
        receiptHeader: proxyData.headers?.["x-justice402-receipt"] || null,
        signatureHeader: proxyData.headers?.["x-justice402-signature"] || null,
        body: proxyData.body,
      };
    }
  }

  // Step 1 & 2: Pre-flight bond check -> 402 payment -> 249-byte receipt -> spec verify
  const handleSendRequest = useCallback(
    async (provider: ProviderConfig) => {
      if (!connected || !publicKey) {
        setVisible(true);
        toast({ type: "info", text: "Connect a Solana wallet first to execute a paid x402 call." });
        return;
      }

      if (provider.chainState && !isProviderInsured(provider.chainState)) {
        toast({
          type: "error",
          text: `${provider.name} is Under-Bonded (${availableBondSol(provider.chainState).toFixed(4)} SOL available < ${MIN_INSURED_BOND_SOL.toFixed(2)} SOL). Provider must Top Up Bond first.`,
        });
        return;
      }

      update({
        selectedWallet: provider.wallet,
        loading: true,
        stageLabel: "Fetching service spec & querying x402 endpoint…",
        paymentTxSig: null,
        responseData: null,
        receipt: null,
        receiptBase64: "",
        signatureBase64: "",
        needsProviderSig: false,
        specJson: "",
        verifyResult: null,
        disputeTxSig: null,
        disputePda: null,
        arbiterResult: null,
      });

      try {
        let specJson = provider.specJson || "";
        if (!specJson) {
          const specRes = await fetch(`${DEFAULT_PROVIDER_URL}/spec`);
          if (!specRes.ok) throw new Error(`Failed to fetch /spec (${specRes.status})`);
          specJson = await specRes.text();
        }

        const sep = provider.endpoint.includes("?") ? "&" : "?";
        const simParam =
          provider.badge === "community" && provider.hostedProxy && state.simulateLie
            ? "&simulate=lie"
            : "";
        const targetUrl = `${provider.endpoint}${sep}buyer=${publicKey.toBase58()}${simParam}`;

        let reply = await fetchX402Endpoint(targetUrl);
        let paymentTxSig: string | null = null;

        if (reply.status === 402) {
          const challenge = reply.paymentRequiredHeader
            ? JSON.parse(atob(reply.paymentRequiredHeader))
            : reply.body;

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

          reply = await fetchX402Endpoint(targetUrl, paymentProofB64);
        }

        if (reply.status < 200 || reply.status >= 300) {
          throw new Error(reply.body?.error || `API returned HTTP ${reply.status}`);
        }

        const body = reply.body || {};
        const data = body.data || body;
        const receiptB64 = body.receipt?.bytesBase64 || reply.receiptHeader || "";
        let sigB64 = body.receipt?.signatureBase64 || reply.signatureHeader || "";
        const needsProviderSig = Boolean(body.receipt?.needsProviderSignature && !sigB64);
        const effectivePaySig = paymentTxSig || body.payment?.txSignature || null;
        if (body.specJson) specJson = body.specJson;

        if (!receiptB64) {
          throw new Error("Provider response missing 249-byte canonical receipt");
        }

        const receipt = decodeReceiptBrowser(receiptB64);

        const rawBytes = new TextEncoder().encode(JSON.stringify(data));
        const verifyResult = await verifyResponseAgainstSpec({
          specJson: specJson || DEFAULT_WEATHER_SPEC_TEMPLATE,
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
          needsProviderSig,
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

        toast({
          type: verifyResult.isValid ? "success" : "warning",
          text: verifyResult.isValid
            ? `${provider.name}: Paid & verified PASS`
            : `${provider.name}: Paid & caught ${verifyResult.errors.length} spec violation(s)!`,
        });
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
    [
      connected,
      publicKey,
      state.simulateLie,
      setVisible,
      connection,
      sendTransaction,
      explorerTx,
      pushTimelineRun,
      toast,
    ]
  );

  // Allow owner of a Hosted Test Route provider to sign the 249-byte canonical receipt directly via signMessage
  const handleCoSignTestReceipt = useCallback(async () => {
    if (!publicKey || !state.receiptBase64 || !signMessage) {
      toast({ type: "error", text: "Connected wallet does not support off-chain message signing." });
      return;
    }
    try {
      const raw = Uint8Array.from(atob(state.receiptBase64), (c) => c.charCodeAt(0));
      const sig = await signMessage(raw);
      const sigB64 = btoa(String.fromCharCode(...Array.from(sig)));
      update({ signatureBase64: sigB64, needsProviderSig: false });
      toast({ type: "success", text: "Provider wallet Ed25519 signature attached!" });
    } catch (err: any) {
      toast({ type: "warning", text: err?.message || "Signature cancelled" });
    }
  }, [publicKey, state.receiptBase64, signMessage, toast]);

  // Step 3: Open dispute in split steps so Ed25519 + open_dispute stays under 1232 bytes
  const handleOpenDispute = useCallback(async () => {
    if (!connected || !publicKey || !state.receipt || !state.responseData || !selectedProvider) {
      toast({ type: "error", text: "Connect wallet and execute an x402 API call first" });
      return;
    }
    if (!state.signatureBase64) {
      toast({
        type: "error",
        text: "Receipt has no Ed25519 signature yet. If testing your Hosted Test provider, click Co-Sign Receipt first.",
      });
      return;
    }

    const claimSol = Number(state.receipt.price) / 1e9;
    if (
      selectedProvider.chainState &&
      availableBondSol(selectedProvider.chainState) + 1e-9 < claimSol
    ) {
      toast({
        type: "error",
        text: `Provider bond too low (${availableBondSol(selectedProvider.chainState).toFixed(4)} SOL available < ${claimSol.toFixed(4)} SOL claim). Top up bond first.`,
      });
      return;
    }

    update({ disputeLoading: true });

    try {
      const { prepareTransaction, transaction, disputePda } =
        await buildOpenDisputeTransaction({
          connection,
          buyerPubkey: publicKey,
          receipt: state.receipt,
          signatureBase64: state.signatureBase64,
          responseData: state.responseData,
        });

      if (prepareTransaction) {
        toast({
          type: "info",
          text: "Step 1/2: Wrapping 0.01 SOL dispute deposit into wSOL…",
        });
        const prepSig = await sendTransaction(prepareTransaction, connection);
        await connection.confirmTransaction(
          {
            signature: prepSig,
            blockhash: prepareTransaction.recentBlockhash!,
            lastValidBlockHeight: prepareTransaction.lastValidBlockHeight!,
          },
          "confirmed"
        );
      }

      toast({
        type: "info",
        text: prepareTransaction
          ? "Step 2/2: Submitting Ed25519 + open_dispute transaction…"
          : "Submitting Ed25519 + open_dispute transaction…",
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

      // Cache evidence on backend so the Arbiter Portal can inspect it from any session
      fetch(`${DEFAULT_PROVIDER_URL}/arbiter/evidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          disputePda: disputePdaStr,
          responsePayload: state.responseData,
          receiptBase64: state.receiptBase64,
          specJson: state.specJson || undefined,
        }),
      }).catch(() => {});

      update({
        disputeLoading: false,
        disputeTxSig: txSig,
        disputePda: disputePdaStr,
      });

      pushTimelineRun({
        provider: selectedProvider,
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
  }, [
    connected,
    publicKey,
    state,
    selectedProvider,
    connection,
    sendTransaction,
    explorerTx,
    pushTimelineRun,
    toast,
    onRefresh,
  ]);

  // Step 4: Automated Arbiter Ruling
  const handleRequestArbiter = useCallback(async () => {
    if (!state.disputePda || !publicKey || !selectedProvider) return;

    update({ arbiterLoading: true });

    try {
      const res = await fetch(`${DEFAULT_PROVIDER_URL}/arbiter/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          disputePda: state.disputePda,
          responsePayload: state.responseData,
          receiptBase64: state.receiptBase64,
          specJson: state.specJson || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Arbiter returned HTTP ${res.status}`);
      }

      update({ arbiterLoading: false, arbiterResult: data });

      pushTimelineRun({
        provider: selectedProvider,
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
  }, [state, publicKey, selectedProvider, pushTimelineRun, toast, onRefresh]);

  const { receipt, verifyResult, responseData } = state;
  const decodedPayRefSig = receipt ? decodePaymentRefTxSig(receipt.paymentReference) : null;
  const selectedInsured = selectedProvider?.chainState
    ? isProviderInsured(selectedProvider.chainState)
    : true;
  const selectedAvailSol = selectedProvider?.chainState
    ? availableBondSol(selectedProvider.chainState)
    : 0;

  return (
    <section className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-sm font-semibold text-white">
              Live x402 Paid API Playground (0.01 SOL / call)
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Select any Devnet provider below, approve the x402 SOL payment, inspect the 249-byte Ed25519 receipt, and challenge lies on-chain.
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
          {providers.map((p) => {
            const badgeColors = {
              honest: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
              lying: "text-rose-300 border-rose-500/30 bg-rose-500/10",
              subtle: "text-amber-300 border-amber-500/30 bg-amber-500/10",
              community: "text-sky-300 border-sky-500/30 bg-sky-500/10",
            };
            const isSelected = selectedProvider?.wallet === p.wallet;
            const liveStats = p.chainState;
            const insured = liveStats ? isProviderInsured(liveStats) : false;
            const avail = liveStats ? availableBondSol(liveStats) : 0;

            return (
              <div
                key={p.wallet}
                onClick={() => !state.loading && update({ selectedWallet: p.wallet })}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (!state.loading) update({ selectedWallet: p.wallet });
                  }
                }}
                className={`text-left p-4 rounded-xl border transition-all cursor-pointer flex flex-col justify-between gap-3 ${
                  isSelected
                    ? "bg-zinc-800/80 border-emerald-500/50 ring-1 ring-emerald-500/20"
                    : "bg-zinc-900/40 border-white/10 hover:border-white/20 hover:bg-zinc-900/60"
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="font-display text-sm font-medium text-white truncate">
                      {p.name}
                    </span>
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.5 border rounded uppercase shrink-0 ${badgeColors[p.badge]}`}
                    >
                      {p.badge}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">{p.description}</p>
                </div>

                <div className="pt-2 border-t border-white/[0.06] space-y-1.5 text-[11px] font-mono">
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500">
                      {p.wallet.slice(0, 6)}…{p.wallet.slice(-4)}
                    </span>
                    {liveStats && (
                      <span className={insured ? "text-emerald-300" : "text-amber-300"}>
                        {insured ? "✓ Active / Insured" : "⚠ Under-Bonded"}
                      </span>
                    )}
                  </div>
                  {liveStats && (
                    <div className="flex items-center justify-between text-zinc-400 tabular-nums">
                      <span>Avail: {avail.toFixed(4)} SOL</span>
                      <span>
                        Slashed: {liveStats.disputesBuyerWon} ({liveStats.totalSlashedSol.toFixed(3)} SOL)
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {selectedProvider && (
          <div className="space-y-3 pt-1">
            {!selectedInsured && (
              <div className="bg-amber-950/40 border border-amber-500/40 rounded-lg p-3.5 text-xs font-mono text-amber-200 flex flex-wrap items-center justify-between gap-2">
                <span>
                  ⚠ <strong>Under-Bonded Provider</strong>: Available bond ({selectedAvailSol.toFixed(4)} SOL) is below the {MIN_INSURED_BOND_SOL.toFixed(2)} SOL insurance minimum. Paid calls are blocked until topped up.
                </span>
                <button
                  type="button"
                  onClick={onGoToProviders}
                  className="px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-amber-100 shrink-0"
                >
                  Top Up Bond →
                </button>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => handleSendRequest(selectedProvider)}
                disabled={state.loading || !selectedInsured}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-mono font-medium transition-colors disabled:opacity-50"
              >
                {state.loading
                  ? state.stageLabel || "Processing x402 request…"
                  : `⚡ Pay 0.01 SOL & Call ${selectedProvider.name}`}
              </button>

              {selectedProvider.badge === "community" && selectedProvider.hostedProxy && (
                <label className="inline-flex items-center gap-2 text-xs font-mono text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={state.simulateLie}
                    onChange={(e) => update({ simulateLie: e.target.checked })}
                    className="rounded border-white/20 bg-zinc-900"
                  />
                  <span>Simulate Spec Violation (`temperature=9999`)</span>
                </label>
              )}

              <span className="text-xs font-mono text-zinc-500 truncate">
                {selectedProvider.endpoint}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Results Area */}
      {responseData && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
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

                {state.needsProviderSig && (
                  <div className="bg-zinc-950/70 border border-amber-500/30 rounded-lg p-3 space-y-2 text-xs font-mono">
                    <p className="text-amber-200">
                      Hosted Test Route cannot forge your wallet&apos;s private key. If you own this provider wallet, co-sign the 249-byte receipt with Phantom/Solflare to enable on-chain Ed25519 disputes:
                    </p>
                    {publicKey && publicKey.equals(receipt.provider) && (
                      <button
                        type="button"
                        onClick={handleCoSignTestReceipt}
                        className="px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white text-xs"
                      >
                        ✍ Co-Sign 249-Byte Receipt with Wallet
                      </button>
                    )}
                  </div>
                )}

                {!state.disputeTxSig ? (
                  <button
                    type="button"
                    onClick={handleOpenDispute}
                    disabled={state.disputeLoading || !connected || !state.signatureBase64}
                    className={`w-full px-4 py-2.5 rounded-lg text-xs font-mono font-medium transition-colors ${
                      !verifyResult.isValid
                        ? "bg-rose-600 hover:bg-rose-500 text-white"
                        : "bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-white/10"
                    } disabled:opacity-50`}
                  >
                    {state.disputeLoading
                      ? "Submitting on Solana Devnet…"
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
                              href={
                                state.arbiterResult.explorerUrl ||
                                explorerTx(state.arbiterResult.txSignature)
                              }
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
                        {state.signatureBase64
                          ? `${state.signatureBase64.slice(0, 18)}…${state.signatureBase64.slice(-10)}`
                          : "Unsigned (awaiting co-sign)"}
                      </span>
                      {state.signatureBase64 && <CopyBtn value={state.signatureBase64} />}
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
                    {state.signatureBase64 && (
                      <div className="p-2 bg-zinc-950/60 rounded text-[10px] font-mono text-zinc-400 break-all">
                        <span className="text-zinc-500 block mb-0.5">X-Justice402-Signature:</span>
                        {state.signatureBase64}
                      </div>
                    )}
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

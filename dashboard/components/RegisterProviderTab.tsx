"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { DEFAULT_WEATHER_SPEC_TEMPLATE } from "../lib/providers-config";
import {
  buildRegisterProviderTransaction,
  getExistingWsolBalance,
  getProviderPda,
} from "../lib/dispute-client";
import { sha256, toHex } from "../lib/receipt-browser";
import { MIN_INSURED_BOND_SOL, OnChainProvider } from "../lib/solana";
import { useToast } from "./Toast";

const DEFAULT_PROVIDER_URL =
  process.env.NEXT_PUBLIC_PROVIDER_API_URL || "http://127.0.0.1:3402";
const ATA_RENT_LAMPORTS = 2_039_280n;

export default function RegisterProviderTab({
  onChainProviders,
  onRefresh,
  onGoToProviders,
  isLocalhostRpc,
}: {
  onChainProviders: OnChainProvider[];
  onRefresh: () => void;
  onGoToProviders: () => void;
  isLocalhostRpc: boolean;
}) {
  const { publicKey, connected, sendTransaction, signMessage } = useWallet();
  const { setVisible } = useWalletModal();
  const { connection } = useConnection();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [useHostedProxy, setUseHostedProxy] = useState(true);
  const [endpointUrl, setEndpointUrl] = useState("");
  const [description, setDescription] = useState("");
  const [specJson, setSpecJson] = useState(DEFAULT_WEATHER_SPEC_TEMPLATE);
  const [specHashHex, setSpecHashHex] = useState("");
  const [specError, setSpecError] = useState<string | null>(null);
  const [stakeSol, setStakeSol] = useState("0.05");
  const [submitting, setSubmitting] = useState(false);
  const [lastTxSig, setLastTxSig] = useState<string | null>(null);

  const existingProvider = publicKey
    ? onChainProviders.find((p) => p.wallet === publicKey.toBase58())
    : undefined;

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const parsed = JSON.parse(specJson);
        const canonical = JSON.stringify(parsed);
        const digest = await sha256(canonical);
        if (active) {
          setSpecHashHex(toHex(digest));
          setSpecError(null);
        }
      } catch (err: any) {
        if (active) {
          setSpecHashHex("");
          setSpecError(err?.message || "Invalid JSON specification");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [specJson]);

  const parsedStakeSol = parseFloat(stakeSol);
  const effectiveStakeSol = Number.isFinite(parsedStakeSol) ? parsedStakeSol : 0;
  const isUnderMinimumBond = effectiveStakeSol < MIN_INSURED_BOND_SOL;

  const explorerTx = (sig: string) =>
    isLocalhostRpc
      ? `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent("http://127.0.0.1:8899")}`
      : `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

  const handleRegister = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!connected || !publicKey) {
        setVisible(true);
        return;
      }
      if (!signMessage) {
        toast({
          type: "error",
          text: "Connected wallet must support signMessage to publish verified registry metadata.",
        });
        return;
      }
      if (specError) {
        toast({ type: "error", text: "Fix JSON errors in Spec / Schema before registering." });
        return;
      }
      if (!name.trim()) {
        toast({ type: "error", text: "Enter a Provider Name." });
        return;
      }
      if (!useHostedProxy && !/^https?:\/\//i.test(endpointUrl.trim())) {
        toast({
          type: "error",
          text: "Enter a valid http:// or https:// Endpoint URL, or choose Hosted Test Route.",
        });
        return;
      }
      if (!Number.isFinite(parsedStakeSol) || parsedStakeSol < 0) {
        toast({ type: "error", text: "Initial stake must be zero or positive." });
        return;
      }

      setSubmitting(true);
      setLastTxSig(null);

      try {
        const canonicalSpec = JSON.stringify(JSON.parse(specJson));
        const specHashBytes = await sha256(canonicalSpec);
        const computedSpecHashHex = toHex(specHashBytes);
        const bondLamports = BigInt(Math.round(parsedStakeSol * 1_000_000_000));
        const walletStr = publicKey.toBase58();

        const pda = getProviderPda(publicKey);
        const existingInfo = await connection.getAccountInfo(pda);

        let txSig: string | null = null;
        if (!existingInfo) {
          const [walletBal, wsolState] = await Promise.all([
            connection.getBalance(publicKey),
            getExistingWsolBalance(connection, publicKey),
          ]);
          const shortfallLamports =
            bondLamports > wsolState.existingWsol
              ? bondLamports - wsolState.existingWsol
              : 0n;
          const requiredNativeLamports =
            shortfallLamports + (wsolState.ataExists ? 0n : ATA_RENT_LAMPORTS) + 5_000_000n;

          if (BigInt(walletBal) < requiredNativeLamports) {
            throw new Error(
              `Insufficient native SOL (${(walletBal / 1e9).toFixed(4)} SOL; need ${(Number(requiredNativeLamports) / 1e9).toFixed(4)} SOL after counting ${(Number(wsolState.existingWsol) / 1e9).toFixed(4)} existing wSOL). Click "+ 1 SOL" first.`
            );
          }

          const { transaction } = await buildRegisterProviderTransaction({
            connection,
            providerWallet: publicKey,
            bondLamports,
            specHash: specHashBytes,
          });

          txSig = await sendTransaction(transaction, connection);
          const conf = await connection.confirmTransaction(
            {
              signature: txSig,
              blockhash: transaction.recentBlockhash!,
              lastValidBlockHeight: transaction.lastValidBlockHeight!,
            },
            "confirmed"
          );
          if (conf.value.err) {
            throw new Error(`Registration transaction failed: ${JSON.stringify(conf.value.err)}`);
          }
          setLastTxSig(txSig);
        }

        // Request single-use registry challenge and sign metadata ownership proof
        const chRes = await fetch(
          `${DEFAULT_PROVIDER_URL}/providers/registry/challenge?wallet=${encodeURIComponent(walletStr)}`
        );
        const chData = await chRes.json();
        if (!chRes.ok || !chData.nonce) {
          throw new Error(chData.error || "Failed to fetch registry challenge");
        }

        const resolvedEndpoint = useHostedProxy
          ? `/providers/hosted/${walletStr}`
          : endpointUrl.trim();
        const priceLamports = "10000000";

        const signedPayload = new TextEncoder().encode(
          JSON.stringify({
            action: "justice402-register-metadata",
            wallet: walletStr,
            name: name.trim().slice(0, 80),
            endpointUrl: resolvedEndpoint,
            specHash: computedSpecHashHex,
            priceLamports,
            nonce: String(chData.nonce),
          })
        );
        const sigBytes = await signMessage(signedPayload);
        const signatureBase64 = btoa(String.fromCharCode(...Array.from(sigBytes)));

        const regRes = await fetch(`${DEFAULT_PROVIDER_URL}/providers/registry`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wallet: walletStr,
            name: name.trim(),
            endpointUrl: useHostedProxy ? undefined : endpointUrl.trim(),
            specJson: canonicalSpec,
            hostedProxy: useHostedProxy,
            description: description.trim() || undefined,
            priceLamports,
            nonce: chData.nonce,
            signatureBase64,
          }),
        });
        const regData = await regRes.json();
        if (!regRes.ok) {
          throw new Error(regData.error || `Registry save failed (${regRes.status})`);
        }

        toast({
          type: "success",
          text: txSig
            ? `Provider "${name.trim()}" registered on Devnet with ${parsedStakeSol.toFixed(4)} SOL bond!`
            : `Updated public registry metadata for ${name.trim()}`,
          link: txSig ? { label: "Explorer", href: explorerTx(txSig) } : undefined,
        });

        onRefresh();
      } catch (err: any) {
        const msg = err?.message || "Provider registration failed";
        if (msg.toLowerCase().includes("user rejected")) {
          toast({ type: "warning", text: "Registration cancelled in wallet." });
        } else {
          toast({ type: "error", text: msg });
        }
      } finally {
        setSubmitting(false);
      }
    },
    [
      connected,
      publicKey,
      signMessage,
      specError,
      name,
      useHostedProxy,
      endpointUrl,
      parsedStakeSol,
      specJson,
      description,
      connection,
      sendTransaction,
      setVisible,
      toast,
      onRefresh,
    ]
  );

  return (
    <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      <div className="lg:col-span-8 bg-zinc-900/40 border border-white/10 rounded-xl p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-4">
          <div>
            <h2 className="font-display text-base font-semibold text-white">
              Register On-Chain API Provider
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Stake a SOL insurance bond directly from Phantom or Solflare and commit your API spec hash on Solana Devnet. Zero private keys are ever collected.
            </p>
          </div>
          {!connected && (
            <button
              type="button"
              onClick={() => setVisible(true)}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
            >
              Connect Wallet
            </button>
          )}
        </div>

        {existingProvider && (
          <div className="bg-amber-950/30 border border-amber-500/30 rounded-lg p-4 text-xs font-mono text-amber-200 flex flex-wrap items-center justify-between gap-3">
            <div>
              <strong>Wallet already registered on-chain!</strong> Staked Bond:{" "}
              {existingProvider.bondSol.toFixed(4)} SOL (Locked:{" "}
              {existingProvider.lockedSol.toFixed(4)} SOL). Need to add more bond?
            </div>
            <button
              type="button"
              onClick={onGoToProviders}
              className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-amber-100 transition-colors shrink-0"
            >
              Go to Top Up Bond →
            </button>
          </div>
        )}

        <form onSubmit={handleRegister} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="provider-wallet-input"
                className="block text-xs font-mono text-zinc-400 mb-1.5"
              >
                Provider Wallet (Connected Signer)
              </label>
              <input
                id="provider-wallet-input"
                type="text"
                readOnly
                value={publicKey ? publicKey.toBase58() : "Connect wallet in header…"}
                className="w-full px-3 py-2 rounded-lg bg-zinc-950/70 border border-white/10 text-xs font-mono text-zinc-300"
              />
            </div>

            <div>
              <label
                htmlFor="provider-name-input"
                className="block text-xs font-mono text-zinc-400 mb-1.5"
              >
                Provider Display Name *
              </label>
              <input
                id="provider-name-input"
                type="text"
                required
                placeholder="e.g., Pacific Weather Oracle"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-white/10 text-xs font-mono text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500/50"
              />
            </div>
          </div>

          <div role="group" aria-labelledby="endpoint-mode-label">
            <span
              id="endpoint-mode-label"
              className="block text-xs font-mono text-zinc-400 mb-1.5"
            >
              Endpoint Mode
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
              <button
                type="button"
                onClick={() => setUseHostedProxy(true)}
                className={`p-3 rounded-lg border text-left transition-colors ${
                  useHostedProxy
                    ? "bg-emerald-950/30 border-emerald-500/40 text-white"
                    : "bg-zinc-950/50 border-white/10 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <div className="text-xs font-mono font-medium">
                  Hosted Test Route (Instant Demo)
                </div>
                <div className="text-[11px] text-zinc-400 mt-0.5">
                  Uses Render `/providers/hosted/&lt;wallet&gt;` so you can test right away without deploying an API server.
                </div>
              </button>

              <button
                type="button"
                onClick={() => setUseHostedProxy(false)}
                className={`p-3 rounded-lg border text-left transition-colors ${
                  !useHostedProxy
                    ? "bg-emerald-950/30 border-emerald-500/40 text-white"
                    : "bg-zinc-950/50 border-white/10 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <div className="text-xs font-mono font-medium">Custom x402 API URL</div>
                <div className="text-[11px] text-zinc-400 mt-0.5">
                  Point visitors to your own HTTP/HTTPS x402 endpoint returning signed 249-byte receipts.
                </div>
              </button>
            </div>

            {!useHostedProxy ? (
              <div>
                <label htmlFor="custom-endpoint-input" className="sr-only">
                  Custom x402 API Endpoint URL
                </label>
                <input
                  id="custom-endpoint-input"
                  type="url"
                  required
                  placeholder="https://your-api.example.com/weather"
                  value={endpointUrl}
                  onChange={(e) => setEndpointUrl(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-white/10 text-xs font-mono text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500/50"
                />
              </div>
            ) : (
              <div className="px-3 py-2 rounded-lg bg-zinc-950/60 border border-white/10 text-xs font-mono text-emerald-300 truncate">
                {publicKey
                  ? `${DEFAULT_PROVIDER_URL}/providers/hosted/${publicKey.toBase58()}`
                  : `${DEFAULT_PROVIDER_URL}/providers/hosted/<your-wallet>`}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="initial-stake-input"
                className="block text-xs font-mono text-zinc-400 mb-1.5"
              >
                Initial Stake Amount (SOL) *
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="initial-stake-input"
                  type="number"
                  step="0.005"
                  min="0"
                  required
                  value={stakeSol}
                  onChange={(e) => setStakeSol(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-white/10 text-xs font-mono text-white focus:outline-none focus:border-emerald-500/50"
                />
                {["0.01", "0.05", "0.1"].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setStakeSol(preset)}
                    className="px-2 py-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-[11px] font-mono text-zinc-300 shrink-0"
                  >
                    {preset}
                  </button>
                ))}
              </div>
              {isUnderMinimumBond && (
                <p className="text-[11px] font-mono text-amber-300 mt-1">
                  ⚠ Stakes below {MIN_INSURED_BOND_SOL.toFixed(2)} SOL mark the provider Under-Bonded in Playground.
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="provider-desc-input"
                className="block text-xs font-mono text-zinc-400 mb-1.5"
              >
                Short Service Description
              </label>
              <input
                id="provider-desc-input"
                type="text"
                placeholder="e.g., High-frequency SolanaBeach weather metrics"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-white/10 text-xs font-mono text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500/50"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor="provider-spec-textarea"
                className="text-xs font-mono text-zinc-400"
              >
                Service Spec & JSON Schema Rules
              </label>
              <button
                type="button"
                onClick={() => setSpecJson(DEFAULT_WEATHER_SPEC_TEMPLATE)}
                className="text-[11px] font-mono text-zinc-400 hover:text-zinc-200 underline"
              >
                Reset Weather Template
              </button>
            </div>
            <textarea
              id="provider-spec-textarea"
              rows={9}
              value={specJson}
              onChange={(e) => setSpecJson(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg bg-zinc-950 border border-white/10 text-xs font-mono text-zinc-200 focus:outline-none focus:border-emerald-500/50"
            />
            {specError ? (
              <p className="text-xs font-mono text-rose-300 mt-1">✕ {specError}</p>
            ) : (
              <p className="text-[11px] font-mono text-emerald-300 mt-1 truncate">
                Deterministic SHA-256 spec_hash: {specHashHex}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={submitting || !!specError}
              className="px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-mono font-medium transition-colors disabled:opacity-50"
            >
              {submitting
                ? "Submitting on Devnet…"
                : existingProvider
                ? "Sign & Update Public Registry Metadata"
                : `Stake ${effectiveStakeSol.toFixed(4)} SOL & Register Provider`}
            </button>
            {lastTxSig && (
              <a
                href={explorerTx(lastTxSig)}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-mono text-emerald-300 hover:underline"
              >
                View Registration Tx ↗
              </a>
            )}
          </div>
        </form>
      </div>

      <aside className="lg:col-span-4 space-y-4">
        <div className="bg-zinc-900/50 border border-white/10 rounded-xl p-5 space-y-3">
          <h3 className="font-display text-sm font-semibold text-white">
            How Provider Bonding Works
          </h3>
          <ul className="text-xs text-zinc-400 space-y-2 leading-relaxed list-disc pl-4">
            <li>
              Your wallet signs <code className="font-mono text-zinc-200">register_provider</code> on Devnet, wrapping your initial SOL stake into the protocol vault.
            </li>
            <li>
              Your canonical <code className="font-mono text-zinc-200">spec_hash</code> is stored immutably on-chain so buyers and the arbiter can verify every response.
            </li>
            <li>
              Newly registered providers appear publicly in <strong>Providers</strong>, <strong>Live Playground</strong>, and the <strong>KPI Strip</strong>.
            </li>
            <li>
              If disputes slash your bond below <code className="font-mono text-zinc-200">0.01 SOL</code>, use <strong>Top Up Bond</strong> on the Providers tab to regain Insured status.
            </li>
          </ul>
        </div>
      </aside>
    </section>
  );
}

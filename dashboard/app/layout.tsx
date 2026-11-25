import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Justice402 — Insurance for x402 Payments on Solana",
  description: "Devnet accountability and insurance layer for HTTP x402 payment-required APIs on Solana.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        {/* Persistent Devnet Notice Banner */}
        <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2 text-center text-xs sm:text-sm font-semibold tracking-wide text-amber-300 flex items-center justify-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span>
          DEVNET DEMO, NO REAL FUNDS — Solved for Solana Devnet & x402 V2 Specifications
        </div>
        {children}
      </body>
    </html>
  );
}


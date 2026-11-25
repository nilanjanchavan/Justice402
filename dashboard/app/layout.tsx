import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Justice402 — Insurance for x402 Payments on Solana",
  description:
    "On-chain accountability and insurance layer for HTTP x402 payment-required APIs on Solana.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen font-sans text-zinc-100 antialiased selection:bg-emerald-500/30 selection:text-emerald-200">
        {/* Persistent Demo Notice Banner */}
        <div className="bg-amber-500/10 border-b border-amber-500/20 backdrop-blur-sm px-4 py-2 text-center text-xs font-medium tracking-wide text-amber-200/90 flex items-center justify-center gap-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
          <span>DEVNET / LOCALNET DEMO — NO REAL FUNDS AT RISK (x402 V2 + Solana)</span>
        </div>
        {children}
      </body>
    </html>
  );
}

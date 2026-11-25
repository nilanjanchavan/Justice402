import type { Metadata } from "next";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
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
        <meta name="color-scheme" content="dark" />
      </head>
      <body className="min-h-screen font-sans text-zinc-100 antialiased selection:bg-emerald-500/30 selection:text-emerald-200">
        {/* Persistent Demo Notice Banner */}
        <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-1.5 text-center text-[11px] font-mono tracking-wide text-amber-200/90 flex items-center justify-center gap-2">
          <span aria-hidden="true" className="text-amber-400">●</span>
          <span>DEVNET / LOCALNET DEMO — NO REAL FUNDS AT RISK</span>
        </div>
        {children}
      </body>
    </html>
  );
}

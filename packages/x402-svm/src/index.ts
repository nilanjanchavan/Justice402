import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";

export const DEVNET_NETWORK_ID = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export interface X402PaymentOptions {
  buyerSecretBytes: Uint8Array;
  targetUrl: string;
  rpcUrl?: string;
  networkId?: `${string}:${string}`;
  fetchOptions?: RequestInit;
}

export interface X402PaymentResult {
  status: number;
  bodyText: string;
  data?: any;
  paymentResponseHeader?: string | null;
  receiptBase64?: string;
  signatureBase64?: string;
}

export async function executeX402Payment(options: X402PaymentOptions): Promise<X402PaymentResult> {
  const {
    buyerSecretBytes,
    targetUrl,
    rpcUrl = "https://api.devnet.solana.com",
    networkId = DEVNET_NETWORK_ID,
    fetchOptions = {},
  } = options;

  const buyerSigner = await createKeyPairSignerFromBytes(buyerSecretBytes);

  const svmScheme = new ExactSvmScheme(buyerSigner, {
    rpcUrl,
  });

  const client = new x402Client().register(networkId, svmScheme);
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  const res = await fetchWithPayment(targetUrl, fetchOptions);
  const bodyText = await res.text();

  let data: any = undefined;
  try {
    data = JSON.parse(bodyText);
  } catch {
    // raw text
  }

  const paymentResponseHeader = res.headers.get("payment-response");
  const receiptBase64 = res.headers.get("x-justice402-receipt") || data?.receipt?.bytesBase64;
  const signatureBase64 = res.headers.get("x-justice402-signature") || data?.receipt?.signatureBase64;

  return {
    status: res.status,
    bodyText,
    data,
    paymentResponseHeader,
    receiptBase64,
    signatureBase64,
  };
}

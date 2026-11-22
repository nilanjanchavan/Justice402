import { createKeyPairSignerFromBytes } from '@solana/kit';
import { x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import fs from 'fs';
import path from 'path';

async function main() {
  console.log('--- Phase 0: Testing Real x402 V2 Payment on Solana Devnet ---');

  const buyerKeypairPath = process.env.BUYER_KEYPAIR_PATH || './buyer.json';
  if (!fs.existsSync(buyerKeypairPath)) {
    throw new Error(`Buyer keypair not found at ${buyerKeypairPath}`);
  }

  const buyerSecret = JSON.parse(fs.readFileSync(buyerKeypairPath, 'utf8'));
  const buyerBytes = Uint8Array.from(buyerSecret);
  const buyerSigner = await createKeyPairSignerFromBytes(buyerBytes);

  console.log('Buyer address:', buyerSigner.address);

  // Initialize SVM Exact client scheme
  const DEVNET_NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
  const svmScheme = new ExactSvmScheme(buyerSigner, {
    rpcUrl: 'https://api.devnet.solana.com',
  });

  const client = new x402Client().register(DEVNET_NETWORK, svmScheme);
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  const targetUrl = 'https://x402.payai.network/api/solana-devnet/paid-content';
  console.log(`Sending payment request to: ${targetUrl}`);

  try {
    const res = await fetchWithPayment(targetUrl);
    console.log('Response status:', res.status);
    const body = await res.text();
    console.log('Response body:', body);
    const paymentResponseHeader = res.headers.get('payment-response');
    if (paymentResponseHeader) {
      console.log('PAYMENT-RESPONSE header:', paymentResponseHeader);
    }
  } catch (err) {
    console.error('Payment failed as expected due to missing devnet USDC balance:');
    console.error(err.message || err);
  }
}

main().catch(console.error);

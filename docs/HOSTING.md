# Justice402 Provider API Hosting Guide

The Justice402 Provider API is a lightweight, stateless Node.js / Express service providing verifiable responses with provider-signed receipts.

---

## 1. Environment Configuration

All settings are driven strictly by environment variables:

| Variable | Description | Default |
|---|---|---|
| `PORT` / `PROVIDER_PORT` | HTTP port to listen on | `3402` |
| `PROVIDER_KEYPAIR_PATH` | Path to Solana keypair JSON | `./provider.json` |
| `PROVIDER_SEED` | Seed string for deterministic keypair | `justice402-devnet-honest-provider` |
| `DASHBOARD_ORIGIN` | Restrict CORS to dashboard domain | `*` (or Vercel URL) |
| `PRICE_USDC` | Price per query in base units (6 decimals) | `5000000` (5 USDC) |
| `SOLANA_RPC_URL` | Devnet RPC endpoint | `https://api.devnet.solana.com` |
| `FACILITATOR_URL` | x402 payment facilitator | `https://facilitator.x402.rs` |

---

## 2. Endpoints

- `GET /health` — Service health, uptime, provider public key, spec_hash, network.
- `GET /spec` — Off-chain service specification (JSON Schema, ranges, freshness).
- `GET /reference/weather` — Ground truth oracle endpoint (temperature: 24.5°C).
- `GET /weather` — Honest provider endpoint with signed receipts.
- `GET /weather-lying` — Gross liar test endpoint (range/schema violations).
- `GET /weather-plausible-wrong` — Subtle liar test endpoint (semantic contradiction).

---

## 3. Production Deployment Options

### Option A: Railway / Render / Fly.io (Procfile)
1. Fork or push the repo.
2. The included `Procfile` specifies:
   ```
   web: npm run start:provider
   ```
3. Add environment variables in the host dashboard (`PORT=8080`, `PROVIDER_SEED=...`, `DASHBOARD_ORIGIN=https://...`).
4. Set health check path to `/health`.

### Option B: Docker
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
COPY packages ./packages
COPY services ./services
COPY tsconfig.json ./
RUN npm install
RUN npm run build --workspaces
EXPOSE 3402
CMD ["npm", "run", "start:provider"]
```

---

## 4. Key Security & Resilience
- **Zero Key Logging**: Private keys and secret bytes are never logged or exposed in HTTP responses.
- **Rate Limiting**: Integrated sliding-window limiter rejects traffic exceeding 60 req/min per IP with HTTP `429 Too Many Requests`.
- **CORS Protection**: Access-Control headers are locked down to the configured dashboard domain.

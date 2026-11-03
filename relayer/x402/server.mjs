// Sample x402 paid API, built on @portastake/sdk: live PortaStake vault stats, 0.01 xUSD per request.
//
//   cd relayer && PAY_TO=0x... node x402/server.mjs        (facilitator must be running)
//
// Unpaid requests get HTTP 402 with the payment requirements; requests carrying a valid signed
// payment are answered and the payment is settled through the facilitator.
import express from 'express';
import { formatEther } from 'viem';
import { createPortaStake } from '@portastake/sdk/chain';
import { xusdPaywall, x402Cors } from '@portastake/sdk/x402/server';
import { RPC, API_PORT, FACILITATOR_URL, deployments } from './config.mjs';

const payTo = process.env.PAY_TO ?? deployments.deployer;
const PRICE = process.env.PRICE ?? '0.01'; // whole xUSD
const ps = createPortaStake({ rpc: RPC });

const app = express();
// Browser clients (the PortaStake web app) need CORS and must be able to read the x402 headers.
app.use(x402Cors((process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',')));
app.use(
  xusdPaywall({
    facilitatorUrl: FACILITATOR_URL,
    routes: {
      'GET /api/vault-stats': { price: PRICE, payTo, description: 'Live PortaStake Shield vault stats on Portaldot V3' },
    },
  }),
);

app.get('/api/vault-stats', async (_req, res) => {
  const s = await ps.stats();
  res.json({
    vault: ps.addresses.StakingVault,
    tvlPot: Number(formatEther(s.totalAssets)),
    stPotSupply: Number(formatEther(s.totalSupply)),
    targetRatePct: Number(s.targetRateBps) / 100,
    potPerStPot: Number(formatEther(s.exchangeRate)),
    at: new Date().toISOString(),
  });
});

app.listen(API_PORT, () => {
  console.log(`paid API → http://localhost:${API_PORT}/api/vault-stats  (${PRICE} xUSD → ${payTo})`);
});

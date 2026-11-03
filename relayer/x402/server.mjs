// Sample x402 paid API: live PortaStake vault stats, $0.01 in xUSD per request.
//
//   cd relayer && PAY_TO=0x... node x402/server.mjs        (facilitator must be running)
//
// Unpaid requests get HTTP 402 with the payment requirements; requests carrying a valid signed
// payment are answered and the payment is settled through the facilitator.
import express from 'express';
import { createPublicClient, http, parseAbi } from 'viem';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { portaldot, RPC, NETWORK, XUSD, XUSD_DOMAIN, API_PORT, FACILITATOR_URL, deployments } from './config.mjs';

const payTo = process.env.PAY_TO ?? deployments.deployer;
const PRICE = process.env.PRICE ?? '10000'; // 0.01 xUSD (6 decimals)

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL }))
  .register(NETWORK, new ExactEvmScheme());

const app = express();

// Browser clients (the PortaStake web app) need CORS, and must be able to read the x402 headers:
// PAYMENT-REQUIRED on the 402, PAYMENT-RESPONSE on the paid reply; they send PAYMENT-SIGNATURE.
const ORIGINS = (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',');
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, PAYMENT-SIGNATURE, X-PAYMENT, Access-Control-Expose-Headers');
    res.setHeader('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(
  paymentMiddleware(
    {
      'GET /api/vault-stats': {
        accepts: [
          {
            scheme: 'exact',
            network: NETWORK,
            payTo,
            price: { asset: XUSD, amount: PRICE, extra: XUSD_DOMAIN },
            maxTimeoutSeconds: 120,
          },
        ],
        description: 'Live PortaStake Shield vault stats on Portaldot V3',
        mimeType: 'application/json',
      },
    },
    resourceServer,
  ),
);

const pub = createPublicClient({ chain: portaldot, transport: http(RPC) });
const vaultAbi = parseAbi([
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function targetRateBps() view returns (uint256)',
]);

app.get('/api/vault-stats', async (_req, res) => {
  const vault = deployments.StakingVault;
  const [assets, supply, target] = await Promise.all(
    ['totalAssets', 'totalSupply', 'targetRateBps'].map((fn) => pub.readContract({ address: vault, abi: vaultAbi, functionName: fn })),
  );
  res.json({
    vault,
    tvlPot: Number(assets) / 1e18,
    stPotSupply: Number(supply) / 1e18,
    targetRatePct: Number(target) / 100,
    potPerStPot: supply > 0n ? Number(assets) / Number(supply) : 1,
    at: new Date().toISOString(),
  });
});

app.listen(API_PORT, () => {
  console.log(`paid API → http://localhost:${API_PORT}/api/vault-stats  (${Number(PRICE) / 1e6} xUSD → ${payTo})`);
});

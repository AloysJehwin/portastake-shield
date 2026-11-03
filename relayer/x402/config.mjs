// Shared settings for the x402 facilitator, paid API and client on Portaldot V3.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineChain } from 'viem';

const here = path.dirname(fileURLToPath(import.meta.url));

export const CHAIN_ID = 420420777;
export const NETWORK = `eip155:${CHAIN_ID}`; // CAIP-2 id used throughout x402
export const RPC = process.env.RPC ?? 'https://test-evm-rpc-v3.portaldot.dev';

export const portaldot = defineChain({
  id: CHAIN_ID,
  name: 'Portaldot V3',
  nativeCurrency: { name: 'tPOT', symbol: 'tPOT', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

export const deployments = JSON.parse(
  readFileSync(path.resolve(here, `../../contracts/deployments/${CHAIN_ID}.json`), 'utf8'),
);
export const XUSD = process.env.XUSD ?? deployments.xUSD;
if (!XUSD) throw new Error('xUSD address missing from deployments; deploy X402Dollar first');

// EIP-712 domain of X402Dollar. x402 clients sign against it, facilitators check it.
export const XUSD_DOMAIN = { name: 'x402 Test USD', version: '1' };

export const FACILITATOR_PORT = Number(process.env.FACILITATOR_PORT ?? 4020);
export const API_PORT = Number(process.env.API_PORT ?? 4021);
export const FACILITATOR_URL = process.env.FACILITATOR_URL ?? `http://localhost:${FACILITATOR_PORT}`;
export const API_URL = process.env.API_URL ?? `http://localhost:${API_PORT}`;

export const xusdAbi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'faucet', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
];

export function requireKey(name) {
  const k = process.env[name] ?? process.env.PRIVATE_KEY;
  if (!k) {
    console.error(`${name} (or PRIVATE_KEY) required`);
    process.exit(1);
  }
  return k.startsWith('0x') ? k : `0x${k}`;
}

// Shared settings for the relayer's x402 scripts. Chain, network and xUSD details come from @portastake/sdk.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NETWORK as SDK_NETWORK, CHAIN_ID as SDK_CHAIN_ID, XUSD_DOMAIN as SDK_DOMAIN, portaldotChain } from '@portastake/sdk/chain';

const here = path.dirname(fileURLToPath(import.meta.url));

export const CHAIN_ID = SDK_CHAIN_ID;
export const NETWORK = SDK_NETWORK; // CAIP-2 id used throughout x402
export const RPC = process.env.RPC ?? 'https://test-evm-rpc-v3.portaldot.dev';
export const portaldot = portaldotChain(RPC);

export const deployments = JSON.parse(
  readFileSync(path.resolve(here, `../../contracts/deployments/${CHAIN_ID}.json`), 'utf8'),
);
export const XUSD = process.env.XUSD ?? deployments.xUSD;
if (!XUSD) throw new Error('xUSD address missing from deployments; deploy X402Dollar first');

export const XUSD_DOMAIN = SDK_DOMAIN;

export const FACILITATOR_PORT = Number(process.env.FACILITATOR_PORT ?? 4020);
export const API_PORT = Number(process.env.API_PORT ?? 4021);
export const FACILITATOR_URL = process.env.FACILITATOR_URL ?? `http://localhost:${FACILITATOR_PORT}`;
export const API_URL = process.env.API_URL ?? `http://localhost:${API_PORT}`;

export function requireKey(name) {
  const k = process.env[name] ?? process.env.PRIVATE_KEY;
  if (!k) {
    console.error(`${name} (or PRIVATE_KEY) required`);
    process.exit(1);
  }
  return k.startsWith('0x') ? k : `0x${k}`;
}

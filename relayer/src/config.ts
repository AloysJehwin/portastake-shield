// Env, chain registry and deployment files.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const relayerRoot = path.resolve(here, '..');

if (existsSync(path.join(relayerRoot, '.env'))) process.loadEnvFile(path.join(relayerRoot, '.env'));

export const deploymentsDir = process.env.DEPLOYMENTS_DIR ?? path.resolve(relayerRoot, '../contracts/deployments');
export const stateFile = process.env.STATE_FILE ?? path.join(relayerRoot, '.state/state.json');

export type Chain = {
  key: string;
  name: string;
  chainId: number;
  hub?: boolean;
  rpc: string;
  /** Blocks to wait before trusting a log, or "finalized" for the node's finality tag. */
  finality: number | 'finalized';
  legacy?: boolean;
  logChunk: number;
};

export type BridgeDeployment = {
  /** This chain's TokenBridge, or on a wallet-custody chain the wallet that stands in for it. */
  TokenBridge: string;
  token: string;
  desk: string;
  deployBlock: number;
  custody?: 'wallet';
};

export function loadChains(): Chain[] {
  const file = process.env.BRIDGE_CHAINS_FILE ?? path.join(deploymentsDir, 'bridge-chains.json');
  const chains = JSON.parse(readFileSync(file, 'utf8')) as Chain[];
  return chains.map((c) => ({ ...c, rpc: process.env[`RPC_${c.chainId}`] ?? c.rpc }));
}

export function loadBridgeDeployment(chainId: number): BridgeDeployment | undefined {
  const file = path.join(deploymentsDir, `bridge-${chainId}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as BridgeDeployment) : undefined;
}

export type HubAddresses = { StakingVault: string; SwapDesk: string; tUSD: string; WPOT: string };

export function loadHubAddresses(chainId: number): HubAddresses {
  return JSON.parse(readFileSync(path.join(deploymentsDir, `${chainId}.json`), 'utf8')) as HubAddresses;
}

export function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

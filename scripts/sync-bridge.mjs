#!/usr/bin/env node
// Sets up the bridge on every chain in bridge-chains.json without sending a transaction. Each chain's side
// is held by the relayer wallet: users bridge by sending it the chain's token with routing in the calldata,
// and the relayer (or the app's /api/bridge/claim function) pays out on the far side.
//
//   node scripts/sync-bridge.mjs                       # every chain
//   BRIDGE_WALLET=0x... node scripts/sync-bridge.mjs   # a different relayer wallet
//
// Writes contracts/deployments/bridge-<chainId>.json and copies them, with bridge-chains.json, into the
// frontend and SDK. Re-runnable: a chain that already has a file keeps its deployBlock.
//
// Env:
//   BRIDGE_WALLET   the relayer wallet (default: `relayer` from deployments/<hub chainId>.json)
//   RPC_<chainId>   RPC override; when a chain answers, its current head is recorded as deployBlock
//   DEPLOYMENTS_DIR, BRIDGE_CHAINS_FILE   overrides, as in the relayer
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const depsDir = process.env.DEPLOYMENTS_DIR ?? path.join(root, 'contracts/deployments');
const chainsFile = process.env.BRIDGE_CHAINS_FILE ?? path.join(depsDir, 'bridge-chains.json');
const copies = [path.join(root, 'frontend/src/deployments'), path.join(root, 'sdk/src/deployments')].filter(existsSync);

const chains = JSON.parse(readFileSync(chainsFile, 'utf8'));
const hub = chains.find((c) => c.hub);
if (!hub) throw new Error('bridge-chains.json has no hub chain');
const hubDeployment = JSON.parse(readFileSync(path.join(depsDir, `${hub.chainId}.json`), 'utf8'));
const wallet = process.env.BRIDGE_WALLET ?? hubDeployment.relayer ?? hubDeployment.deployer;
if (!/^0x[0-9a-fA-F]{40}$/.test(wallet ?? '')) throw new Error('set BRIDGE_WALLET to the relayer wallet');

const ZERO = '0x0000000000000000000000000000000000000000';

async function head(c) {
  try {
    const res = await fetch(process.env[`RPC_${c.chainId}`] ?? c.rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(8_000),
    });
    const { result } = await res.json();
    return result ? Number(BigInt(result)) : 0;
  } catch {
    return 0; // The relayer then starts a bounded distance back from the head.
  }
}

for (const c of chains) {
  const file = path.join(depsDir, `bridge-${c.chainId}.json`);
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  const token = c.hub ? hubDeployment.tUSD : c.token;
  if (!token) {
    console.log(`  ${c.key}: no token configured, skipping`);
    continue;
  }
  const deployment = {
    TokenBridge: wallet,
    token,
    tokenSymbol: c.tokenSymbol ?? (c.hub ? 'tUSD' : 'USDC'),
    tokenDecimals: 6,
    desk: c.hub ? hubDeployment.SwapDesk : ZERO,
    deployBlock: previous?.custody === 'wallet' && previous.deployBlock ? previous.deployBlock : await head(c),
    custody: 'wallet',
    ...(c.faucet ? { faucet: c.faucet } : {}),
  };
  writeFileSync(file, `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(`  ${c.key}: ${deployment.tokenSymbol} ${token}, held by ${wallet}`);
}

for (const dir of copies) {
  mkdirSync(dir, { recursive: true });
  for (const c of chains) {
    const file = path.join(depsDir, `bridge-${c.chainId}.json`);
    if (existsSync(file)) copyFileSync(file, path.join(dir, `bridge-${c.chainId}.json`));
  }
  copyFileSync(chainsFile, path.join(dir, 'bridge-chains.json'));
}
console.log(`bridge synced to ${copies.length} place(s)`);

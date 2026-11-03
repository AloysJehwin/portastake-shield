#!/usr/bin/env node
// Deploy TokenBridge and open hub <-> spoke routes. Uses `cast` for the reason given in deploy-cast.mjs.
//
//   PRIVATE_KEY=0x... BRIDGE_SIGNER=0x... node scripts/deploy-bridge.mjs portaldot base-sepolia arbitrum-sepolia
//
// With no chain names it deploys to every chain in bridge-chains.json. Each step checks the chain first, so
// re-running after a failure or adding a chain later continues without redeploying. Routes are hub-and-spoke:
// the hub (Portaldot) connects to every spoke, which keeps the tPOT spent on storage proportional to spoke count.
//
// Env (only PRIVATE_KEY and BRIDGE_SIGNER are required):
//   BRIDGE_THRESHOLD   signatures required (default 1)
//   BRIDGE_MAX_PER_TX  largest single transfer in tUSD base units (default 1000e6)
//   BRIDGE_INVENTORY   tUSD minted to each bridge so it can pay out (default 100000e6)
//   DEPLOYMENTS_DIR, BRIDGE_CHAINS_FILE, RPC_<chainId>   overrides, as in the relayer
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const contractsDir = path.resolve(here, '../contracts');
const outDir = path.join(contractsDir, 'out');
const depsDir = process.env.DEPLOYMENTS_DIR ?? path.join(contractsDir, 'deployments');
const chainsFile = process.env.BRIDGE_CHAINS_FILE ?? path.join(depsDir, 'bridge-chains.json');
const CAST = process.env.CAST ?? `${process.env.HOME ?? process.env.USERPROFILE}/.foundry/bin/cast`;

const PK = process.env.PRIVATE_KEY;
const SIGNER = process.env.BRIDGE_SIGNER;
if (!PK || !SIGNER) {
  console.error('PRIVATE_KEY and BRIDGE_SIGNER are required');
  process.exit(1);
}
const THRESHOLD = process.env.BRIDGE_THRESHOLD ?? '1';
const MAX_PER_TX = process.env.BRIDGE_MAX_PER_TX ?? '1000000000';
const INVENTORY = BigInt(process.env.BRIDGE_INVENTORY ?? '100000000000');
const ZERO = '0x0000000000000000000000000000000000000000';

const allChains = JSON.parse(readFileSync(chainsFile, 'utf8')).map((c) => ({
  ...c,
  rpc: process.env[`RPC_${c.chainId}`] ?? c.rpc,
}));
const names = process.argv.slice(2);
const unknown = names.filter((n) => !allChains.some((c) => c.key === n));
if (unknown.length) {
  console.error(`unknown chain(s): ${unknown.join(', ')}. Known: ${allChains.map((c) => c.key).join(', ')}`);
  process.exit(1);
}
const targets = names.length ? allChains.filter((c) => names.includes(c.key)) : allChains;
const hub = allChains.find((c) => c.hub);

function cast(args) {
  try {
    return execFileSync(CAST, args, { cwd: contractsDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 26 }).trim();
  } catch {
    // Never rethrow execFileSync's error: its message holds the full command line, private key included.
    throw new Error(`cast ${args[0]} failed (see the error above)`);
  }
}
const writeFlags = (c) => ['--rpc-url', c.rpc, '--private-key', PK, '--timeout', '180', ...(c.legacy ? ['--legacy'] : [])];
const read = (c, to, sig, ...args) => cast(['call', to, sig, ...args, '--rpc-url', c.rpc]).split(' ')[0];
const send = (c, to, sig, ...args) => cast(['send', to, sig, ...args, ...writeFlags(c)]);

function bytecode(name) {
  const file = path.join(outDir, `${name}.sol`, `${name}.json`);
  if (!existsSync(file)) {
    throw new Error(`${file} not found in ${readdirSync(outDir).length} artifacts. Run forge build first.`);
  }
  return JSON.parse(readFileSync(file, 'utf8')).bytecode.object;
}

function create(c, name, ctor, ...args) {
  const receipt = JSON.parse(cast(['send', ...writeFlags(c), '--json', '--create', bytecode(name), ctor, ...args]));
  if (receipt.status !== '0x1' && receipt.status !== 1) throw new Error(`${name} deploy reverted on ${c.key}`);
  console.log(`  ${name} ${receipt.contractAddress}`);
  return { address: receipt.contractAddress, block: Number(receipt.blockNumber) };
}

const deploymentPath = (c) => path.join(depsDir, `bridge-${c.chainId}.json`);
const loadDeployment = (c) => (existsSync(deploymentPath(c)) ? JSON.parse(readFileSync(deploymentPath(c), 'utf8')) : undefined);

function deployChain(c) {
  console.log(`${c.name} (${c.chainId})`);
  const deployer = cast(['wallet', 'address', '--private-key', PK]);
  let dep = loadDeployment(c);

  if (!dep) {
    let token;
    let desk = ZERO;
    if (c.hub) {
      const suite = JSON.parse(readFileSync(path.join(depsDir, `${c.chainId}.json`), 'utf8'));
      token = suite.tUSD;
      desk = suite.SwapDesk;
    } else {
      token = create(c, 'MockStable', 'constructor(address)', deployer).address;
    }
    const bridge = create(c, 'TokenBridge', 'constructor(address,address,address)', token, desk, deployer);
    dep = { TokenBridge: bridge.address, token, desk, deployBlock: bridge.block };
    writeFileSync(deploymentPath(c), `${JSON.stringify(dep, null, 2)}\n`);
  }

  if (read(c, dep.TokenBridge, 'threshold()(uint8)') === '0') {
    send(c, dep.TokenBridge, 'setSigner(address,bool)', SIGNER, 'true');
    send(c, dep.TokenBridge, 'setConfig(uint256,uint8,bool)', MAX_PER_TX, THRESHOLD, 'false');
    console.log('  configured');
  }
  const held = BigInt(read(c, dep.token, 'balanceOf(address)(uint256)', dep.TokenBridge));
  if (held < INVENTORY) {
    send(c, dep.token, 'mint(address,uint256)', dep.TokenBridge, (INVENTORY - held).toString());
    console.log(`  minted inventory up to ${INVENTORY}`);
  }
}

function setRoute(c, dep, remote, remoteDep) {
  const current = read(c, dep.TokenBridge, 'remotes(uint256)(address)', String(remote.chainId));
  if (current.toLowerCase() === remoteDep.TokenBridge.toLowerCase()) return;
  send(c, dep.TokenBridge, 'setRemote(uint256,address)', String(remote.chainId), remoteDep.TokenBridge);
  console.log(`  route ${c.key} -> ${remote.key}`);
}

for (const c of targets) deployChain(c);

const hubDep = hub && loadDeployment(hub);
if (!hubDep) {
  console.log('Hub is not deployed yet, so no routes were opened.');
  process.exit(0);
}
console.log('Routes');
for (const spoke of allChains.filter((c) => !c.hub)) {
  const spokeDep = loadDeployment(spoke);
  if (!spokeDep) continue;
  setRoute(hub, hubDep, spoke, spokeDep);
  setRoute(spoke, spokeDep, hub, hubDep);
}
console.log('Done. Run `pnpm sync-abis` in frontend/ to pick up the addresses.');

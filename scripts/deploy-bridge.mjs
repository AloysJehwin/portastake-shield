#!/usr/bin/env node
// Deploy TokenBridge to the other chains and point them at Portaldot. Uses `cast` for the reason in deploy-cast.mjs.
//
//   PRIVATE_KEY=0x... BRIDGE_SIGNER=0x... node scripts/deploy-bridge.mjs base-sepolia
//
// Sends NOTHING on Portaldot: there is no bridge contract there, because a deploy costs ~280 tPOT. The relayer's
// wallet holds Portaldot's side, so this only records its address and opens each chain's route to it. With no
// chain names it deploys to every chain in bridge-chains.json. Each step checks the chain first, so re-running
// after a failure or adding a chain later continues without redeploying.
//
// Env (only PRIVATE_KEY and BRIDGE_SIGNER are required):
//   BRIDGE_WALLET      the relayer's Portaldot wallet (default: the PRIVATE_KEY address)
//   BRIDGE_THRESHOLD   signatures required (default 1)
//   BRIDGE_MAX_PER_TX  largest single transfer in tUSD base units (default 10e6)
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
const MAX_PER_TX = process.env.BRIDGE_MAX_PER_TX ?? '10000000';
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
const targets = allChains.filter((c) => !c.hub && (!names.length || names.includes(c.key)));
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
    const token = create(c, 'MockStable', 'constructor(address)', deployer).address;
    const bridge = create(c, 'TokenBridge', 'constructor(address,address,address)', token, ZERO, deployer);
    dep = { TokenBridge: bridge.address, token, desk: ZERO, deployBlock: bridge.block };
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

/** Portaldot's "deployment" is a record of the wallet that stands in for a bridge there. Costs nothing. */
function recordHub() {
  const existing = loadDeployment(hub);
  if (existing) return existing;
  const suite = JSON.parse(readFileSync(path.join(depsDir, `${hub.chainId}.json`), 'utf8'));
  const wallet = process.env.BRIDGE_WALLET ?? cast(['wallet', 'address', '--private-key', PK]);
  const dep = {
    TokenBridge: wallet,
    token: suite.tUSD,
    desk: suite.SwapDesk,
    deployBlock: Number(cast(['block-number', '--rpc-url', hub.rpc])),
    custody: 'wallet',
  };
  writeFileSync(deploymentPath(hub), `${JSON.stringify(dep, null, 2)}\n`);
  console.log(`${hub.name}: bridge wallet ${wallet} (no transaction sent)`);
  return dep;
}

const hubDep = recordHub();
for (const c of targets) deployChain(c);

console.log('Routes');
for (const spoke of allChains.filter((c) => !c.hub)) {
  const spokeDep = loadDeployment(spoke);
  if (spokeDep) setRoute(spoke, spokeDep, hub, hubDep);
}
console.log('Done. Run `pnpm sync-abis` in frontend/ to pick up the addresses.');

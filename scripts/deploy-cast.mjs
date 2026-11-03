#!/usr/bin/env node
// Deploy PortaStake Shield stages 1-6 to Portaldot V3 via `cast`.
//
// Why not `forge script`: pallet-revive charges a Substrate storage deposit on
// contract creation that it folds into the EVM gas field (estimateGas returns
// ~1e15+). `forge script` submits with its own low internal EVM gas estimate and
// the node rejects the tx (error 1010 Invalid Transaction). `cast send` queries
// the node's own eth_estimateGas, which includes the storage deposit, and submits
// with the correct gas limit — so every creation and call goes through cast here.
//
// Each step is nonce-ordered and idempotent-ish: addresses already present in
// deployments/<chainId>.json are reused instead of redeployed. Re-running after a
// mid-way failure continues from where it stopped.
//
//   cd contracts && PRIVATE_KEY=0x... node ../scripts/deploy-cast.mjs
//
// Env (all optional except PRIVATE_KEY, same defaults as the .s.sol scripts):
//   PRIVATE_KEY  deployer key (required; sourced from contracts/.env)
//   RPC          default https://test-evm-rpc-v3.portaldot.dev
//   RELAYER / TREASURY / STAKING_ACCOUNT / ATTESTER  default: deployer
//   POT_PRICE    default 0.5e18
//   SEED_POT     default 1e18 (1 tPOT dead-shares seed)
//   DESK_POT     default 50e18
//   DESK_USD     default 100000e6
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const contractsDir = path.resolve(here, '../contracts');
const outDir = path.join(contractsDir, 'out');
const CAST = `${process.env.HOME}/.foundry/bin/cast`;

const RPC = process.env.RPC ?? 'https://test-evm-rpc-v3.portaldot.dev';
const PK = process.env.PRIVATE_KEY;
if (!PK) { console.error('PRIVATE_KEY required'); process.exit(1); }

const DEAD = '0x000000000000000000000000000000000000dEaD';
const POT_PRICE = process.env.POT_PRICE ?? '500000000000000000';   // 0.5e18
const SEED_POT  = process.env.SEED_POT  ?? '1000000000000000000';  // 1e18
const DESK_POT  = process.env.DESK_POT  ?? '50000000000000000000'; // 50e18
const DESK_USD  = process.env.DESK_USD  ?? '100000000000';         // 100000e6

// cast wrappers --------------------------------------------------------------
function cast(args, { capture = true } = {}) {
  return execFileSync(CAST, args, {
    cwd: contractsDir,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    maxBuffer: 1 << 26,
  }).trim();
}
const common = ['--rpc-url', RPC, '--legacy', '--private-key', PK, '--timeout', '180'];
// cast parses options per-subcommand, so the subcommand must come first and the
// shared flags after it: `cast send <args> --rpc-url …`, not `cast --rpc-url … send`.
const readFlags = ['--rpc-url', RPC];

function deployer() {
  return cast(['wallet', 'address', '--private-key', PK]);
}

function readBytecode(name) {
  const stack = [outDir];
  while (stack.length) {
    const dir = stack.pop();
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (e.name === `${name}.json`) {
        const j = JSON.parse(readFileSync(full, 'utf8'));
        const bc = j.bytecode?.object ?? j.bytecode;
        if (typeof bc === 'string' && bc.startsWith('0x')) return bc;
      }
    }
  }
  throw new Error(`no bytecode for ${name} — run forge build`);
}

// Deploy a contract; constructor args are abi-encoded and appended to initcode.
function deploy(name, sigTypes = [], args = []) {
  let initcode = readBytecode(name);
  if (sigTypes.length) {
    const enc = cast(['abi-encode', `constructor(${sigTypes.join(',')})`, ...args.map(String)]);
    initcode += enc.slice(2);
  }
  console.log(`→ deploying ${name} …`);
  const out = cast(['send', ...common, '--json', '--create', initcode]);
  const receipt = JSON.parse(out);
  const addr = receipt.contractAddress;
  if (!addr || receipt.status !== '0x1') throw new Error(`${name} deploy failed: ${out}`);
  console.log(`  ${name.padEnd(22)} ${addr}`);
  return addr;
}

function send(to, sig, args = [], value) {
  const a = ['send', to, sig, ...args.map(String), ...common, '--json'];
  if (value) a.push('--value', value);
  const r = JSON.parse(cast(a));
  if (r.status !== '0x1') throw new Error(`call ${sig} on ${to} reverted`);
  return r;
}

function call(to, sig, args = []) {
  return cast(['call', to, sig, ...args.map(String), ...readFlags]);
}

// deployments json -----------------------------------------------------------
const chainId = 420420777;
const jsonPath = path.join(contractsDir, 'deployments', `${chainId}.json`);
function loadAddrs() {
  if (!existsSync(jsonPath)) return {};
  try { return JSON.parse(readFileSync(jsonPath, 'utf8')); } catch { return {}; }
}
function saveAddrs(a) {
  mkdirSync(path.dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(a, null, 2) + '\n');
}

async function main() {
  const dep = deployer();
  const relayer = process.env.RELAYER ?? dep;
  const treasury = process.env.TREASURY ?? dep;
  const stakingAccount = process.env.STAKING_ACCOUNT ?? dep;
  const attester = process.env.ATTESTER ?? dep;
  const ZERO = '0x0000000000000000000000000000000000000000';

  const a = loadAddrs();
  // A valid (deployed) address is non-zero AND has code. The failed forge run left
  // computed-but-undeployed addresses in the file, so verify code before reusing.
  const hasCode = (addr) => {
    if (!addr || addr === ZERO) return false;
    const code = cast(['code', addr, '--rpc-url', RPC]);
    return code && code !== '0x';
  };
  const reuse = (key) => (hasCode(a[key]) ? (console.log(`• reuse ${key} ${a[key]}`), a[key]) : null);

  console.log(`deployer ${dep}  ·  rpc ${RPC}\n`);

  // ---- Stage 1: core ----
  const wpot = reuse('WPOT') ?? deploy('WPOT');
  a.WPOT = wpot; saveAddrs(a);

  const insurance = reuse('InsuranceFund') ?? deploy('InsuranceFund', ['address'], [wpot]);
  a.InsuranceFund = insurance; saveAddrs(a);

  const reserve = reuse('StabilizationReserve') ?? deploy('StabilizationReserve', ['address'], [wpot]);
  a.StabilizationReserve = reserve; saveAddrs(a);

  const vault = reuse('StakingVault') ??
    deploy('StakingVault', ['address', 'address', 'address', 'address', 'address', 'address'],
      [wpot, insurance, reserve, dep, treasury, stakingAccount]);
  a.StakingVault = vault; saveAddrs(a);

  // Wiring (idempotent: setVault reverts if already set, so guard by reading).
  const insVault = call(insurance, 'vault()');
  if (insVault.toLowerCase().endsWith('0000000000000000000000000000000000000000'))
    send(insurance, 'setVault(address)', [vault]);
  const resVault = call(reserve, 'vault()');
  if (resVault.toLowerCase().endsWith('0000000000000000000000000000000000000000'))
    send(reserve, 'setVault(address)', [vault]);

  const RELAYER_ROLE = call(vault, 'RELAYER_ROLE()');
  if (call(vault, 'hasRole(bytes32,address)', [RELAYER_ROLE, relayer]).endsWith('1') === false)
    send(vault, 'grantRole(bytes32,address)', [RELAYER_ROLE, relayer]);

  // Seed dead shares once (skip if totalSupply already > 0).
  const supply = BigInt(call(vault, 'totalSupply()'));
  if (supply === 0n) {
    console.log('→ seeding dead shares (1 tPOT) …');
    send(vault, 'depositNative(address)', [DEAD], SEED_POT);
  }
  console.log('✔ stage 1 complete\n');

  // ---- Stage 2: desk ----
  const tusd = reuse('tUSD') ?? deploy('MockStable', ['address'], [dep]);
  a.tUSD = tusd; saveAddrs(a);

  const desk = reuse('SwapDesk') ??
    deploy('SwapDesk', ['address', 'address', 'address', 'uint64'], [tusd, vault, dep, 86400]);
  a.SwapDesk = desk; saveAddrs(a);

  const FEEDER_ROLE = call(desk, 'FEEDER_ROLE()');
  if (call(desk, 'hasRole(bytes32,address)', [FEEDER_ROLE, relayer]).endsWith('1') === false)
    send(desk, 'grantRole(bytes32,address)', [FEEDER_ROLE, relayer]);
  if (BigInt(call(desk, 'price()')) === 0n) send(desk, 'setPrice(uint256)', [POT_PRICE]);

  // Seed inventory (skip if desk already holds tUSD).
  if (BigInt(call(tusd, 'balanceOf(address)', [desk])) === 0n)
    send(tusd, 'mint(address,uint256)', [desk, DESK_USD]);
  if (BigInt(call(wpot, 'balanceOf(address)', [desk])) === 0n) {
    send(wpot, 'deposit()', [], DESK_POT);
    send(wpot, 'transfer(address,uint256)', [desk, DESK_POT]);
  }
  console.log('✔ stage 2 complete\n');

  // ---- Stage 3: committee ----
  const committee = reuse('OracleCommittee') ??
    deploy('OracleCommittee', ['address', 'address'], [vault, dep]);
  a.OracleCommittee = committee; saveAddrs(a);

  const attList = call(committee, 'attesterList()');
  if (attList.toLowerCase().indexOf(attester.slice(2).toLowerCase()) === -1)
    send(committee, 'addAttester(address)', [attester]);
  if (BigInt(call(committee, 'threshold()')) !== 1n) send(committee, 'setThreshold(uint256)', [1]);

  const SLASHER_ROLE = call(vault, 'SLASHER_ROLE()');
  if (call(vault, 'hasRole(bytes32,address)', [SLASHER_ROLE, committee]).endsWith('1') === false)
    send(vault, 'grantRole(bytes32,address)', [SLASHER_ROLE, committee]);
  console.log('✔ stage 3 complete\n');

  // ---- Stage 4: coverage certificate + savings automation ----
  // SKIP_STAGE4=1 stops after stage 3.
  if (process.env.SKIP_STAGE4 !== '1') {
    const policy = reuse('PolicyNFT') ?? deploy('PolicyNFT', ['address'], [vault]);
    a.PolicyNFT = policy; saveAddrs(a);
    // Attach the certificate to the vault so new depositors receive one.
    if (call(vault, 'policy()(address)').toLowerCase() !== policy.toLowerCase())
      send(vault, 'setPolicy(address)', [policy]);

    const mandates = reuse('MandateManager') ??
      deploy('MandateManager', ['address', 'address', 'address'], [tusd, vault, desk]);
    a.MandateManager = mandates; saveAddrs(a);
    console.log('✔ stage 4 complete\n');
  }

  // ---- Stage 5: x402 payments token (xUSD, EIP-3009) ----
  // SKIP_X402=1 skips it.
  if (process.env.SKIP_X402 !== '1') {
    const xusd = reuse('xUSD') ?? deploy('X402Dollar');
    a.xUSD = xusd; saveAddrs(a);
    console.log('✔ stage 5 complete\n');
  }

  // ---- Stage 6: xUSD gateway into savings (needs stage 5) ----
  // Stock it afterwards: tUSD (mint) for deposits, xUSD (faucet) for withdrawals.
  if (process.env.SKIP_X402 !== '1' && a.xUSD) {
    const gw = reuse('XusdGateway') ??
      deploy('XusdGateway', ['address', 'address', 'address', 'address'], [a.xUSD, tusd, vault, desk]);
    a.XusdGateway = gw; saveAddrs(a);
    console.log('✔ stage 6 complete\n');
  }

  // Final metadata
  a.chainId = chainId;
  a.deployer = dep;
  a.relayer = relayer;
  a.stakingAccount = stakingAccount;
  a.PolicyNFT ??= ZERO;
  a.MandateManager ??= ZERO;
  saveAddrs(a);

  console.log('=== deployed ===');
  for (const k of ['WPOT', 'tUSD', 'InsuranceFund', 'StabilizationReserve', 'StakingVault', 'SwapDesk', 'OracleCommittee', 'PolicyNFT', 'MandateManager', 'xUSD', 'XusdGateway'])
    console.log(`  ${k.padEnd(22)} ${a[k]}`);
}

await main();

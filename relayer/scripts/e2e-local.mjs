// End-to-end bridge test on three local chains: real contracts, the real deploy script, the real relayer.
//
//   cd contracts && forge build && cd ../relayer && npm run e2e:bridge
//
// Writes nothing to the repo except a temporary contracts/deployments/31337.json from DeployAll, removed on exit.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const here = path.dirname(fileURLToPath(import.meta.url));
const relayerDir = path.resolve(here, '..');
const repo = path.resolve(relayerDir, '..');
const contractsDir = path.join(repo, 'contracts');
const foundry = `${process.env.HOME ?? process.env.USERPROFILE}/.foundry/bin`;
const tmp = mkdtempSync(path.join(tmpdir(), 'portastake-e2e-'));
const suiteFile = path.join(contractsDir, 'deployments/31337.json');

// Anvil's public default dev keys.
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const RELAYER = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const SIGNER = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ea870594951c6ee4b8e9a57';
const MARIA = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';

const CHAINS = [
  { key: 'hub', name: 'Hub', chainId: 31337, hub: true, legacy: true, port: 18545, finality: 0, logChunk: 1000 },
  { key: 'base', name: 'Base', chainId: 84532, port: 18546, finality: 2, logChunk: 1000 },
  { key: 'arb', name: 'Arb', chainId: 421614, port: 18547, finality: 0, logChunk: 1000 },
].map((c) => ({ ...c, rpc: `http://127.0.0.1:${c.port}` }));

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function faucet(uint256)',
  'function mint(address,uint256)',
  'function transfer(address,uint256) returns (bool)',
];
const BRIDGE = [
  'function remotes(uint256) view returns (address)',
  'function bridge(uint256,address,uint256,uint256)',
  'function processed(bytes32) view returns (bool)',
  'function releaseId(uint256,uint64) pure returns (bytes32)',
];

const anvils = [];
const env = {
  ...process.env,
  DEPLOYMENTS_DIR: tmp,
  BRIDGE_CHAINS_FILE: path.join(tmp, 'bridge-chains.json'),
  STATE_FILE: path.join(tmp, 'state.json'),
  RELAYER_KEY: RELAYER,
  BRIDGE_SIGNER_KEYS: SIGNER,
  BRIDGE_MAX_PAYOUT: String(100_000n * 10n ** 6n),
  BRIDGE_DAILY_CAP: String(1_000_000n * 10n ** 6n),
  BRIDGE_TX_WAIT_MS: '3000',
};

const tsx = path.join(relayerDir, 'node_modules/tsx/dist/cli.mjs');
const relayerArgs = [tsx, 'src/index.ts', '--once', '--only=bridge'];

function runRelayer(extraEnv = {}) {
  return execFileSync(process.execPath, relayerArgs, { cwd: relayerDir, env: { ...env, ...extraEnv }, encoding: 'utf8' });
}

/** Runs the relayer until `until` is true, then kills it the hard way: a crash, with no cleanup. */
async function crashRelayerWhen(until) {
  const child = spawn(process.execPath, relayerArgs, { cwd: relayerDir, env: { ...env, BRIDGE_TX_WAIT_MS: '120000' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 300; i++) {
      if (await until()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the relayer never reached the crash point');
  } finally {
    child.kill('SIGKILL');
  }
}

const step = (name) => console.log(`\n--- ${name}`);
const ok = (msg) => console.log(`  ok: ${msg}`);

try {
  for (const c of CHAINS) {
    anvils.push(spawn(`${foundry}/anvil`, ['--port', String(c.port), '--chain-id', String(c.chainId), '--silent'], { stdio: 'ignore' }));
  }
  const providers = Object.fromEntries(
    CHAINS.map((c) => [c.key, new ethers.JsonRpcProvider(c.rpc, c.chainId, { staticNetwork: true, pollingInterval: 100, cacheTimeout: -1 })]),
  );
  for (const c of CHAINS) {
    for (let i = 0; ; i++) {
      try {
        await providers[c.key].getBlockNumber();
        break;
      } catch (e) {
        if (i > 50) throw e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  step('deploy');
  execFileSync(`${foundry}/forge`, ['script', 'script/DeployAll.s.sol', '--rpc-url', CHAINS[0].rpc, '--broadcast'], {
    cwd: contractsDir,
    env: { ...process.env, PRIVATE_KEY: DEPLOYER, RELAYER: new ethers.Wallet(RELAYER).address },
    stdio: 'ignore',
  });
  copyFileSync(suiteFile, path.join(tmp, '31337.json'));
  writeFileSync(env.BRIDGE_CHAINS_FILE, JSON.stringify(CHAINS));
  execFileSync(process.execPath, [path.join(repo, 'scripts/deploy-bridge.mjs')], {
    env: {
      ...env,
      PRIVATE_KEY: DEPLOYER,
      BRIDGE_SIGNER: new ethers.Wallet(SIGNER).address,
      BRIDGE_WALLET: new ethers.Wallet(RELAYER).address,
      BRIDGE_INVENTORY: String(1_000n * 10n ** 6n),
      BRIDGE_MAX_PER_TX: String(100_000n * 10n ** 6n),
    },
    stdio: 'ignore',
  });

  const suite = JSON.parse(readFileSync(path.join(tmp, '31337.json'), 'utf8'));
  const dep = (c) => JSON.parse(readFileSync(path.join(tmp, `bridge-${c.chainId}.json`), 'utf8'));
  const [hub, base, arb] = CHAINS;
  const wallet = (c, key) => new ethers.Wallet(key, providers[c.key]);
  const bridgeOn = (c, key = MARIA) => new ethers.Contract(dep(c).TokenBridge, BRIDGE, wallet(c, key));
  const tokenOn = (c, key = MARIA) => new ethers.Contract(dep(c).token, ERC20, wallet(c, key));
  const maria = new ethers.Wallet(MARIA).address;
  const vault = new ethers.Contract(suite.StakingVault, ERC20, providers.hub);
  const usd = (n) => BigInt(n) * 10n ** 6n;

  const hubWalletAddress = dep(hub).TokenBridge;
  const hubBalance = () => tokenOn(hub).balanceOf(hubWalletAddress);
  const pendingCount = () => Object.keys(JSON.parse(readFileSync(env.STATE_FILE, 'utf8')).pending).length;
  const fundHubWallet = async (n) => (await tokenOn(hub, DEPLOYER).mint(hubWalletAddress, usd(n))).wait();

  async function send(c, n, to, minShares) {
    const token = tokenOn(c);
    await (await token.approve(dep(c).TokenBridge, usd(n))).wait();
    await (await bridgeOn(c).bridge(to, maria, usd(n), minShares)).wait();
  }
  /** What the Bridge page sends: a tUSD transfer to the wallet with routing after the calldata. */
  async function sendOffHub(n, dstChainId, routeTo = maria) {
    const token = tokenOn(hub);
    const data = token.interface.encodeFunctionData('transfer', [hubWalletAddress, usd(n)]);
    const suffix = ethers.solidityPacked(['bytes4', 'uint64', 'address'], ['0x50534231', dstChainId, routeTo]).slice(2);
    await (await wallet(hub, MARIA).sendTransaction({ to: dep(hub).token, data: data + suffix })).wait();
  }
  for (const c of [base, arb]) await (await tokenOn(c).faucet(usd(1_000))).wait();
  await fundHubWallet(1_000);
  ok('hub suite + 2 spoke bridges deployed, hub wallet funded');

  const hubCode = await providers.hub.getCode(hubWalletAddress);
  assert.equal(hubCode, '0x', 'the hub side should be a plain wallet');
  assert.equal(await bridgeOn(base).remotes(hub.chainId), ethers.getAddress(hubWalletAddress));
  ok('no bridge contract on the hub, and spokes route to its wallet');

  step('Base -> Hub, save: waits for finality, then Maria holds stPOT');
  await send(base, 5, hub.chainId, 1n);
  runRelayer();
  assert.equal(await vault.balanceOf(maria), 0n, 'paid before the finality wait');
  ok('nothing paid before 2 confirmations');
  await providers.base.send('anvil_mine', ['0x3']);
  runRelayer();
  const firstShares = await vault.balanceOf(maria);
  assert.ok(firstShares > 0n, 'no stPOT after payout');
  assert.equal(await tokenOn(hub).balanceOf(maria), 0n, 'save should not leave tUSD behind');
  ok(`Maria holds ${ethers.formatEther(firstShares)} stPOT and no tUSD`);

  step('Arb -> Hub, no save: Maria receives plain tUSD');
  await send(arb, 7, hub.chainId, 0n);
  runRelayer();
  assert.equal(await tokenOn(hub).balanceOf(maria), usd(7));
  ok('Maria holds 7 tUSD on the hub');

  step('Hub -> Base: sending the wallet tUSD with routing attached');
  const baseBefore = await tokenOn(base).balanceOf(maria);
  await sendOffHub(3, base.chainId);
  runRelayer();
  assert.equal(await tokenOn(base).balanceOf(maria), baseBefore + usd(3));
  ok('Maria received 3 tUSD on Base');

  step('A transfer to the wallet with no routing is not bridged');
  const baseBeforePlain = await tokenOn(base).balanceOf(maria);
  await (await tokenOn(hub).transfer(hubWalletAddress, usd(1))).wait();
  const plainLog = runRelayer();
  assert.equal(await tokenOn(base).balanceOf(maria), baseBeforePlain);
  assert.match(plainLog, /no routing/);
  ok('kept as inventory and logged');

  step('Stale price: the save falls back to tUSD instead of getting stuck');
  await providers.hub.send('evm_increaseTime', [2 * 86_400]);
  await providers.hub.send('evm_mine', []);
  const usdBefore = await tokenOn(hub).balanceOf(maria);
  const sharesBefore = await vault.balanceOf(maria);
  await send(arb, 2, hub.chainId, 1n);
  const staleLog = runRelayer();
  assert.equal(await tokenOn(hub).balanceOf(maria), usdBefore + usd(2));
  assert.equal(await vault.balanceOf(maria), sharesBefore);
  assert.match(staleLog, /delivered as tUSD/);
  ok('paid 2 tUSD and logged why');

  step('Payout and daily limits hold the transfer without paying it');
  const beforeLimit = await tokenOn(hub).balanceOf(maria);
  await send(arb, 2, hub.chainId, 0n);
  const overLimit = runRelayer({ BRIDGE_MAX_PAYOUT: '1000000' });
  assert.match(overLimit, /payout limit/);
  assert.equal(await tokenOn(hub).balanceOf(maria), beforeLimit);
  const resetBackoff = () => {
    const state = JSON.parse(readFileSync(env.STATE_FILE, 'utf8'));
    for (const p of Object.values(state.pending)) p.nextTry = 0;
    writeFileSync(env.STATE_FILE, JSON.stringify(state));
  };
  resetBackoff();
  assert.match(runRelayer({ BRIDGE_DAILY_CAP: '1000000' }), /daily limit/);
  assert.equal(await tokenOn(hub).balanceOf(maria), beforeLimit);
  resetBackoff();
  runRelayer();
  assert.equal(await tokenOn(hub).balanceOf(maria), beforeLimit + usd(2));
  ok('held by both limits, then paid once they allowed it');

  step('Gas guard: refuses to spend the wallet below its tPOT reserve');
  const beforeReserve = await tokenOn(hub).balanceOf(maria);
  await send(arb, 1, hub.chainId, 0n);
  const hubEth = await providers.hub.getBalance(hubWalletAddress);
  const reserveLog = runRelayer({ BRIDGE_TPOT_RESERVE: String(hubEth / 10n ** 18n + 1n) });
  assert.match(reserveLog, /with the reserve/);
  assert.equal(await tokenOn(hub).balanceOf(maria), beforeReserve);
  resetBackoff();
  runRelayer();
  assert.equal(await tokenOn(hub).balanceOf(maria), beforeReserve + usd(1));
  ok('held by the guard, then paid');

  step('Out of inventory: stays pending, then delivers after a top-up');
  const inventory = await hubBalance();
  await (await tokenOn(arb).faucet(usd(1_000))).wait();
  await (await tokenOn(arb, DEPLOYER).mint(dep(arb).TokenBridge, usd(1_000))).wait();
  await (await tokenOn(arb).faucet(usd(1_000))).wait();
  await send(arb, 2_000, hub.chainId, 0n);
  const before = await tokenOn(hub).balanceOf(maria);
  const shortLog = runRelayer();
  assert.equal(await tokenOn(hub).balanceOf(maria), before);
  assert.match(shortLog, /will retry/);
  assert.equal(pendingCount(), 1);
  ok(`held with ${ethers.formatUnits(inventory, 6)} tUSD in the wallet`);
  await fundHubWallet(2_000);
  resetBackoff();
  runRelayer();
  assert.equal(await tokenOn(hub).balanceOf(maria), before + usd(2_000));
  ok('delivered once topped up');

  step('Crash after broadcast, state kept: the same signed payout confirms, nothing pays twice');
  const walletNonce = () => providers.hub.getTransactionCount(hubWalletAddress, 'latest');
  const mempoolHasPayout = async () => (await providers.hub.getTransactionCount(hubWalletAddress, 'pending')) > (await walletNonce());
  await send(arb, 4, hub.chainId, 0n);
  const beforeCrash = await tokenOn(hub).balanceOf(maria);
  await providers.hub.send('evm_setAutomine', [false]);
  await crashRelayerWhen(mempoolHasPayout);
  const crashed = JSON.parse(readFileSync(env.STATE_FILE, 'utf8'));
  assert.ok(crashed.inflight, 'the signed payout should be recorded before it is broadcast');
  assert.equal(pendingCount(), 1);
  assert.match(runRelayer(), /still unconfirmed/);
  assert.equal(await tokenOn(hub).balanceOf(maria), beforeCrash);
  await providers.hub.send('evm_mine', []);
  await providers.hub.send('evm_setAutomine', [true]);
  resetBackoff();
  runRelayer();
  assert.equal(await tokenOn(hub).balanceOf(maria), beforeCrash + usd(4));
  assert.equal(pendingCount(), 0);
  ok('paid exactly once');

  step('Crash, then the state file is lost while the payout is still in the mempool');
  await send(arb, 6, hub.chainId, 0n);
  const beforeLost = await tokenOn(hub).balanceOf(maria);
  await providers.hub.send('evm_setAutomine', [false]);
  await crashRelayerWhen(mempoolHasPayout);
  rmSync(env.STATE_FILE);
  assert.match(runRelayer(), /unconfirmed transaction/);
  assert.equal(await tokenOn(hub).balanceOf(maria), beforeLost);
  await providers.hub.send('evm_mine', []);
  await providers.hub.send('evm_setAutomine', [true]);
  assert.equal(await tokenOn(hub).balanceOf(maria), beforeLost + usd(6));
  rmSync(env.STATE_FILE);
  const afterLost = runRelayer();
  assert.match(afterLost, /already paid/);
  assert.equal(await tokenOn(hub).balanceOf(maria), beforeLost + usd(6));
  ok('the wallet refused to send, and the on-chain tag stopped a second payment');

  step('Restart with the state file wiped: every old transfer is rescanned, nothing pays twice');
  const snapshot = {
    hub: await tokenOn(hub).balanceOf(maria),
    base: await tokenOn(base).balanceOf(maria),
    shares: await vault.balanceOf(maria),
  };
  rmSync(env.STATE_FILE);
  const rescan = runRelayer();
  assert.match(rescan, /already paid/);
  assert.match(rescan, /already released/);
  assert.equal(await tokenOn(hub).balanceOf(maria), snapshot.hub);
  assert.equal(await tokenOn(base).balanceOf(maria), snapshot.base);
  assert.equal(await vault.balanceOf(maria), snapshot.shares);
  assert.equal(pendingCount(), 0);
  ok('balances unchanged');

  console.log('\nE2E PASSED');
} finally {
  for (const a of anvils) a.kill();
  if (existsSync(suiteFile)) rmSync(suiteFile);
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);

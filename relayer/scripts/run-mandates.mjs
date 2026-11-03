// Keeper pass for MandateManager: run every mandate that is due right now.
//
//   cd relayer && PRIVATE_KEY=0x... node scripts/run-mandates.mjs          # one pass
//   cd relayer && PRIVATE_KEY=0x... LOOP_SECS=60 node scripts/run-mandates.mjs   # keep running
//
// The keeper walks ids [0, nextId) with the contract's `isDue` view and calls
// `execute(id)` for each due one. The contract enforces every rule (due time,
// cooldown, run cap, expiry, threshold bound, slippage floor), so this script
// only decides *when* to call — never *how much*. A run that reverts (e.g. the
// owner revoked their allowance) leaves the mandate untouched; it is retried on
// the next pass, and skipped after MAX_RETRIES consecutive failures in this
// process so one broken mandate can't burn fees forever.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const here = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.RPC ?? 'https://test-evm-rpc-v3.portaldot.dev';
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 420420777);
const LOOP_SECS = Number(process.env.LOOP_SECS ?? 0);
const MAX_RETRIES = Number(process.env.MAX_RETRIES ?? 3);
const PK = process.env.PRIVATE_KEY;
if (!PK) {
  console.error('PRIVATE_KEY required (keeper EOA; any funded account works — execute is permissionless)');
  process.exit(1);
}

const deployments = JSON.parse(
  readFileSync(path.resolve(here, `../../contracts/deployments/${CHAIN_ID}.json`), 'utf8'),
);
const MANAGER = process.env.MANDATE_MANAGER ?? deployments.MandateManager;
if (!MANAGER || /^0x0+$/.test(MANAGER)) {
  console.error('MandateManager is not deployed on this chain yet');
  process.exit(1);
}

const ABI = [
  'function nextId() view returns (uint256)',
  'function isDue(uint256 id) view returns (bool due, uint256 amount)',
  'function execute(uint256 id) returns (uint256 shares)',
];

const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
const wallet = new ethers.Wallet(PK, provider);
const manager = new ethers.Contract(MANAGER, ABI, wallet);
const failures = new Map(); // id -> consecutive failures in this process

async function pass() {
  const n = Number(await manager.nextId());
  let ran = 0;
  for (let id = 0; id < n; id++) {
    if ((failures.get(id) ?? 0) >= MAX_RETRIES) continue;
    const [due, amount] = await manager.isDue(id);
    if (!due) continue;
    try {
      // revive folds its storage deposit into gas; let the node estimate it, as `cast` does.
      const gasLimit = await manager.execute.estimateGas(id);
      const tx = await manager.execute(id, { gasLimit, type: 0 });
      const rc = await tx.wait();
      failures.delete(id);
      ran++;
      console.log(`✔ mandate ${id}: moved ${ethers.formatUnits(amount, 6)} tUSD  (tx ${rc.hash})`);
    } catch (e) {
      const f = (failures.get(id) ?? 0) + 1;
      failures.set(id, f);
      const why = e?.shortMessage ?? e?.reason ?? e?.message ?? String(e);
      console.log(`✘ mandate ${id}: ${why.split('\n')[0]}  (attempt ${f}/${MAX_RETRIES})`);
    }
  }
  console.log(`pass done: ${ran} executed of ${n} mandates scanned`);
}

console.log(`keeper ${wallet.address} · MandateManager ${MANAGER}`);
await pass();
while (LOOP_SECS > 0) {
  await new Promise((r) => setTimeout(r, LOOP_SECS * 1000));
  await pass();
}

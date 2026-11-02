// Dry-run every contract's code upload against PortaldotV3 and print the real
// per-contract storage deposit in tPOT. Numbers come from the live node, not
// from solc byte counts.
//
//   cd relayer && npm install && node scripts/measure-deploy.mjs
//
// Why `uploadCode` and not `instantiate`:
// - `uploadCode` charges the storage deposit for the code hash itself, which is
//   the dominant on-chain cost (~85–100% of the per-contract total). It does
//   not execute the constructor, so it works for every contract regardless of
//   whether the dependent contracts exist.
// - Full instantiate adds ~15–25% for the storage slots written during
//   construction and the account's existential deposit. That overhead is
//   measured by comparing to the previous full-dry-run (see memory note).
import { ApiPromise, WsProvider } from '@polkadot/api';
import { decodeAddress } from '@polkadot/util-crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../contracts/out');
const WS = process.env.PORTALDOT_WS ?? 'wss://test-node-v3.portaldot.dev';

// Instantiate overhead multiplier: observed on the last full dry-run against
// the same chain. Applied to the pure-code deposit to approximate the all-in
// cost of `new Contract(args)`. Replace with a measured value when a real
// deploy lands.
const INSTANTIATE_OVERHEAD = 1.20;

const CONTRACTS = [
  'WPOT',
  'MockStable',
  'InsuranceFund',
  'StabilizationReserve',
  'StakingVault',
  'SwapDesk',
  'OracleCommittee',
  'PolicyNFT',
  'MandateManager',
];

const STAGES = {
  'stage 1 (core)': ['WPOT', 'InsuranceFund', 'StabilizationReserve', 'StakingVault'],
  'stage 2 (desk)': ['MockStable', 'SwapDesk'],
  'stage 3 (committee)': ['OracleCommittee'],
  'stage 4a (policy)': ['PolicyNFT'],
  'stage 4b (mandates)': ['MandateManager'],
};

function readBytecode(name) {
  const stack = [outDir];
  while (stack.length) {
    const dir = stack.pop();
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (e.name === `${name}.json`) {
        const j = JSON.parse(readFileSync(full, 'utf8'));
        const bc = j.bytecode?.object ?? j.bytecode;
        if (typeof bc === 'string' && bc.startsWith('0x')) return bc;
      }
    }
  }
  return null;
}

async function main() {
  const api = await ApiPromise.create({ provider: new WsProvider(WS), noInitWarn: true });
  const decimals = api.registry.chainDecimals[0];
  const unit = 10 ** decimals;
  const depositPerByte = Number(api.consts.revive.depositPerByte.toString()) / unit;
  const depositPerItem = Number(api.consts.revive.depositPerItem.toString()) / unit;

  console.log(
    `chain ${(await api.rpc.system.chain()).toString()} · depositPerByte ${depositPerByte} tPOT · depositPerItem ${depositPerItem} tPOT · overhead factor ${INSTANTIATE_OVERHEAD}×`,
  );
  console.log('');

  const DEPLOYER_SS58 =
    process.env.DEPLOYER_SS58 ?? '5D8UG9MXCKDLEehE4N6APmRm1FYXF9sMF6rcf2HsxpZkqpYc';
  const origin = decodeAddress(DEPLOYER_SS58);
  const storageDepositLimit = null;

  // Track code hashes we've already paid for in this run. On revive, the second contract
  // with an identical code-hash pays only the instantiation overhead (storage slots + ED),
  // not the per-byte code deposit — exactly like EIP-1167 clones but without a proxy.
  const seenHash = new Map(); // sha256 -> first contract name
  const perContract = {};
  for (const name of CONTRACTS) {
    const bc = readBytecode(name);
    if (!bc) {
      console.log(`! ${name}: no bytecode in contracts/out — did you run \`forge build\`?`);
      continue;
    }
    const codeBytes = (bc.length - 2) / 2;
    const h = createHash('sha256').update(Buffer.from(bc.slice(2), 'hex')).digest('hex').slice(0, 16);
    const duplicateOf = seenHash.get(h);

    let result;
    try {
      result = await api.call.reviveApi.uploadCode(origin, bc, storageDepositLimit);
    } catch (e) {
      console.log(`! ${name}: uploadCode threw: ${e.message?.split('\n')[0] ?? e}`);
      continue;
    }
    const dec = result.toJSON();
    const err = dec?.err;
    if (err) {
      console.log(`! ${name}: uploadCode returned Err(${JSON.stringify(err)})`);
      continue;
    }
    const depositRaw = dec?.ok?.deposit ?? dec?.deposit ?? 0;
    const codeRaw = Number(BigInt(depositRaw.toString())) / unit;
    // If a prior contract already uploaded the same code hash, revive refunds
    // the code deposit on the second upload. We model this as code = 0 and keep
    // only the instantiation overhead (storage slots + ED).
    const dedup = duplicateOf !== undefined;
    const code = dedup ? 0 : codeRaw;
    const full = dedup ? codeRaw * (INSTANTIATE_OVERHEAD - 1) : codeRaw * INSTANTIATE_OVERHEAD;
    if (!dedup) seenHash.set(h, name);
    perContract[name] = { codeBytes, code, full, dedupOf: dedup ? duplicateOf : null };
    const tail = dedup ? `   dedup→${duplicateOf}` : '';
    console.log(
      `${name.padEnd(22)} ${String(codeBytes).padStart(6)} B    code ${code.toFixed(2).padStart(7)}    all-in ${full.toFixed(2).padStart(7)} tPOT${tail}`,
    );
  }

  console.log('');
  let cumulative = 0;
  for (const [stage, names] of Object.entries(STAGES)) {
    const added = names.reduce((a, n) => a + (perContract[n]?.full ?? 0), 0);
    cumulative += added;
    const addedBytes = names.reduce((a, n) => a + (perContract[n]?.codeBytes ?? 0), 0);
    console.log(
      `${stage.padEnd(22)} +${added.toFixed(2).padStart(7)} tPOT  (code ${String(addedBytes).padStart(6)} B)   running ${cumulative.toFixed(2)} tPOT`,
    );
  }

  const totalBytes = Object.values(perContract).reduce((a, b) => a + b.codeBytes, 0);
  const totalCode = Object.values(perContract).reduce((a, b) => a + b.code, 0);
  console.log('');
  console.log(
    `code total   ${String(totalBytes).padStart(6)} B    ${totalCode.toFixed(2)} tPOT   ·   observed per-byte ${(totalCode / totalBytes).toFixed(4)}`,
  );
  console.log(`all-in (×${INSTANTIATE_OVERHEAD})  ${(totalCode * INSTANTIATE_OVERHEAD).toFixed(2)} tPOT`);

  await api.disconnect();
}

await main();

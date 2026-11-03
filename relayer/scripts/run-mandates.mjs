// Keeper for MandateManager, built on @portastake/sdk: run every mandate that is due right now.
//
//   cd relayer && PRIVATE_KEY=0x... node scripts/run-mandates.mjs                # one pass
//   cd relayer && PRIVATE_KEY=0x... LOOP_SECS=60 node scripts/run-mandates.mjs   # keep running
//
// The contract enforces every rule (due time, cooldown, run cap, expiry, threshold bound, slippage
// floor), so the keeper only decides *when* to call `execute(id)`, never *how much*. A run that
// reverts leaves the mandate untouched; it is retried next pass and skipped after MAX_RETRIES
// consecutive failures in this process.
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createPortaStake, runKeeperPass, portaldotChain, isDeployed } from '@portastake/sdk/chain';

const RPC = process.env.RPC ?? 'https://test-evm-rpc-v3.portaldot.dev';
const LOOP_SECS = Number(process.env.LOOP_SECS ?? 0);
const MAX_RETRIES = Number(process.env.MAX_RETRIES ?? 3);
const PK = process.env.PRIVATE_KEY;
if (!PK) {
  console.error('PRIVATE_KEY required (keeper EOA; any funded account works — execute is permissionless)');
  process.exit(1);
}

const account = privateKeyToAccount(PK.startsWith('0x') ? PK : `0x${PK}`);
const chain = portaldotChain(RPC);
const ps = createPortaStake({
  rpc: RPC,
  walletClient: createWalletClient({ account, chain, transport: http(RPC) }),
  addresses: process.env.MANDATE_MANAGER ? { MandateManager: process.env.MANDATE_MANAGER } : {},
});
if (!isDeployed(ps.addresses.MandateManager)) {
  console.error('MandateManager is not deployed on this chain yet');
  process.exit(1);
}

const failures = new Map();
const log = (l) => console.log(l);
console.log(`keeper ${account.address} · MandateManager ${ps.addresses.MandateManager}`);
await runKeeperPass(ps, { failures, maxRetries: MAX_RETRIES, log });
while (LOOP_SECS > 0) {
  await new Promise((r) => setTimeout(r, LOOP_SECS * 1000));
  await runKeeperPass(ps, { failures, maxRetries: MAX_RETRIES, log });
}

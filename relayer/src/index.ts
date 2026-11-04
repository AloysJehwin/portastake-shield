// Relayer entry point.
//
//   npm start                                 run every job forever
//   npm run check                             one read-only pass, sends nothing
//   npm start -- --only=bridge --once         pick jobs: bridge, price, staking
import { stateFile } from './config.ts';
import { BridgeRelayer } from './bridge/relay.ts';
import { errorText } from './evm.ts';
import { StakingJobs } from './staking/jobs.ts';
import { Store } from './state.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const once = args.includes('--once');
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');
const enabled = (job: string) => !only || only.includes(job);

const store = new Store(stateFile);

// With `--once --dry-run` nothing should persist, so give that pass its own throwaway save.
if (dryRun) store.save = () => {};

const stakingJobs = enabled('price') || enabled('staking') ? new StakingJobs(store, dryRun) : undefined;
const bridge = enabled('bridge') ? new BridgeRelayer(store, dryRun) : undefined;

const jobs: { name: string; everyMs: number; run: () => Promise<void> }[] = [];
if (bridge) {
  console.log(`[bridge] watching ${bridge.chainCount} deployed chain(s)`);
  if (bridge.chainCount > 0) jobs.push({ name: 'bridge', everyMs: 15_000, run: () => bridge.tick() });
}
if (stakingJobs && enabled('price')) jobs.push({ name: 'price', everyMs: 5 * 60_000, run: () => stakingJobs.price() });
if (stakingJobs && enabled('staking')) jobs.push({ name: 'staking', everyMs: 10 * 60_000, run: () => stakingJobs.staking() });

async function runJob(job: (typeof jobs)[number]): Promise<boolean> {
  try {
    await job.run();
    return true;
  } catch (e) {
    console.error(`[${job.name}] failed: ${errorText(e)}`);
    return false;
  }
}

if (once) {
  let ok = true;
  for (const job of jobs) ok = (await runJob(job)) && ok;
  await stakingJobs?.disconnect();
  // A scheduler running `--once` needs the failure to show up.
  process.exit(ok ? 0 : 1);
}

for (const job of jobs) {
  // Each job reschedules itself after finishing, so slow RPCs never overlap two runs.
  const loop = async () => {
    await runJob(job);
    setTimeout(loop, job.everyMs);
  };
  void loop();
}

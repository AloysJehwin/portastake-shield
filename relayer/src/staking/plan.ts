// Pure decisions behind the staking jobs, kept apart from chain access so they can be unit tested.
import { ethers } from 'ethers';

export const NATIVE_UNIT = 10_000n; // 18-dp EVM wei per 14-dp planck (revive nativeToEthRatio)
const BPS = 10_000n;

/** How much hot WPOT can go to the stash while the vault keeps `targetHotBps` liquid. */
export function planSweep(a: { liquid: bigint; totalAssets: bigint; targetHotBps: bigint; minSweep: bigint }): bigint {
  const floor = (a.totalAssets * a.targetHotBps) / BPS;
  if (a.liquid <= floor) return 0n;
  const amount = a.liquid - floor;
  const rounded = amount - (amount % NATIVE_UNIT);
  return rounded >= a.minSweep ? rounded : 0n;
}

/** Stash balance available to bond. `keep` stays liquid for transaction fees. */
export function planBond(a: { transferable: bigint; keep: bigint; minBond: bigint }): bigint {
  const amount = a.transferable - a.keep;
  return amount >= a.minBond ? amount : 0n;
}

export type PriceDecision = { update: boolean; reason: string };

const MAX_JUMP_BPS = 5_000n;
const MIN_MOVE_BPS = 100n;

/**
 * Refreshes when the feed is half way to stale or the pool moved 1%. Refuses jumps over 50%: anyone can
 * move the testnet pool with a swap, and the desk trades at whatever price it is fed.
 */
export function decidePrice(a: { current: bigint; quote: bigint; age: bigint; maxAge: bigint }): PriceDecision {
  if (a.quote === 0n) return { update: false, reason: 'pool quote is zero' };
  if (a.current === 0n) return { update: true, reason: 'feed is unset' };
  const move = a.quote > a.current ? a.quote - a.current : a.current - a.quote;
  const moveBps = (move * BPS) / a.current;
  if (moveBps > MAX_JUMP_BPS) return { update: false, reason: `pool moved ${moveBps} bps, above the jump limit` };
  if (moveBps >= MIN_MOVE_BPS) return { update: true, reason: `pool moved ${moveBps} bps` };
  if (a.age * 2n >= a.maxAge) return { update: true, reason: `feed is ${a.age}s old` };
  return { update: false, reason: 'feed is fresh' };
}

/** pUSD (6 dp) received for 1 tPOT -> the desk's 18-dp USD-per-POT price. */
export function quoteToPrice(pusdPerPot: bigint): bigint {
  return pusdPerPot * 10n ** 12n;
}

/** The H160 that revive routes to an AccountId32. Must equal `vault.stakingAccount` or swept POT can't be bonded. */
export function h160OfAccount(accountId: Uint8Array): string {
  const isEthDerived = accountId.slice(20).every((b) => b === 0xee);
  const hex = isEthDerived ? ethers.hexlify(accountId.slice(0, 20)) : `0x${ethers.keccak256(accountId).slice(-40)}`;
  return ethers.getAddress(hex);
}

/** The AccountId32 revive gives an unmapped H160, which is where an EVM key's native balance lives. */
export function fallbackAccountOf(h160: string): string {
  return `${h160.toLowerCase()}${'ee'.repeat(12)}`;
}

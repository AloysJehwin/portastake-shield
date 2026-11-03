import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ethers } from 'ethers';
import { decidePrice, fallbackAccountOf, h160OfAccount, planBond, planSweep, quoteToPrice } from '../src/staking/plan.ts';

const E18 = 10n ** 18n;

test('planSweep keeps the hot reserve and rounds to native units', () => {
  const amount = planSweep({ liquid: 100n * E18 + 123n, totalAssets: 100n * E18, targetHotBps: 1_000n, minSweep: E18 });
  assert.equal(amount, 90n * E18 + 0n);
  assert.equal(amount % 10_000n, 0n);
});

test('planSweep does nothing at or below the floor, or under the minimum', () => {
  assert.equal(planSweep({ liquid: 10n * E18, totalAssets: 100n * E18, targetHotBps: 1_000n, minSweep: E18 }), 0n);
  assert.equal(planSweep({ liquid: 5n * E18, totalAssets: 100n * E18, targetHotBps: 1_000n, minSweep: E18 }), 0n);
  assert.equal(planSweep({ liquid: 10n * E18 + 1n, totalAssets: 100n * E18, targetHotBps: 1_000n, minSweep: E18 }), 0n);
});

test('planBond leaves the fee reserve', () => {
  assert.equal(planBond({ transferable: 10n, keep: 2n, minBond: 1n }), 8n);
  assert.equal(planBond({ transferable: 2n, keep: 2n, minBond: 1n }), 0n);
  assert.equal(planBond({ transferable: 1n, keep: 2n, minBond: 1n }), 0n);
});

test('decidePrice refreshes on age or a 1% move', () => {
  const base = { current: E18, maxAge: 86_400n };
  assert.equal(decidePrice({ ...base, quote: E18, age: 100n }).update, false);
  assert.equal(decidePrice({ ...base, quote: E18, age: 43_200n }).update, true);
  assert.equal(decidePrice({ ...base, quote: (E18 * 101n) / 100n, age: 100n }).update, true);
  assert.equal(decidePrice({ ...base, quote: (E18 * 99n) / 100n, age: 100n }).update, true);
});

test('decidePrice refuses a manipulated pool, even when the feed is old', () => {
  const base = { current: E18, maxAge: 86_400n, age: 90_000n };
  assert.equal(decidePrice({ ...base, quote: 2n * E18 }).update, false);
  assert.equal(decidePrice({ ...base, quote: E18 / 3n }).update, false);
  assert.equal(decidePrice({ ...base, quote: 0n }).update, false);
});

test('decidePrice accepts the first price', () => {
  assert.equal(decidePrice({ current: 0n, quote: E18, age: 0n, maxAge: 1n }).update, true);
});

test('quoteToPrice scales 6 dp pUSD to the 18 dp feed', () => {
  assert.equal(quoteToPrice(709_338n), 709_338_000_000_000_000n);
});

test('h160OfAccount hashes an sr25519 account', () => {
  const accountId = ethers.getBytes('0x3eb0b6e434f9b145770265e712e34cc5c20e818d80048c3d2becda360559413b');
  assert.equal(h160OfAccount(accountId).toLowerCase(), '0x5868ebff853c05e7fee6212f693b924af2bbc6ba');
});

test('h160OfAccount unwraps an eth-derived account, and fallbackAccountOf reverses it', () => {
  const h160 = '0x2f1B730cCa78f039072Caa56B3E3Ee64319F510E';
  const account = fallbackAccountOf(h160);
  assert.equal(account, '0x2f1b730cca78f039072caa56b3e3ee64319f510eeeeeeeeeeeeeeeeeeeeeeeee');
  assert.equal(h160OfAccount(ethers.getBytes(account)), h160);
});

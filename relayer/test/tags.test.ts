import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ethers } from 'ethers';
import {
  encodeBridgeOut,
  encodePayoutTag,
  findNestedBridgeOut,
  hubNonce,
  parseBridgeOut,
  parsePayoutTag,
  routeOfTransfer,
} from '../src/bridge/tags.ts';

const iface = new ethers.Interface(['function transfer(address,uint256)', 'function depositWithStable(uint256,uint256,address)']);
const wallet = '0x2f1B730cCa78f039072Caa56B3E3Ee64319F510E';
const user = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const transfer = iface.encodeFunctionData('transfer', [wallet, 5_000_000n]);

test('a bridge-out round-trips through transfer calldata', () => {
  const input = transfer + encodeBridgeOut({ dstChainId: 84532, to: user }).slice(2);
  assert.deepEqual(parseBridgeOut(input), { dstChainId: 84532, to: user });
});

test('parseBridgeOut rejects anything that is not a tagged transfer', () => {
  const suffix = encodeBridgeOut({ dstChainId: 84532, to: user }).slice(2);
  assert.equal(parseBridgeOut(transfer), undefined);
  assert.equal(parseBridgeOut(`${transfer}deadbeef`), undefined);
  assert.equal(parseBridgeOut(transfer + suffix.replace('50534231', '50534233')), undefined);
  assert.equal(parseBridgeOut(transfer + suffix.replace('50534231', '50534232')), undefined);
  assert.equal(parseBridgeOut(`0x12345678${transfer.slice(10)}${suffix}`), undefined);
  assert.equal(parseBridgeOut(transfer + encodeBridgeOut({ dstChainId: 84532, to: ethers.ZeroAddress }).slice(2)), undefined);
});

test('a payout tag round-trips after any call', () => {
  const id = ethers.id('some release');
  const tag = encodePayoutTag(id).slice(2);
  assert.equal(parsePayoutTag(transfer + tag), id);
  assert.equal(parsePayoutTag(iface.encodeFunctionData('depositWithStable', [1n, 1n, user]) + tag), id);
});

test('an untagged call has no payout tag', () => {
  assert.equal(parsePayoutTag(transfer), undefined);
  assert.equal(parsePayoutTag('0x'), undefined);
});

test('hubNonce is unique per log and fits a uint64', () => {
  assert.notEqual(hubNonce(100, 1), hubNonce(100, 2));
  assert.notEqual(hubNonce(100, 1), hubNonce(101, 1));
  assert.ok(hubNonce(2 ** 40, 65_535) < 2n ** 64n);
});

const token = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const bundler = '0xC066ac5D385419B1A8c43A0E146fA439837a8B8c';
const delegationManager = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3';
const nested = (route: string, value = 5_000_000n) =>
  `0xcef6d209${'00'.repeat(40)}${iface.encodeFunctionData('transfer', [wallet, value]).slice(2)}${route.slice(2)}${'00'.repeat(4)}`;
const incoming = (data: string, from = user, value = 5_000_000n) => ({
  tx: { to: delegationManager, from: bundler, data },
  token,
  wallet,
  from,
  value,
});

test('a real MetaMask delegated transfer yields its route', () => {
  const input = readFileSync(new URL('./fixtures/delegated-transfer.hex', import.meta.url), 'utf8').trim();
  assert.deepEqual(findNestedBridgeOut(input, wallet, 10_000_000n), {
    dstChainId: 420420777,
    to: wallet,
    minShares: 19840215445048331602n,
  });
  assert.equal(findNestedBridgeOut(input, wallet, 9_999_999n), undefined);
});

test('a nested transfer routes back to its sender, with or without a save tag', () => {
  const save = encodeBridgeOut({ dstChainId: 420420777, to: user, minShares: 7n });
  assert.deepEqual(routeOfTransfer(incoming(nested(save))), { dstChainId: 420420777, to: user, minShares: 7n });
  const plain = encodeBridgeOut({ dstChainId: 84532, to: user });
  assert.deepEqual(routeOfTransfer(incoming(nested(plain))), { dstChainId: 84532, to: user });
});

test('a nested transfer cannot pay out to someone other than its sender', () => {
  const attacker = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
  assert.equal(routeOfTransfer(incoming(nested(encodeBridgeOut({ dstChainId: 84532, to: attacker })))), undefined);
});

test('nested copies with different routes are ambiguous', () => {
  const a = nested(encodeBridgeOut({ dstChainId: 84532, to: user }));
  const b = nested(encodeBridgeOut({ dstChainId: 421614, to: user }));
  assert.equal(routeOfTransfer(incoming(a + b.slice(2))), undefined);
  assert.deepEqual(routeOfTransfer(incoming(a + a.slice(2))), { dstChainId: 84532, to: user });
});

test('a nested tag must follow a transfer of the logged amount to the wallet', () => {
  const route = encodeBridgeOut({ dstChainId: 84532, to: user });
  assert.equal(routeOfTransfer(incoming(nested(route), user, 4_000_000n)), undefined);
  const elsewhere = iface.encodeFunctionData('transfer', [user, 5_000_000n]);
  assert.equal(routeOfTransfer(incoming(`0xcef6d209${elsewhere.slice(2)}${route.slice(2)}`)), undefined);
});

test('the bridge wallet paying itself never earns a payout', () => {
  const route = encodeBridgeOut({ dstChainId: 84532, to: wallet });
  assert.equal(routeOfTransfer(incoming(nested(route), wallet)), undefined);
  const direct = { tx: { to: token, from: wallet, data: transfer + route.slice(2) }, token, wallet, from: wallet, value: 5_000_000n };
  assert.equal(routeOfTransfer(direct), undefined);
});

test('a direct transfer can route to any receiver, but only if the signer sent it', () => {
  const data = transfer + encodeBridgeOut({ dstChainId: 84532, to: bundler }).slice(2);
  const direct = { tx: { to: token, from: user, data }, token, wallet, from: user, value: 5_000_000n };
  assert.deepEqual(routeOfTransfer(direct), { dstChainId: 84532, to: bundler });
  assert.equal(routeOfTransfer({ ...direct, from: bundler }), undefined);
});

test('a save-on-arrival bridge-out carries its minimum shares', () => {
  const input = transfer + encodeBridgeOut({ dstChainId: 420420777, to: user, minShares: 123n }).slice(2);
  assert.deepEqual(parseBridgeOut(input), { dstChainId: 420420777, to: user, minShares: 123n });
  // A zero minimum is the plain tag.
  const plain = transfer + encodeBridgeOut({ dstChainId: 420420777, to: user, minShares: 0n }).slice(2);
  assert.deepEqual(parseBridgeOut(plain), { dstChainId: 420420777, to: user });
  // A save tag cut short is not a route.
  assert.equal(parseBridgeOut(input.slice(0, -2)), undefined);
});

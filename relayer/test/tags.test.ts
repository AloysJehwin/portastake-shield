import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ethers } from 'ethers';
import { encodeBridgeOut, encodePayoutTag, hubNonce, parseBridgeOut, parsePayoutTag } from '../src/bridge/tags.ts';

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

test('a save-on-arrival bridge-out carries its minimum shares', () => {
  const input = transfer + encodeBridgeOut({ dstChainId: 420420777, to: user, minShares: 123n }).slice(2);
  assert.deepEqual(parseBridgeOut(input), { dstChainId: 420420777, to: user, minShares: 123n });
  // A zero minimum is the plain tag.
  const plain = transfer + encodeBridgeOut({ dstChainId: 420420777, to: user, minShares: 0n }).slice(2);
  assert.deepEqual(parseBridgeOut(plain), { dstChainId: 420420777, to: user });
  // A save tag cut short is not a route.
  assert.equal(parseBridgeOut(input.slice(0, -2)), undefined);
});

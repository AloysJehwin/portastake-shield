// Portaldot has no bridge contract, so transfers carry their routing in extra calldata after the normal
// arguments. Solidity ignores trailing bytes, and they stay readable on-chain in the transaction's input.
import { ethers } from 'ethers';

const BRIDGE_OUT_MAGIC = '0x50534231'; // "PSB1": user -> relayer wallet, routing for a transfer to another chain
const BRIDGE_SAVE_MAGIC = '0x50534232'; // "PSB2": as PSB1, plus the minimum stPOT to save on arrival
const PAYOUT_MAGIC = '0x50534252'; // "PSBR": relayer wallet -> user, marks which transfer this pays
const TRANSFER_SELECTOR = ethers.id('transfer(address,uint256)').slice(0, 10);
const TRANSFER_CALLDATA_LENGTH = 4 + 32 + 32;

export type BridgeOut = { dstChainId: number; to: string; minShares?: bigint };

export function encodeBridgeOut({ dstChainId, to, minShares }: BridgeOut): string {
  if (minShares && minShares > 0n) {
    return ethers.solidityPacked(['bytes4', 'uint64', 'address', 'uint256'], [BRIDGE_SAVE_MAGIC, dstChainId, to, minShares]);
  }
  return ethers.solidityPacked(['bytes4', 'uint64', 'address'], [BRIDGE_OUT_MAGIC, dstChainId, to]);
}

/** The routing in a token `transfer` input, or undefined if this isn't a bridge-out transaction. */
export function parseBridgeOut(input: string): BridgeOut | undefined {
  const data = ethers.getBytes(input);
  if (ethers.hexlify(data.slice(0, 4)) !== TRANSFER_SELECTOR) return undefined;
  const suffix = data.slice(TRANSFER_CALLDATA_LENGTH);
  const magic = ethers.hexlify(suffix.slice(0, 4));
  const saving = magic === BRIDGE_SAVE_MAGIC;
  if (!saving && magic !== BRIDGE_OUT_MAGIC) return undefined;
  if (suffix.length !== 4 + 8 + 20 + (saving ? 32 : 0)) return undefined;
  const to = ethers.getAddress(ethers.hexlify(suffix.slice(12, 32)));
  if (to === ethers.ZeroAddress) return undefined;
  const route: BridgeOut = { dstChainId: Number(BigInt(ethers.hexlify(suffix.slice(4, 12)))), to };
  if (saving) route.minShares = BigInt(ethers.hexlify(suffix.slice(32, 64)));
  return route;
}

export function encodePayoutTag(id: string): string {
  return ethers.concat([PAYOUT_MAGIC, id]);
}

/** The release id a relayer payout's input is tagged with, or undefined if it has none. */
export function parsePayoutTag(input: string): string | undefined {
  const data = ethers.getBytes(input);
  if (data.length < 36) return undefined;
  const tail = data.slice(data.length - 36);
  if (ethers.hexlify(tail.slice(0, 4)) !== PAYOUT_MAGIC) return undefined;
  return ethers.hexlify(tail.slice(4));
}

/** Wallet-held sides have no counter for bridge-outs, so a transfer's position in the chain is its nonce. */
export function hubNonce(blockNumber: number, logIndex: number): bigint {
  return (BigInt(blockNumber) << 16n) | BigInt(logIndex);
}

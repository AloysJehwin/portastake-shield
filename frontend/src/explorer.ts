import { blake2b } from "@noble/hashes/blake2.js";
import { base58 } from "@scure/base";
import { hexToBytes, type Address } from "viem";

/**
 * Links into the Portaldot V3 explorer (a Substrate explorer).
 *
 * - Transactions: the explorer indexes Substrate blocks and extrinsics, not EVM
 *   transaction hashes, so an EVM transaction links to the page of the block that
 *   includes it (block number from the receipt).
 * - Addresses: pallet-revive maps an EVM address to the Substrate account
 *   `h160 ++ 0xEE × 12`, shown in SS58 (prefix 42). That account page lists its
 *   balance and extrinsics.
 */
export const EXPLORER_URL =
  (import.meta.env.VITE_EXPLORER_URL as string | undefined) ?? "https://scanner-testnet-v3.portaldot.dev";

const SS58_PREFIX = 42;

export function blockUrl(blockNumber: bigint | number): string {
  return `${EXPLORER_URL}/#/blocks/${blockNumber.toString()}`;
}

export function accountUrl(address: Address): string {
  return `${EXPLORER_URL}/#/accounts/${h160ToSs58(address)}`;
}

/** EVM address → its pallet-revive Substrate account, SS58-encoded. */
export function h160ToSs58(address: Address, prefix = SS58_PREFIX): string {
  const account = new Uint8Array(32).fill(0xee);
  account.set(hexToBytes(address), 0);
  const payload = new Uint8Array(1 + 32);
  payload[0] = prefix; // single-byte prefix (valid for 0..63)
  payload.set(account, 1);
  const pre = new TextEncoder().encode("SS58PRE");
  const hashInput = new Uint8Array(pre.length + payload.length);
  hashInput.set(pre, 0);
  hashInput.set(payload, pre.length);
  const checksum = blake2b(hashInput, { dkLen: 64 }).slice(0, 2);
  const full = new Uint8Array(payload.length + 2);
  full.set(payload, 0);
  full.set(checksum, payload.length);
  return base58.encode(full);
}

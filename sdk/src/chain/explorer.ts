import { blake2b } from "@noble/hashes/blake2.js";
import { base58 } from "@scure/base";
import { hexToBytes, type Address, type Hash, type PublicClient } from "viem";
import { DEFAULT_EXPLORER } from "../network.js";

/**
 * Links into the Portaldot V3 explorer, a Substrate explorer.
 *
 * - Transactions: the explorer indexes Substrate blocks and extrinsics, not EVM transaction
 *   hashes, so an EVM transaction links to the block that includes it.
 * - Addresses: pallet-revive maps an EVM address to the Substrate account `h160 ++ 0xEE × 12`,
 *   shown in SS58 (prefix 42). That account page lists its balance and extrinsics.
 */
export function blockUrl(blockNumber: bigint | number, explorer: string = DEFAULT_EXPLORER): string {
  return `${explorer}/#/blocks/${blockNumber.toString()}`;
}

export function accountUrl(address: Address, explorer: string = DEFAULT_EXPLORER): string {
  return `${explorer}/#/accounts/${h160ToSs58(address)}`;
}

/** Link for an EVM transaction: looks up its receipt and links the block it landed in. */
export async function txUrl(client: Pick<PublicClient, "getTransactionReceipt">, hash: Hash, explorer: string = DEFAULT_EXPLORER): Promise<string> {
  const receipt = await client.getTransactionReceipt({ hash });
  return blockUrl(receipt.blockNumber, explorer);
}

/** The Substrate account pallet-revive gives an EVM address: `h160 ++ 0xEE × 12`. */
export function h160ToAccountId(address: Address): Uint8Array {
  const account = new Uint8Array(32).fill(0xee);
  account.set(hexToBytes(address), 0);
  return account;
}

/** EVM address → its pallet-revive Substrate account, SS58-encoded (prefix 42 by default). */
export function h160ToSs58(address: Address, prefix = 42): string {
  if (prefix < 0 || prefix > 63) throw new Error("only single-byte SS58 prefixes (0..63) are supported");
  const payload = new Uint8Array(33);
  payload[0] = prefix;
  payload.set(h160ToAccountId(address), 1);
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

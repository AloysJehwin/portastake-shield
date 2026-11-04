import { formatEther, type Address, type PublicClient } from "viem";

/**
 * Helpers for sending transactions to Portaldot's EVM (pallet-revive).
 *
 * - Use legacy (type 0) transactions.
 * - Revive folds its storage deposit into gas, so let the node estimate gas for every call.
 * - The quoted gas limit × gas price must be covered by the sender's balance up front, so a
 *   fresh account needs roughly 10 tPOT before it can send anything.
 * - Deploying costs a storage deposit of about 0.0589 tPOT per byte of init code, plus about
 *   20% for the storage the constructor writes.
 */
export const LEGACY_TX = { type: "legacy" } as const;

/** tPOT per byte of init code, measured on Portaldot V3. */
export const DEPOSIT_PER_BYTE = 0.0589;
/** Extra cost of instantiating over uploading the code alone. */
export const INSTANTIATE_OVERHEAD = 1.2;

/** Approximate all-in tPOT cost of deploying a contract with `initcodeBytes` of init code. */
export function estimateDeployCost(initcodeBytes: number): number {
  return initcodeBytes * DEPOSIT_PER_BYTE * INSTANTIATE_OVERHEAD;
}

/** Init code length in bytes from a hex string or a Foundry artifact (`bytecode.object`). */
export function initcodeLength(code: string | { bytecode?: { object?: string } | string }): number {
  const hex = typeof code === "string" ? code : typeof code.bytecode === "string" ? code.bytecode : code.bytecode?.object;
  if (!hex) throw new Error("no bytecode found");
  return (hex.startsWith("0x") ? hex.length - 2 : hex.length) / 2;
}

/**
 * Balance an account needs before it can send this call: revive charges the quoted gas
 * limit × gas price up front. Returns wei.
 */
export async function upfrontCost(
  client: Pick<PublicClient, "estimateGas" | "getGasPrice">,
  call: { account: Address; to?: Address; data?: `0x${string}`; value?: bigint },
): Promise<bigint> {
  const [gas, price] = await Promise.all([client.estimateGas(call), client.getGasPrice()]);
  return gas * price + (call.value ?? 0n);
}

/** Native balance in tPOT, plus whether it can likely pay for a typical transaction (~10 tPOT). */
export async function balanceReport(client: Pick<PublicClient, "getBalance">, address: Address, minTpot = 10) {
  const wei = await client.getBalance({ address });
  const tpot = Number(formatEther(wei));
  return { address, wei, tpot, canTransact: tpot >= minTpot };
}

import type { Address } from "viem";
import { anvil, portaldot } from "./chains";

/**
 * Contract addresses by chain id. Each stage of the deploy writes into
 * `contracts/deployments/<chainId>.json`; this file imports those JSONs when
 * they exist, and otherwise leaves every address at zero so the UI still
 * renders (reads short-circuit, writes gate on `isReady`).
 */
export type Deployment = {
  WPOT: Address;
  tUSD: Address;
  InsuranceFund: Address;
  StabilizationReserve: Address;
  StakingVault: Address;
  SwapDesk: Address;
  PolicyNFT: Address;
  MandateManager: Address;
  OracleCommittee: Address;
  /** EIP-3009 stablecoin that x402 payments settle in. */
  xUSD: Address;
  /** Swaps xUSD in and out of savings through the SwapDesk. */
  XusdGateway: Address;
};

const zero = "0x0000000000000000000000000000000000000000" as Address;
const empty: Deployment = {
  WPOT: zero,
  tUSD: zero,
  InsuranceFund: zero,
  StabilizationReserve: zero,
  StakingVault: zero,
  SwapDesk: zero,
  PolicyNFT: zero,
  MandateManager: zero,
  OracleCommittee: zero,
  xUSD: zero,
  XusdGateway: zero,
};

// The deployments live in `contracts/deployments/<chainId>.json`. `pnpm sync-abis`
// copies them into `src/deployments/` so they ship with the frontend build. The
// placeholders here are `{}` until the first stage is actually broadcast; the
// `empty` fallback below keeps every unknown contract at the zero address.
import anvilJson from "./deployments/31337.json";
import portaldotJson from "./deployments/420420777.json";

export const deployments: Record<number, Deployment> = {
  [anvil.id]: { ...empty, ...(anvilJson as unknown as Partial<Deployment>) },
  [portaldot.id]: { ...empty, ...(portaldotJson as unknown as Partial<Deployment>) },
};

export function addressesFor(chainId: number): Deployment {
  return deployments[chainId] ?? empty;
}

export function isDeployed(address: Address): boolean {
  return address !== zero;
}

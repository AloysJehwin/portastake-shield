import { defineChain, type Address, type Chain } from "viem";
import portaldotV3 from "./deployments/420420777.json";

/** Portaldot V3 testnet EVM chain id. */
export const CHAIN_ID = 420420777 as const;
/** CAIP-2 network id, as x402 uses it. */
export const NETWORK = `eip155:${CHAIN_ID}` as const;
export const DEFAULT_RPC = "https://test-evm-rpc-v3.portaldot.dev";
export const DEFAULT_EXPLORER = "https://scanner-testnet-v3.portaldot.dev";

/** Portaldot V3 as a viem chain. Pass `rpc` to use your own endpoint. */
export function portaldotChain(rpc: string = DEFAULT_RPC): Chain {
  return defineChain({
    id: CHAIN_ID,
    name: "Portaldot V3",
    nativeCurrency: { name: "Portaldot test POT", symbol: "tPOT", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    blockExplorers: { default: { name: "Portaldot V3 explorer", url: DEFAULT_EXPLORER } },
    testnet: true,
  });
}

/** Portaldot V3 with the public RPC. */
export const portaldot: Chain = portaldotChain();

/** Every PortaStake contract address on a network. */
export type Addresses = {
  WPOT: Address;
  tUSD: Address;
  InsuranceFund: Address;
  StabilizationReserve: Address;
  StakingVault: Address;
  SwapDesk: Address;
  OracleCommittee: Address;
  PolicyNFT: Address;
  MandateManager: Address;
  xUSD: Address;
  XusdGateway: Address;
};

const KEYS: Array<keyof Addresses> = [
  "WPOT",
  "tUSD",
  "InsuranceFund",
  "StabilizationReserve",
  "StakingVault",
  "SwapDesk",
  "OracleCommittee",
  "PolicyNFT",
  "MandateManager",
  "xUSD",
  "XusdGateway",
];

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

function pick(raw: Record<string, unknown>): Addresses {
  const out = {} as Addresses;
  for (const k of KEYS) out[k] = (typeof raw[k] === "string" ? raw[k] : ZERO) as Address;
  return out;
}

const KNOWN: Record<number, Addresses> = { [CHAIN_ID]: pick(portaldotV3) };

/**
 * PortaStake addresses for `chainId`. Pass `overrides` to point at your own deployment
 * (for example a local anvil run). Unknown contracts read as the zero address.
 */
export function getAddresses(chainId: number = CHAIN_ID, overrides: Partial<Addresses> = {}): Addresses {
  const base = KNOWN[chainId];
  if (!base && Object.keys(overrides).length === 0) {
    throw new Error(`No PortaStake deployment known for chain ${chainId}; pass the addresses as overrides`);
  }
  return { ...(base ?? pick({})), ...overrides };
}

export function isDeployed(a: Address | undefined): a is Address {
  return !!a && a.toLowerCase() !== ZERO;
}

/** EIP-712 domain of xUSD (X402Dollar). x402 payers sign against it. */
export const XUSD_DOMAIN = { name: "x402 Test USD", version: "1" } as const;
export const XUSD_DECIMALS = 6;

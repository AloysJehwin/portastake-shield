import { defineChain } from "viem";

/** PortaldotV3 testnet — nativeToEthRatio = 10_000 maps 14-dp tPOT on Substrate to 18-dp on EVM. */
export const portaldot = defineChain({
  id: 420420777,
  name: "PortaldotV3",
  nativeCurrency: { name: "Portaldot test POT", symbol: "tPOT", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://test-evm-rpc-v3.portaldot.dev"] },
  },
  blockExplorers: {
    default: {
      name: "Portaldot V3 explorer",
      url: "https://scanner-testnet-v3.portaldot.dev",
    },
  },
  testnet: true,
});

export const anvil = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "tPOT (anvil)", symbol: "tPOT", decimals: 18 },
  rpcUrls: {
    default: { http: ["http://127.0.0.1:8545"] },
  },
  testnet: true,
});

/** Chains the app will talk to, in order of preference. */
export const supportedChains = [portaldot, anvil] as const;

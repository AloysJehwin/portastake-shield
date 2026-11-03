import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
  coinbaseWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { http, createConfig } from "wagmi";
import { anvil, portaldot, spokeChains } from "./chains";

/**
 * wagmi + RainbowKit configuration.
 *
 * RainbowKit's `getDefaultConfig` requires a WalletConnect projectId at import
 * time. We don't need WalletConnect for local dev (MetaMask / Rabby / Coinbase
 * extension cover it), so we build the connector list manually and only turn
 * on WalletConnect when `VITE_WALLETCONNECT_PROJECT_ID` is set in `.env.local`.
 */
const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "";

const connectors = connectorsForWallets(
  projectId
    ? [
        {
          groupName: "Popular",
          wallets: [metaMaskWallet, rainbowWallet, coinbaseWallet, walletConnectWallet, injectedWallet],
        },
      ]
    : [
        {
          groupName: "Popular",
          wallets: [metaMaskWallet, coinbaseWallet, injectedWallet],
        },
      ],
  {
    appName: "PortaStake Shield",
    // RainbowKit still passes projectId to connectors; a non-empty placeholder
    // avoids a throw when WalletConnect isn't in the wallet list anyway.
    projectId: projectId || "portastake-shield-local",
  },
);

export const wagmiConfig = createConfig({
  connectors,
  chains: [portaldot, anvil, ...spokeChains],
  transports: {
    // Batch multicall reads and retry transient revive RPC hiccups so the first
    // paint after connect doesn't fail on a flaky response.
    [portaldot.id]: http(portaldot.rpcUrls.default.http[0], { batch: true, retryCount: 2 }),
    [anvil.id]: http(anvil.rpcUrls.default.http[0]),
    ...Object.fromEntries(spokeChains.map((c) => [c.id, http(c.rpcUrls.default.http[0])])),
  },
  ssr: false,
});

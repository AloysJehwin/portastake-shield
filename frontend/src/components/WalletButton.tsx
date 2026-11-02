import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Wallet, ChevronDown, AlertTriangle } from "lucide-react";
import { shortAddress } from "../format";

/**
 * Minimal re-skin of RainbowKit's ConnectButton. All CTAs route through the
 * modal, we only control the trigger surface so it matches our tokens.
 */
export function WalletButton({ compact = false }: { compact?: boolean }) {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
        const ready = mounted;
        const connected = ready && account && chain;

        if (!connected) {
          return (
            <button onClick={openConnectModal} className="btn-primary w-full">
              <Wallet size={16} aria-hidden />
              {compact ? "Connect" : "Connect wallet"}
            </button>
          );
        }

        if (chain.unsupported) {
          return (
            <button onClick={openChainModal} className="btn btn-primary w-full bg-danger text-white hover:bg-danger/90">
              <AlertTriangle size={16} aria-hidden /> Wrong network
            </button>
          );
        }

        return (
          <div className={compact ? "flex gap-2" : "flex flex-col gap-2"}>
            {!compact && (
              <button onClick={openChainModal} className="btn-secondary justify-between">
                <span className="truncate">{chain.name}</span>
                <ChevronDown size={14} aria-hidden />
              </button>
            )}
            <button onClick={openAccountModal} className="btn-secondary justify-between">
              <span className="num">{shortAddress(account.address)}</span>
              <ChevronDown size={14} aria-hidden />
            </button>
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}

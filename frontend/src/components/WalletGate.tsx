import type { ReactNode } from "react";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Wallet } from "lucide-react";

/**
 * Disables every button, input and chip inside a page until a wallet is
 * connected. A disabled <fieldset> disables all its form-control descendants
 * natively, so individual controls don't each need to check the connection.
 * The connect prompt sits outside the fieldset so it stays clickable.
 */
export function WalletGate({ children, action = "continue" }: { children: ReactNode; action?: string }) {
  const { isConnected } = useAccount();
  return (
    <>
      {!isConnected && (
        <div className="card-glass flex flex-wrap items-center justify-between gap-3 p-4 mb-6">
          <p className="text-sm text-fg-muted">Connect your wallet to {action}.</p>
          <ConnectButton.Custom>
            {({ openConnectModal, mounted }) => (
              <button onClick={openConnectModal} disabled={!mounted} className="btn-primary">
                <Wallet size={16} /> Connect wallet
              </button>
            )}
          </ConnectButton.Custom>
        </div>
      )}
      <fieldset disabled={!isConnected} aria-disabled={!isConnected} className="m-0 min-w-0 border-0 p-0">
        {children}
      </fieldset>
    </>
  );
}

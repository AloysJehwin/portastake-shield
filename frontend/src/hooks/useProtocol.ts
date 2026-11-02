import { useAccount, useChainId, useReadContracts, useBalance } from "wagmi";
import type { Address } from "viem";
import { addressesFor } from "../addresses";
import { WPOTAbi } from "../abi/WPOT";
import { MockStableAbi } from "../abi/MockStable";
import { StakingVaultAbi } from "../abi/StakingVault";
import { SwapDeskAbi } from "../abi/SwapDesk";
import { PolicyNFTAbi } from "../abi/PolicyNFT";
import { InsuranceFundAbi } from "../abi/InsuranceFund";
import { StabilizationReserveAbi } from "../abi/StabilizationReserve";

/**
 * One hook that reads every live number the UI needs in a single multicall:
 * balances, rate, price, policy, insurance stats. Returns bigints (or undefined
 * while loading) and the derived "stage status" booleans so views can gate.
 */
export function useProtocol() {
  const chainId = useChainId();
  const { address } = useAccount();
  const a = addressesFor(chainId);
  const user = address ?? "0x0000000000000000000000000000000000000000";

  const native = useBalance({ address });

  const { data, refetch, isLoading } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: a.StakingVault, abi: StakingVaultAbi, functionName: "balanceOf", args: [user] },
      { address: a.tUSD, abi: MockStableAbi, functionName: "balanceOf", args: [user] },
      { address: a.WPOT, abi: WPOTAbi, functionName: "balanceOf", args: [user] },
      { address: a.StakingVault, abi: StakingVaultAbi, functionName: "totalAssets" },
      { address: a.StakingVault, abi: StakingVaultAbi, functionName: "targetRateBps" },
      { address: a.StakingVault, abi: StakingVaultAbi, functionName: "lastEffectiveRateBps" },
      { address: a.StakingVault, abi: StakingVaultAbi, functionName: "availableLiquidity" },
      { address: a.StakingVault, abi: StakingVaultAbi, functionName: "policy" },
      { address: a.SwapDesk, abi: SwapDeskAbi, functionName: "price" },
      { address: a.SwapDesk, abi: SwapDeskAbi, functionName: "updatedAt" },
      { address: a.SwapDesk, abi: SwapDeskAbi, functionName: "maxAge" },
      { address: a.SwapDesk, abi: SwapDeskAbi, functionName: "feeBps" },
      { address: a.InsuranceFund, abi: InsuranceFundAbi, functionName: "balance" },
      { address: a.StabilizationReserve, abi: StabilizationReserveAbi, functionName: "balance" },
    ],
    query: { enabled: a.StakingVault !== "0x0000000000000000000000000000000000000000" },
  });

  // Policy NFT id for the user (only if PolicyNFT deployed and vault's policy is set).
  const policyAddress = (data?.[7]?.result as Address | undefined) ?? a.PolicyNFT;
  const policyRead = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: policyAddress, abi: PolicyNFTAbi, functionName: "policyOf", args: [user] },
    ],
    query: {
      enabled:
        policyAddress !== undefined &&
        policyAddress !== "0x0000000000000000000000000000000000000000" &&
        address !== undefined,
    },
  });

  return {
    chainId,
    addresses: a,
    user: address,
    isLoading,
    refetch,
    native: native.data?.value,
    stPotBalance: numish(data?.[0]?.result),
    usdBalance: numish(data?.[1]?.result),
    wpotBalance: numish(data?.[2]?.result),
    totalAssets: numish(data?.[3]?.result),
    targetRateBps: numish(data?.[4]?.result),
    effectiveRateBps: numish(data?.[5]?.result),
    availableLiquidity: numish(data?.[6]?.result),
    policyAddress,
    desk: {
      price: numish(data?.[8]?.result),
      updatedAt: numish(data?.[9]?.result),
      maxAge: numish(data?.[10]?.result),
      feeBps: numish(data?.[11]?.result),
    },
    insuranceBalance: numish(data?.[12]?.result),
    reserveBalance: numish(data?.[13]?.result),
    policyId: numish(policyRead.data?.[0]?.result),
    stages: {
      core: a.StakingVault !== "0x0000000000000000000000000000000000000000",
      desk: a.SwapDesk !== "0x0000000000000000000000000000000000000000",
      policy: a.PolicyNFT !== "0x0000000000000000000000000000000000000000",
      mandates: a.MandateManager !== "0x0000000000000000000000000000000000000000",
      committee: a.OracleCommittee !== "0x0000000000000000000000000000000000000000",
    },
  };
}

function numish(x: unknown): bigint | undefined {
  if (typeof x === "bigint") return x;
  return undefined;
}

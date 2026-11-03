import { useReadContract } from "wagmi";
import type { Address } from "viem";
import { MockStableAbi } from "../abi/MockStable";

const ZERO = "0x0000000000000000000000000000000000000000";

/** Live ERC-20 balance of `owner` (0n while disabled or loading). */
export function useTokenBalance(token: Address | undefined, owner: Address | undefined) {
  const enabled = !!token && !!owner && token !== ZERO && owner !== ZERO;
  const { data, refetch } = useReadContract({
    address: enabled ? token : undefined,
    abi: MockStableAbi, // balanceOf is the same on every ERC-20
    functionName: "balanceOf",
    args: enabled ? [owner!] : undefined,
    query: { enabled, refetchInterval: 8_000 },
  });
  return { balance: (data as bigint | undefined) ?? 0n, refetch };
}

import { useAccount, useReadContract } from "wagmi";
import type { Address } from "viem";
import { MockStableAbi } from "../abi/MockStable";

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/** Live ERC-20 allowance for (owner, spender). Returns 0n while disabled or loading. */
export function useAllowance(token: Address | undefined, spender: Address | undefined) {
  const { address } = useAccount();
  const enabled =
    !!address &&
    !!token &&
    !!spender &&
    token !== ZERO &&
    spender !== ZERO;

  const { data } = useReadContract({
    address: enabled ? token : undefined,
    abi: MockStableAbi, // minimum IERC20 slice — same ABI shape works for any ERC-20.
    functionName: "allowance",
    args: enabled ? [address!, spender!] : undefined,
    query: { enabled, refetchInterval: 5_000 },
  });
  return (data as bigint | undefined) ?? 0n;
}

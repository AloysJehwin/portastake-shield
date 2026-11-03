import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { parseAbiItem, type Address, type Hash } from "viem";

export type X402Payment = {
  txHash: Hash;
  blockNumber: bigint;
  to: Address;
  amount: bigint;
  timestamp?: number;
};

const USED = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 amount)");
const CHUNK = 5_000n;

/**
 * The connected wallet's x402 payments: xUSD transfers that settled through a signed
 * authorization. Each settlement emits AuthorizationUsed and Transfer in the same
 * transaction, so the two scans are joined by tx hash. Chunked like useRewardHistory
 * because the revive RPC caps wide getLogs ranges.
 */
export function useX402Payments(token: Address, owner: Address | undefined, refreshKey = 0, blocks = 20_000) {
  const client = usePublicClient();
  const [data, setData] = useState<X402Payment[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!client || !owner || token === "0x0000000000000000000000000000000000000000") {
      setData([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const head = await client.getBlockNumber();
        const floor = head > BigInt(blocks) ? head - BigInt(blocks) : 0n;
        const used = new Set<string>();
        const transfers: X402Payment[] = [];
        for (let to = head; to > floor && !cancelled; to -= CHUNK) {
          const from = to - CHUNK + 1n > floor ? to - CHUNK + 1n : floor;
          try {
            const [u, t] = await Promise.all([
              client.getLogs({ address: token, event: USED, args: { authorizer: owner }, fromBlock: from, toBlock: to }),
              client.getLogs({ address: token, event: TRANSFER, args: { from: owner }, fromBlock: from, toBlock: to }),
            ]);
            u.forEach((l) => used.add(l.transactionHash));
            t.forEach((l) =>
              transfers.push({ txHash: l.transactionHash, blockNumber: l.blockNumber, to: l.args.to!, amount: l.args.amount! }),
            );
          } catch {
            // keep what earlier windows returned
          }
        }
        const paid = transfers.filter((t) => used.has(t.txHash)).sort((a, b) => Number(b.blockNumber - a.blockNumber)).slice(0, 10);
        await Promise.all(
          paid.map(async (p) => {
            try {
              p.timestamp = Number((await client.getBlock({ blockNumber: p.blockNumber })).timestamp);
            } catch {
              /* timestamp is cosmetic */
            }
          }),
        );
        if (!cancelled) setData(paid);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, token, owner, refreshKey, blocks]);

  return { data, loading };
}

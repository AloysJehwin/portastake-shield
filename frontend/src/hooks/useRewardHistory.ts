import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { parseAbiItem } from "viem";
import { useProtocol } from "./useProtocol";

export type RewardEvent = {
  blockNumber: bigint;
  timestamp: number; // unix seconds
  reward: bigint;
  owed: bigint;
  toUsers: bigint;
  toInsurance: bigint;
  toReserve: bigint;
  toTreasury: bigint;
  reserveDraw: bigint;
  effectiveRateBps: bigint;
};

const EVT = parseAbiItem(
  "event RewardSplit(uint256 reward, uint256 owed, uint256 toUsers, uint256 toInsurance, uint256 toReserve, uint256 toTreasury, uint256 reserveDraw, uint256 effectiveRateBps)",
);

/**
 * Pulls the vault's last `blocks` worth of RewardSplit events and fetches a
 * timestamp per hit. The on-chain data has no index, so this is the authoritative
 * source for "yield history".
 *
 * The scan is chunked into bounded windows and walked newest-first. Portaldot V3's
 * revive EVM-compat RPC caps (or times out on) wide `eth_getLogs` ranges, so a
 * single 50k-block request can throw; chunking keeps each request small and
 * tolerates a failed chunk (we keep whatever earlier chunks returned) instead of
 * dropping the whole history and surfacing an error on the dashboard.
 */
const CHUNK = 5_000n; // blocks per getLogs request — safe under common revive RPC caps

export function useRewardHistory(blocks = 50_000): {
  data: RewardEvent[];
  loading: boolean;
  error: string | null;
} {
  const client = usePublicClient();
  const { addresses } = useProtocol();
  const [data, setData] = useState<RewardEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client || addresses.StakingVault === "0x0000000000000000000000000000000000000000") return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const latest = await client.getBlockNumber();
        const floor = latest > BigInt(blocks) ? latest - BigInt(blocks) : 0n;

        // Walk newest-first in CHUNK-sized windows. A chunk that the RPC rejects
        // (range too wide, transient failure) is skipped rather than aborting the
        // whole scan — we surface it as a soft error only if every chunk failed.
        const logs: Awaited<ReturnType<typeof client.getLogs>> = [];
        let failures = 0;
        let chunks = 0;
        for (let hi = latest; hi >= floor; hi -= CHUNK + 1n) {
          if (cancelled) return;
          const lo = hi > floor + CHUNK ? hi - CHUNK : floor;
          chunks += 1;
          try {
            const part = await client.getLogs({
              address: addresses.StakingVault,
              event: EVT,
              fromBlock: lo,
              toBlock: hi,
            });
            logs.push(...part);
          } catch {
            failures += 1;
          }
          if (lo === floor) break;
        }
        if (failures === chunks && chunks > 0) {
          throw new Error("reward-history: all getLogs chunks failed (RPC range limit?)");
        }

        // One getBlock per unique block; usually just a few.
        const bns = Array.from(new Set(logs.map((l) => l.blockNumber ?? 0n)));
        const ts: Record<string, number> = {};
        await Promise.all(
          bns.map(async (bn) => {
            const b = await client.getBlock({ blockNumber: bn });
            ts[bn.toString()] = Number(b.timestamp);
          }),
        );
        const events = logs
          .map((l) => {
            const a = (l as unknown as { args: Omit<RewardEvent, "blockNumber" | "timestamp"> }).args;
            return {
              blockNumber: l.blockNumber ?? 0n,
              timestamp: ts[String(l.blockNumber ?? 0n)] ?? 0,
              ...a,
            };
          })
          .sort((x, y) => (x.blockNumber < y.blockNumber ? -1 : 1));
        if (!cancelled) setData(events);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, addresses.StakingVault, blocks]);

  return { data, loading, error };
}

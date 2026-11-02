import { useEffect, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import type { Log } from "viem";
import { parseAbiItem } from "viem";
import { ArrowDownToLine, ArrowUpFromLine, ShieldAlert, Clock, Repeat } from "lucide-react";
import { useProtocol } from "../hooks/useProtocol";
import { formatUsd, formatPot, shortAddress } from "../format";
import { EventRow } from "../components/EventRow";
import { Card, Section, Empty } from "../components/primitives";

type Row = {
  key: string;
  icon: React.ReactNode;
  title: string;
  detail?: string;
  blockNumber: bigint;
};

const EVENTS = {
  stableDeposited: parseAbiItem(
    "event StableDeposited(address indexed payer, address indexed receiver, uint256 usdIn, uint256 potIn, uint256 shares)",
  ),
  stableRedeemed: parseAbiItem(
    "event StableRedeemed(address indexed owner, address indexed receiver, uint256 shares, uint256 potOut, uint256 usdOut)",
  ),
  unstakeRequested: parseAbiItem(
    "event UnstakeRequested(uint256 indexed id, address indexed owner, address receiver, uint256 shares, uint256 assets)",
  ),
  unstakeFulfilled: parseAbiItem(
    "event UnstakeFulfilled(uint256 indexed id, address indexed receiver, uint256 assets)",
  ),
  mandateExecuted: parseAbiItem(
    "event MandateExecuted(uint256 indexed id, uint256 usdAmount, uint256 shares, uint32 runs, uint64 nextRun)",
  ),
  slashCovered: parseAbiItem("event SlashCovered(uint256 amount, uint256 covered)"),
};

export function Activity() {
  const p = useProtocol();
  const client = usePublicClient();
  const { address } = useAccount();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!client || !address || !p.stages.core) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const latest = await client.getBlockNumber();
        const from = latest > 10_000n ? latest - 10_000n : 0n;
        const collected: Row[] = [];

        if (p.addresses.SwapDesk !== "0x0000000000000000000000000000000000000000") {
          const [deposits, redeems] = await Promise.all([
            client.getLogs({
              address: p.addresses.SwapDesk,
              event: EVENTS.stableDeposited,
              args: { receiver: address },
              fromBlock: from,
              toBlock: latest,
            }),
            client.getLogs({
              address: p.addresses.SwapDesk,
              event: EVENTS.stableRedeemed,
              args: { owner: address },
              fromBlock: from,
              toBlock: latest,
            }),
          ]);
          for (const l of deposits) {
            const a = (l.args as unknown as { usdIn: bigint; shares: bigint }) ?? {};
            collected.push({
              key: `${l.transactionHash}:${l.logIndex}`,
              icon: <ArrowDownToLine size={14} />,
              title: `Deposited ${formatUsd(a.usdIn)} tUSD`,
              detail: `Received ${formatPot(a.shares)} stPOT`,
              blockNumber: l.blockNumber ?? 0n,
            });
          }
          for (const l of redeems) {
            const a = (l.args as unknown as { shares: bigint; usdOut: bigint }) ?? {};
            collected.push({
              key: `${l.transactionHash}:${l.logIndex}`,
              icon: <ArrowUpFromLine size={14} />,
              title: `Redeemed ${formatPot(a.shares)} stPOT`,
              detail: `Received ${formatUsd(a.usdOut)} tUSD`,
              blockNumber: l.blockNumber ?? 0n,
            });
          }
        }

        const [unstakes, fulfilled, slashes] = await Promise.all([
          client.getLogs({
            address: p.addresses.StakingVault,
            event: EVENTS.unstakeRequested,
            args: { owner: address },
            fromBlock: from,
            toBlock: latest,
          }),
          client.getLogs({
            address: p.addresses.StakingVault,
            event: EVENTS.unstakeFulfilled,
            fromBlock: from,
            toBlock: latest,
          }),
          client.getLogs({
            address: p.addresses.StakingVault,
            event: EVENTS.slashCovered,
            fromBlock: from,
            toBlock: latest,
          }),
        ]);

        for (const l of unstakes as Log[]) {
          const a = (l as unknown as { args: { assets: bigint; receiver: `0x${string}` } }).args;
          collected.push({
            key: `${l.transactionHash}:${l.logIndex}`,
            icon: <Clock size={14} />,
            title: `Requested unstake · ${formatPot(a.assets)} tPOT`,
            detail: `To ${shortAddress(a.receiver)} (${slowRouteCopy()})`,
            blockNumber: l.blockNumber ?? 0n,
          });
        }
        for (const l of fulfilled as Log[]) {
          const a = (l as unknown as { args: { assets: bigint; receiver: `0x${string}` } }).args;
          if (a.receiver?.toLowerCase() !== address.toLowerCase()) continue;
          collected.push({
            key: `${l.transactionHash}:${l.logIndex}`,
            icon: <ArrowUpFromLine size={14} />,
            title: `Unstake fulfilled · ${formatPot(a.assets)} tPOT`,
            blockNumber: l.blockNumber ?? 0n,
          });
        }
        for (const l of slashes as Log[]) {
          const a = (l as unknown as { args: { amount: bigint; covered: bigint } }).args;
          collected.push({
            key: `${l.transactionHash}:${l.logIndex}`,
            icon: <ShieldAlert size={14} />,
            title: `Validator slashed · ${formatPot(a.amount)} tPOT`,
            detail: `Insurance covered ${formatPot(a.covered)} tPOT`,
            blockNumber: l.blockNumber ?? 0n,
          });
        }

        if (p.addresses.MandateManager !== "0x0000000000000000000000000000000000000000") {
          const execs = await client.getLogs({
            address: p.addresses.MandateManager,
            event: EVENTS.mandateExecuted,
            fromBlock: from,
            toBlock: latest,
          });
          for (const l of execs as Log[]) {
            const a = (l as unknown as { args: { usdAmount: bigint; shares: bigint } }).args;
            collected.push({
              key: `${l.transactionHash}:${l.logIndex}`,
              icon: <Repeat size={14} />,
              title: `Mandate executed · ${formatUsd(a.usdAmount)} tUSD saved`,
              detail: `Minted ${formatPot(a.shares)} stPOT`,
              blockNumber: l.blockNumber ?? 0n,
            });
          }
        }

        collected.sort((x, y) => Number(y.blockNumber - x.blockNumber));
        if (!cancelled) setRows(collected.slice(0, 50));
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, address, p.stages.core, p.addresses.StakingVault, p.addresses.SwapDesk, p.addresses.MandateManager]);

  if (!p.user) {
    return (
      <Section>
        <Empty title="Connect a wallet to see your activity." />
      </Section>
    );
  }

  return (
    <Section title="Last 10,000 blocks">
      {loading ? (
        <Card>
          <p className="text-sm text-fg-muted">Loading…</p>
        </Card>
      ) : err ? (
        <Card>
          <p className="text-sm text-danger">{err}</p>
        </Card>
      ) : rows.length === 0 ? (
        <Empty title="Nothing yet." hint="Deposits, redeems, slashing events and mandate runs will land here." />
      ) : (
        <Card>
          {rows.map((r) => (
            <EventRow key={r.key} icon={r.icon} title={r.title} detail={r.detail} timestamp={r.blockNumber} />
          ))}
        </Card>
      )}
    </Section>
  );
}

function slowRouteCopy(): string {
  return "slow queue · ~168 days on Portaldot";
}

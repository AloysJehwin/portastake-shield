import { useMemo, useState } from "react";
import { maxUint256, parseUnits, type Address } from "viem";
import { useAccount, useChainId, useReadContract, useReadContracts } from "wagmi";
import { Pause, Play, Trash2, Repeat } from "lucide-react";
import { useProtocol } from "../hooks/useProtocol";
import { useAllowance } from "../hooks/useAllowance";
import { formatUsd } from "../format";
import { TxButton } from "../components/TxButton";
import { WalletGate } from "../components/WalletGate";
import { Button, Card, Section, Empty, GlassCard, KeyValue, Divider } from "../components/primitives";
import { MandateManagerAbi } from "../abi/MandateManager";
import { MockStableAbi } from "../abi/MockStable";

const INTERVALS: Array<{ label: string; secs: number }> = [
  { label: "Every day", secs: 86_400 },
  { label: "Every week", secs: 7 * 86_400 },
  { label: "Every month", secs: 30 * 86_400 },
];

export function Automate() {
  const p = useProtocol();

  if (!p.stages.mandates) {
    return (
      <Section>
        <GlassCard>
          <h1 className="text-lg text-fg mb-1">Automate</h1>
          <p className="text-sm text-fg-muted mb-5">
            Save on autopilot. On-chain rules let you ignore the market.
          </p>
          <Empty
            icon={<Repeat size={20} aria-hidden />}
            title="Automation isn't live on this network yet"
            hint="Once the MandateManager address is configured, your save and pay rules appear here."
          />
        </GlassCard>
      </Section>
    );
  }

  return (
    <WalletGate action="set up save rules">
      <CreateMandate />
      <MyMandates />
    </WalletGate>
  );
}

function CreateMandate() {
  const p = useProtocol();
  const [amount, setAmount] = useState("50");
  const [interval, setIntervalSecs] = useState<number>(INTERVALS[1].secs);
  const allowance = useAllowance(p.addresses.tUSD, p.addresses.MandateManager);

  const parsed = useMemo(() => {
    try {
      return amount ? parseUnits(amount, 6) : 0n;
    } catch {
      return 0n;
    }
  }, [amount]);

  // MandateManager.create(MandateParams p) — RECURRING SAVE preset.
  const params = useMemo(
    () => ({
      dir: 0, // SAVE
      trig: 0, // RECURRING
      payee: "0x0000000000000000000000000000000000000000" as Address,
      amount: parsed,
      bound: 0n,
      start: 0n,
      interval: BigInt(interval),
      maxRuns: 0n, // unlimited
      expiry: 0n,
      maxSlippageBps: 50,
    }),
    [parsed, interval],
  );

  const needsApproval = parsed > 0n && allowance < parsed * 24n; // enough for ~2 years of a monthly rule

  return (
    <Section>
      <GlassCard>
        <h1 className="text-lg text-fg mb-1">Save on autopilot</h1>
        <p className="text-sm text-fg-muted mb-5">
          Move tUSD into stPOT on a schedule. You keep custody — only you can cancel.
        </p>

        <label className="block mb-4">
          <div className="text-xs text-fg-muted mb-1.5">Each run saves</div>
          <div className="flex items-stretch gap-2">
            <input
              className="input num flex-1 text-right"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            />
            <span className="inline-flex items-center px-3 rounded-sm border border-line bg-surface text-sm">
              tUSD
            </span>
          </div>
        </label>

        <div className="flex gap-1 flex-wrap">
          {INTERVALS.map((i) => (
            <button
              key={i.secs}
              type="button"
              onClick={() => setIntervalSecs(i.secs)}
              className={`chip ${interval === i.secs ? "border-fg text-fg" : ""}`}
            >
              {i.label}
            </button>
          ))}
        </div>

        <Divider className="my-5" />
        <KeyValue label="You save" value={formatUsd(parsed)} />
        <KeyValue label="Cadence" value={INTERVALS.find((i) => i.secs === interval)?.label ?? "custom"} />

        <div className="mt-4 space-y-3">
          {needsApproval && (
            <TxButton
              label="Approve tUSD for mandates"
              address={p.addresses.tUSD}
              abi={MockStableAbi}
              functionName="approve"
              args={[p.addresses.MandateManager, maxUint256]}
            />
          )}
          <TxButton
            label="Create save rule"
            address={p.addresses.MandateManager}
            abi={MandateManagerAbi}
            functionName="create"
            args={[params]}
            disabled={parsed === 0n || needsApproval || !p.user}
            onSuccess={() => p.refetch()}
          />
        </div>
      </GlassCard>
    </Section>
  );
}

function MyMandates() {
  const p = useProtocol();
  // Reading chainId is used only to keep the hook subscribed to chain switches.
  useChainId();
  const { address } = useAccount();

  const { data: nextId } = useReadContract({
    address:
      p.addresses.MandateManager !== "0x0000000000000000000000000000000000000000"
        ? p.addresses.MandateManager
        : undefined,
    abi: MandateManagerAbi,
    functionName: "nextId",
  });

  const n = Number((nextId as bigint | undefined) ?? 0n);
  const indices = Array.from({ length: n }, (_, i) => BigInt(i));

  const { data: rows } = useReadContracts({
    allowFailure: true,
    contracts: indices.map((i) => ({
      address: p.addresses.MandateManager,
      abi: MandateManagerAbi,
      functionName: "getMandate" as const,
      args: [i] as const,
    })),
    query: { enabled: n > 0 && !!address },
  });

  const mine =
    rows
      ?.map((r, i) => ({ id: BigInt(i), m: r.result as any }))
      .filter(({ m }) => m && m.owner?.toLowerCase() === address?.toLowerCase()) ?? [];

  if (mine.length === 0) {
    return (
      <Section title="Your mandates">
        <Empty title="No save rules yet." hint="Create your first one above." />
      </Section>
    );
  }

  return (
    <Section title="Your mandates">
      <Card>
        {mine.map(({ id, m }) => (
          <MandateRow key={id.toString()} id={id} m={m} managerAddress={p.addresses.MandateManager} />
        ))}
      </Card>
    </Section>
  );
}

function MandateRow({
  id,
  m,
  managerAddress,
}: {
  id: bigint;
  m: {
    active: boolean;
    amount: bigint;
    interval: bigint;
    nextRun: bigint;
    runs: bigint;
    dir: number;
    trig: number;
  };
  managerAddress: Address;
}) {
  const cadence = m.interval > 0n ? describeInterval(m.interval) : "once";
  return (
    <div className="flex items-center gap-3 py-3 border-b border-line last:border-b-0">
      <span className="inline-flex items-center justify-center w-8 h-8 rounded-sm bg-surface border border-line">
        <Repeat size={14} aria-hidden />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-fg">
          Save <span className="num">{formatUsd(m.amount)}</span> tUSD · {cadence}
        </div>
        <div className="text-xs text-fg-muted">
          {m.active ? "active" : "paused"} · {m.runs.toString()} runs
        </div>
      </div>
      <div className="flex items-center gap-1">
        {m.active ? (
          <TxButton
            label="Pause"
            address={managerAddress}
            abi={MandateManagerAbi}
            functionName="pauseMandate"
            args={[id]}
          >
            <Pause size={12} />
          </TxButton>
        ) : (
          <TxButton
            label="Resume"
            address={managerAddress}
            abi={MandateManagerAbi}
            functionName="resumeMandate"
            args={[id]}
          >
            <Play size={12} />
          </TxButton>
        )}
        <TxButton
          label="Cancel"
          address={managerAddress}
          abi={MandateManagerAbi}
          functionName="cancel"
          args={[id]}
        >
          <Trash2 size={12} />
        </TxButton>
      </div>
    </div>
  );
}

function describeInterval(secs: bigint): string {
  const s = Number(secs);
  if (s % 86_400 === 0) return s === 86_400 ? "daily" : `every ${s / 86_400}d`;
  if (s % 3600 === 0) return `every ${s / 3600}h`;
  return `every ${s}s`;
}

/* Button helpers that render TxButton as compact icon buttons. */
Button.displayName ??= "Button";

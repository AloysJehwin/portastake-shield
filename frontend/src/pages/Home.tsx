import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Repeat,
  Gauge,
  LineChart as LineIcon,
  BarChart3,
  Eye,
  History,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useProtocol } from "../hooks/useProtocol";
import { useRewardHistory } from "../hooks/useRewardHistory";
import { formatPot, formatUsd, potToUsd } from "../format";
import { RateChip } from "../components/RateChip";
import { PolicyBadge } from "../components/PolicyBadge";
import { TrendBadge } from "../components/TrendBadge";
import { CardHeader } from "../components/CardHeader";
import { Dropdown } from "../components/Dropdown";
import { GaugeArc } from "../components/GaugeArc";
import { LineChart } from "../components/LineChart";
import { BarChart } from "../components/BarChart";
import { Heatmap } from "../components/Heatmap";
import { GlassCard, Section, Card, KeyValue, Empty } from "../components/primitives";

const ERA_SECS = 6 * 3600;

export function Home() {
  const p = useProtocol();
  const history = useRewardHistory();
  const [window, setWindow] = useState<"24h" | "7d" | "30d">("7d");

  const stPotInPot = p.stPotBalance ?? 0n;
  const stPotInUsd = p.desk.price ? potToUsd(stPotInPot, p.desk.price) : undefined;

  // Protocol-wide TVL in USD (connection-independent) for the public dashboard hero.
  const tvlUsd = p.desk.price && p.totalAssets ? potToUsd(p.totalAssets, p.desk.price) : undefined;
  const connected = !!p.user;

  // Protocol health score — a 0..100 blend of reserve runway (days to 180) and insurance ratio
  // (bps to the 2% target). Replaces the ad-hoc "transparency views" we deleted from the vault.
  const health = useMemo(() => {
    if (!p.totalAssets || !p.targetRateBps || p.totalAssets === 0n || p.targetRateBps === 0n) return 0;
    const days = Number(
      ((p.reserveBalance ?? 0n) * 365n * 10_000n) / (p.totalAssets * p.targetRateBps),
    );
    const insBps = Number(((p.insuranceBalance ?? 0n) * 10_000n) / p.totalAssets);
    const runway = Math.min(1, days / 180) * 60; // 0..60
    const insurance = Math.min(1, insBps / 200) * 40; // 0..40
    return Math.round(runway + insurance);
  }, [p.reserveBalance, p.insuranceBalance, p.totalAssets, p.targetRateBps]);

  // Trend between last two reward events.
  const trend = useMemo(() => {
    const h = history.data;
    if (h.length < 2) return undefined;
    const a = Number(h[h.length - 2].effectiveRateBps);
    const b = Number(h[h.length - 1].effectiveRateBps);
    return b - a;
  }, [history.data]);

  // Line chart windows.
  const windowed = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const cut = window === "24h" ? now - 86_400 : window === "7d" ? now - 7 * 86_400 : now - 30 * 86_400;
    return history.data.filter((e) => e.timestamp >= cut);
  }, [history.data, window]);

  // Bar chart data: latest reward split.
  const latest = history.data[history.data.length - 1];
  const splitBars = latest
    ? [
        { label: "To users", value: Number(latest.toUsers / 10n ** 14n) / 10_000, detail: "stPOT yield" },
        { label: "Insurance", value: Number(latest.toInsurance / 10n ** 14n) / 10_000, detail: "slash buffer" },
        { label: "Reserve", value: Number(latest.toReserve / 10n ** 14n) / 10_000, detail: "rate backstop" },
      ]
    : [];

  // Heatmap: last 14 days × 4 eras/day. Each cell is reward (in tPOT) scaled.
  const heat = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const days = 14;
    const erasPerDay = 4;
    // Column 0 = oldest day (today is the right-most column), row 0 = earliest era of the day.
    const cells = history.data.map((e) => {
      const delta = now - e.timestamp;
      const dayFromNow = Math.floor(delta / 86_400);
      if (dayFromNow < 0 || dayFromNow >= days) return undefined;
      const col = days - 1 - dayFromNow;
      const row = Math.min(
        erasPerDay - 1,
        Math.floor(((e.timestamp % 86_400) + 86_400) % 86_400 / ERA_SECS),
      );
      return {
        row,
        col,
        value: Number(e.reward / 10n ** 14n) / 10_000,
        label: new Date(e.timestamp * 1000).toLocaleString(),
      };
    });
    return cells.filter(Boolean) as { row: number; col: number; value: number; label: string }[];
  }, [history.data]);

  return (
    <>
      <Section>
        <GlassCard className="flex flex-col gap-5">
          {connected ? (
            <>
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <div className="text-xs uppercase tracking-widest text-fg-muted">My savings</div>
                  <div className="num text-2xl mt-1 text-fg">
                    {formatUsd(stPotInUsd)}
                    <span className="text-fg-muted text-base ml-2">USD</span>
                  </div>
                  <div className="num text-sm text-fg-muted">{formatPot(stPotInPot)} stPOT</div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <RateChip effectiveBps={p.effectiveRateBps} targetBps={p.targetRateBps} />
                  <TrendBadge deltaBps={trend} />
                  <PolicyBadge policyId={p.policyId} />
                </div>
              </div>

              <div className="flex gap-2 flex-wrap">
                <Link to="/deposit" className="btn-primary">
                  <ArrowDownToLine size={16} /> Deposit
                </Link>
                <Link to="/withdraw" className="btn-secondary">
                  <ArrowUpFromLine size={16} /> Withdraw
                </Link>
                <Link to="/automate" className="btn-ghost">
                  <Repeat size={16} /> Automate
                </Link>
              </div>
            </>
          ) : (
            // Logged-out: public protocol overview + a connect prompt. No personal
            // numbers, but every protocol-wide stat below stays visible.
            <>
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <div className="text-xs uppercase tracking-widest text-fg-muted">Total value locked</div>
                  <div className="num text-2xl mt-1 text-fg">
                    {formatUsd(tvlUsd)}
                    <span className="text-fg-muted text-base ml-2">USD</span>
                  </div>
                  <div className="num text-sm text-fg-muted">{formatPot(p.totalAssets)} tPOT staked</div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <RateChip effectiveBps={p.effectiveRateBps} targetBps={p.targetRateBps} />
                  <TrendBadge deltaBps={trend} />
                </div>
              </div>

              <div className="flex items-center gap-3 flex-wrap">
                <ConnectButton.Custom>
                  {({ openConnectModal, mounted }) => (
                    <button
                      onClick={openConnectModal}
                      disabled={!mounted}
                      className="btn-primary"
                    >
                      <Wallet size={16} /> Connect wallet to start saving
                    </button>
                  )}
                </ConnectButton.Custom>
                <span className="text-sm text-fg-muted">
                  Explore the protocol below — no wallet needed.
                </span>
              </div>
            </>
          )}
        </GlassCard>
      </Section>

      {!p.stages.core && (
        <Section>
          <Empty
            title="Contracts not deployed on this chain yet"
            hint="Switch to Anvil (31337) locally, or wait for the Portaldot stages to ship."
          />
        </Section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-5">
        <Card className="lg:col-span-1">
          <CardHeader icon={<Gauge size={14} />} title="Protocol health" to="/activity" />
          <GaugeArc
            value={health}
            max={100}
            valueLabel={`${health}/100`}
            caption={healthCaption(health)}
          />
          {history.data.length === 0 && (
            <div className="mt-3 text-[11px] text-fg-subtle text-center">
              Awaiting the first era — rate &amp; yield charts fill in once the relayer calls notifyReward.
            </div>
          )}
          <div className="mt-6 space-y-3">
            <HealthRow
              dot="#0A0A0A"
              label="Reserve runway"
              value={reserveDays(p.reserveBalance, p.totalAssets, p.targetRateBps)}
              secondary={`${formatPot(p.reserveBalance)} tPOT`}
            />
            <HealthRow
              dot="#6B6B6B"
              label="Insurance fund"
              value={insuranceRatio(p.insuranceBalance, p.totalAssets)}
              secondary={`${formatPot(p.insuranceBalance)} tPOT`}
            />
            <HealthRow
              dot="#D4D4D4"
              label="Hot reserve"
              value={hotShare(p.availableLiquidity, p.totalAssets)}
              secondary={`${formatPot(p.availableLiquidity)} tPOT`}
            />
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            icon={<LineIcon size={14} />}
            title="Effective rate"
            action={
              <Dropdown
                value={window}
                options={[
                  { value: "24h", label: "Daily" },
                  { value: "7d", label: "Weekly" },
                  { value: "30d", label: "Monthly" },
                ]}
                onChange={setWindow}
              />
            }
          />
          <div className="flex items-baseline gap-3 mb-4">
            <span className="num text-xl text-fg">
              {p.effectiveRateBps !== undefined ? (Number(p.effectiveRateBps) / 100).toFixed(2) : "—"}%
            </span>
            <TrendBadge deltaBps={trend} />
            <span className="text-xs text-fg-muted ml-auto">
              Target{" "}
              <span className="text-fg num">
                {p.targetRateBps !== undefined ? (Number(p.targetRateBps) / 100).toFixed(2) : "—"}%
              </span>
            </span>
          </div>
          {windowed.length < 2 ? (
            <RateFallback target={p.targetRateBps} />
          ) : (
            <LineChart
              series={[
                {
                  name: "Effective",
                  color: "#2563EB",
                  points: windowed.map((e) => ({
                    x: e.timestamp,
                    y: Number(e.effectiveRateBps) / 100,
                  })),
                },
                {
                  name: "Target",
                  color: "#A3A3A3",
                  dash: true,
                  points: windowed.map((e) => ({
                    x: e.timestamp,
                    y: Number(p.targetRateBps ?? 0n) / 100,
                  })),
                },
              ]}
              valueFormat={(v) => `${v.toFixed(2)}%`}
              xFormat={(x) =>
                window === "24h"
                  ? new Date(x * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                  : new Date(x * 1000).toLocaleDateString([], { month: "short", day: "numeric" })
              }
            />
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-5">
        <Card className="lg:col-span-1">
          <CardHeader icon={<BarChart3 size={14} />} title="Last reward split" to="/activity" />
          <div className="flex items-baseline gap-3 mb-2">
            <span className="num text-xl text-fg">
              {latest ? `${formatPot(latest.reward)} tPOT` : "—"}
            </span>
            <TrendBadge deltaBps={trend} />
          </div>
          {splitBars.length === 0 ? (
            <Empty title="No eras recorded yet." hint="The vault starts streaming on the relayer's first notifyReward." />
          ) : (
            <BarChart data={splitBars} valueFormat={(v) => `${v.toFixed(2)} tPOT`} />
          )}
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            icon={<Eye size={14} />}
            title="Era activity"
            action={
              <Dropdown
                value="14d"
                options={[{ value: "14d", label: "Last 14 days" }]}
                onChange={() => {}}
              />
            }
          />
          <div className="flex items-baseline gap-3 mb-5">
            <span className="num text-xl text-fg">{history.data.length}</span>
            <span className="text-xs text-fg-muted">reward events seen</span>
          </div>
          {heat.length === 0 ? (
            <Empty
              title="No era data yet."
              hint="Each 6-hour era lands as one cell once the relayer calls notifyReward."
            />
          ) : (
            <Heatmap
              cells={heat}
              rows={4}
              cols={14}
              rowLabels={["00-06", "06-12", "12-18", "18-24"]}
              colLabels={Array.from({ length: 14 }, (_, i) => (i === 13 ? "today" : `-${13 - i}d`))}
            />
          )}
        </Card>
      </div>

      {connected && (
        <Section title="Wallet">
          <Card>
          <KeyValue label="Native tPOT" value={formatPot(p.native)} />
          <KeyValue label="tUSD" value={formatUsd(p.usdBalance)} />
          <KeyValue label="stPOT (shares)" value={formatPot(p.stPotBalance)} />
          <KeyValue label="WPOT" value={formatPot(p.wpotBalance)} />
        </Card>
        </Section>
      )}

      <Section
        title="Safety"
        action={
          <Link to="/activity" className="text-xs text-fg-muted hover:text-fg inline-flex items-center gap-1">
            <History size={12} /> Activity log
          </Link>
        }
      >
        <Card>
          <KeyValue
            label={
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck size={12} /> Covered losses
              </span>
            }
            value={latest ? `${formatPot(latest.reserveDraw)} tPOT drawn last era` : "—"}
          />
          <KeyValue
            label="Insurance balance"
            value={`${formatPot(p.insuranceBalance)} tPOT`}
            hint={insuranceRatio(p.insuranceBalance, p.totalAssets)}
          />
        </Card>
      </Section>
    </>
  );
}

function HealthRow({
  dot,
  label,
  value,
  secondary,
}: {
  dot: string;
  label: string;
  value: string;
  secondary: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="inline-flex items-center gap-2 text-fg-muted">
        <span className="w-2 h-2 rounded-full" style={{ background: dot }} aria-hidden />
        {label}
      </span>
      <span className="text-right">
        <span className="text-fg num">{value}</span>
        <div className="text-xs text-fg-subtle num">{secondary}</div>
      </span>
    </div>
  );
}

function RateFallback({ target }: { target: bigint | undefined }) {
  const tgt = target !== undefined ? (Number(target) / 100).toFixed(2) : "—";
  return (
    <div className="h-[180px] flex items-center justify-center text-sm text-fg-subtle">
      Not enough history yet — target {tgt}%.
    </div>
  );
}

function healthCaption(score: number): string {
  if (score >= 80) return "Strong buffer";
  if (score >= 50) return "Healthy";
  if (score >= 25) return "Thin — top up soon";
  return "At risk";
}

function reserveDays(reserve?: bigint, total?: bigint, targetBps?: bigint): string {
  if (!reserve || !total || !targetBps || total === 0n || targetBps === 0n) return "—";
  const days = (reserve * 365n * 10_000n) / (total * targetBps);
  return `${days.toString()}d runway`;
}

function insuranceRatio(ins?: bigint, total?: bigint): string {
  if (!ins || !total || total === 0n) return "—";
  const bps = (ins * 10_000n) / total;
  return `${(Number(bps) / 100).toFixed(2)}% of TVL`;
}

function hotShare(hot?: bigint, total?: bigint): string {
  if (!hot || !total || total === 0n) return "—";
  const bps = (hot * 10_000n) / total;
  return `${(Number(bps) / 100).toFixed(2)}% liquid`;
}

import { formatBps } from "../format";

export function RateChip({
  effectiveBps,
  targetBps,
}: {
  effectiveBps: bigint | undefined;
  targetBps: bigint | undefined;
}) {
  const ok = effectiveBps !== undefined && targetBps !== undefined && effectiveBps >= targetBps - 10n;
  const label =
    effectiveBps === undefined
      ? "APY —"
      : effectiveBps === 0n
      ? "APY paused"
      : `APY ${formatBps(effectiveBps)}`;
  return (
    <span className={ok ? "chip-success" : "chip-danger"}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${ok ? "bg-success" : "bg-danger"}`} />
      {label}
      {targetBps !== undefined && (
        <span className="text-fg-subtle"> · target {formatBps(targetBps)}</span>
      )}
    </span>
  );
}

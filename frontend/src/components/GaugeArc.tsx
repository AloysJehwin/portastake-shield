/**
 * Half-donut gauge, 24 segments on a 180° arc. Fills left→right proportional to
 * `value / max`. Pure SVG, no library. Centre slot takes a big number + label.
 *
 * Form choice: a single magnitude on a bounded scale (0..max) — a gauge is one
 * of the two valid "stat tile" variants. One hue (`fg`) for filled segments,
 * one tint (`line`) for unfilled. No legend needed — the title names it.
 */
export function GaugeArc({
  value,
  max,
  valueLabel,
  caption,
  segments = 24,
  size = 220,
}: {
  value: number;
  max: number;
  valueLabel: string;
  caption?: string;
  segments?: number;
  size?: number;
}) {
  const pct = Math.max(0, Math.min(1, max === 0 ? 0 : value / max));
  const filled = Math.round(pct * segments);
  const cx = size / 2;
  const cy = size * 0.56; // raise the arc centre slightly so the big number sits in-arc
  const outer = size * 0.44;
  const inner = size * 0.3;
  const barThick = size * 0.03;

  const bars = Array.from({ length: segments }).map((_, i) => {
    // Spread angles across 180° with a tiny gap between bars.
    const t = (i + 0.5) / segments;
    const angle = Math.PI * (1 - t); // left (π) → right (0)
    const r1 = inner;
    const r2 = outer;
    const x1 = cx + r1 * Math.cos(angle);
    const y1 = cy - r1 * Math.sin(angle);
    const x2 = cx + r2 * Math.cos(angle);
    const y2 = cy - r2 * Math.sin(angle);
    const isOn = i < filled;
    return (
      <line
        key={i}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        strokeWidth={barThick}
        strokeLinecap="round"
        stroke={isOn ? "#0A0A0A" : "#E5E5E5"}
        opacity={isOn ? 1 - (i / segments) * 0.35 : 1}
      />
    );
  });

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size * 0.7} viewBox={`0 0 ${size} ${size * 0.7}`} role="img" aria-label={valueLabel}>
        {bars}
      </svg>
      <div className="-mt-14 text-center">
        <div className="num text-xl text-fg">{valueLabel}</div>
        {caption && <div className="text-xs text-fg-muted mt-0.5">{caption}</div>}
      </div>
    </div>
  );
}

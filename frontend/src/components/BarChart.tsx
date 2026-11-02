import { useMemo, useState } from "react";

export type BarPoint = { label: string; value: number; detail?: string };

/**
 * Compact vertical bar chart with hatched fill (45° stripes). Three bars
 * ordered by magnitude read dark→light; identity is also carried by the x-axis
 * labels and the direct value label at the base of each bar.
 */
export function BarChart({
  data,
  height = 220,
  valueFormat = (v) => v.toLocaleString(),
}: {
  data: BarPoint[];
  height?: number;
  valueFormat?: (v: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  // Rank-based grayscale: largest = fg, mid = fg-muted, smallest = line-strong.
  const sorted = [...data]
    .map((d, i) => ({ i, d }))
    .sort((a, b) => b.d.value - a.d.value);
  const shadeByIndex = useMemo(() => {
    const out = new Array(data.length).fill("#A3A3A3");
    const palette = ["#0A0A0A", "#6B6B6B", "#D4D4D4"];
    sorted.forEach((entry, rank) => {
      out[entry.i] = palette[Math.min(rank, palette.length - 1)];
    });
    return out;
  }, [sorted, data.length]);

  const width = 320;
  const padX = 24;
  const padTop = 20;
  const padBottom = 36;
  const chartH = height - padTop - padBottom;
  const slot = (width - padX * 2) / data.length;
  const barW = Math.min(72, slot * 0.6);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);

  return (
    <div className="relative">
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img">
        <defs>
          {shadeByIndex.map((shade, i) => (
            <pattern
              key={i}
              id={`stripe-${i}`}
              patternUnits="userSpaceOnUse"
              width="6"
              height="6"
              patternTransform="rotate(45)"
            >
              <rect width="6" height="6" fill={shade} />
              <line x1="0" y1="0" x2="0" y2="6" stroke="#FFFFFF" strokeOpacity="0.18" strokeWidth="2" />
            </pattern>
          ))}
        </defs>

        {/* y gridlines */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line
              x1={padX}
              x2={width - padX}
              y1={padTop + chartH - (t / max) * chartH}
              y2={padTop + chartH - (t / max) * chartH}
              stroke="#E5E5E5"
              strokeDasharray="2 4"
            />
            <text
              x={8}
              y={padTop + chartH - (t / max) * chartH + 3}
              fontSize="10"
              fill="#A3A3A3"
              className="num"
            >
              {Math.round(t)}
            </text>
          </g>
        ))}

        {data.map((d, i) => {
          const h = (d.value / max) * chartH;
          const x = padX + i * slot + (slot - barW) / 2;
          const y = padTop + chartH - h;
          const r = Math.min(4, barW / 4);
          return (
            <g
              key={i}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              className="cursor-default"
            >
              <rect x={x} y={y} width={barW} height={h} fill={`url(#stripe-${i})`} rx={r} ry={r} />
              {/* 2px surface gap at the baseline so the bar reads as a solid bar, not glued. */}
              <rect x={x} y={padTop + chartH - 2} width={barW} height={2} fill="#FFFFFF" />
              {/* value label inside the bar near its base */}
              <text
                x={x + barW / 2}
                y={padTop + chartH - 10}
                fontSize="12"
                textAnchor="middle"
                fill="#FFFFFF"
                className="num"
              >
                {d.value}
              </text>
              {/* category label */}
              <text
                x={x + barW / 2}
                y={height - 10}
                fontSize="11"
                textAnchor="middle"
                fill="#6B6B6B"
              >
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>

      {hover !== null && data[hover] && (
        <div
          className="absolute pointer-events-none z-10 bg-fg text-bg rounded-md px-3 py-2 text-xs shadow-md"
          style={{
            left: `${((padX + hover * slot + slot / 2) / width) * 100}%`,
            top: 0,
            transform: "translate(-50%, -8px)",
            whiteSpace: "nowrap",
          }}
        >
          <div className="font-medium">{data[hover].label}</div>
          <div className="num">{valueFormat(data[hover].value)}</div>
          {data[hover].detail && <div className="text-bg/70">{data[hover].detail}</div>}
        </div>
      )}
    </div>
  );
}

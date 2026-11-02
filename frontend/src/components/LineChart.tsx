import { useMemo, useRef, useState } from "react";

export type LinePoint = { x: number; y: number; label?: string };

export type LineSeries = {
  name: string;
  color: string;
  dash?: boolean;
  points: LinePoint[];
};

/**
 * Compact line chart, 2 series max. Series 1 is the live data (solid, accent);
 * series 2 is the reference guide (dashed, muted). The dashed stroke carries
 * identity on top of hue so the pair stays legible for CVD readers and in print.
 *
 * Rendering: a crosshair + per-x tooltip appears on hover, as required for any
 * line/area chart.
 */
export function LineChart({
  series,
  height = 180,
  valueFormat = (v) => v.toFixed(2),
  xFormat = (x) => new Date(x * 1000).toLocaleDateString(),
}: {
  series: LineSeries[];
  height?: number;
  valueFormat?: (v: number) => string;
  xFormat?: (x: number) => string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);

  const padX = 32;
  const padTop = 10;
  const padBottom = 24;
  const [width, setWidth] = useState(600);

  // Re-measure once mounted; also on resize.
  useMemo(() => {
    if (typeof ResizeObserver === "undefined" || !wrapRef.current) return;
    const el = wrapRef.current;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 600));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { xMin, xMax, yMin, yMax } = useMemo(() => {
    const xs = series.flatMap((s) => s.points.map((p) => p.x));
    const ys = series.flatMap((s) => s.points.map((p) => p.y));
    if (xs.length === 0) return { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    let yMin = Math.min(...ys, 0);
    let yMax = Math.max(...ys);
    if (yMin === yMax) {
      yMin -= 1;
      yMax += 1;
    }
    const pad = (yMax - yMin) * 0.1;
    return { xMin, xMax, yMin: yMin - pad, yMax: yMax + pad };
  }, [series]);

  const sx = (x: number) =>
    xMin === xMax ? width / 2 : padX + ((x - xMin) / (xMax - xMin)) * (width - padX * 2);
  const sy = (y: number) =>
    padTop + (1 - (y - yMin) / (yMax - yMin)) * (height - padTop - padBottom);

  // Build 4 y-gridlines.
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => yMin + t * (yMax - yMin));
  const xTicks =
    xMin === xMax
      ? [xMin]
      : Array.from({ length: 5 }).map((_, i) => xMin + ((xMax - xMin) * i) / 4);

  const hovered = (() => {
    if (hoverX === null) return null;
    const x = hoverX;
    // Find nearest sample for each series.
    const picks = series.map((s) => {
      let best = s.points[0];
      let bestDist = Infinity;
      for (const p of s.points) {
        const d = Math.abs(p.x - x);
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      return { series: s, point: best };
    });
    return picks;
  })();

  function onMove(e: React.MouseEvent) {
    const el = e.currentTarget as HTMLDivElement;
    const r = el.getBoundingClientRect();
    const rx = ((e.clientX - r.left - padX) / (r.width - padX * 2)) * (xMax - xMin) + xMin;
    setHoverX(rx);
  }

  return (
    <div
      ref={wrapRef}
      className="relative select-none"
      onMouseMove={onMove}
      onMouseLeave={() => setHoverX(null)}
    >
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img">
        {/* y gridlines */}
        {yTicks.map((t, i) => (
          <g key={`yt-${i}`}>
            <line
              x1={padX}
              x2={width - padX}
              y1={sy(t)}
              y2={sy(t)}
              stroke="#E5E5E5"
              strokeDasharray="2 4"
            />
            <text x={8} y={sy(t) + 3} fontSize="10" fill="#A3A3A3" className="num">
              {valueFormat(t)}
            </text>
          </g>
        ))}
        {/* x tick labels */}
        {xTicks.map((t, i) => (
          <text
            key={`xt-${i}`}
            x={sx(t)}
            y={height - 6}
            fontSize="10"
            textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
            fill="#A3A3A3"
            className="num"
          >
            {xFormat(t)}
          </text>
        ))}

        {/* lines */}
        {series.map((s, si) => (
          <polyline
            key={si}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeDasharray={s.dash ? "4 4" : undefined}
            strokeLinecap="round"
            strokeLinejoin="round"
            points={s.points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")}
          />
        ))}

        {/* hover crosshair + markers */}
        {hovered && (
          <g>
            <line
              x1={sx(hovered[0]!.point.x)}
              x2={sx(hovered[0]!.point.x)}
              y1={padTop}
              y2={height - padBottom}
              stroke="#0A0A0A"
              strokeWidth={1}
              strokeDasharray="2 3"
              opacity={0.5}
            />
            {hovered.map((h, i) => (
              <circle
                key={i}
                cx={sx(h.point.x)}
                cy={sy(h.point.y)}
                r={4}
                fill="#FFFFFF"
                stroke={h.series.color}
                strokeWidth={2}
              />
            ))}
          </g>
        )}
      </svg>

      {hovered && hovered[0] && (
        <div
          className="absolute pointer-events-none z-10 bg-fg text-bg rounded-md px-3 py-2 text-xs shadow-md"
          style={{
            left: `${sx(hovered[0].point.x)}px`,
            top: `${sy(Math.max(...hovered.map((h) => h.point.y))) - 60}px`,
            transform: "translate(-50%, 0)",
            whiteSpace: "nowrap",
          }}
        >
          <div className="font-medium mb-1">{xFormat(hovered[0].point.x)}</div>
          {hovered.map((h, i) => (
            <div key={i} className="flex items-center gap-2">
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: h.series.color }}
                aria-hidden
              />
              <span className="text-bg/70">{h.series.name}</span>
              <span className="ml-auto num">{valueFormat(h.point.y)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

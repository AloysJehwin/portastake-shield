import { Fragment, useMemo, useState, type ReactNode } from "react";

/** Grid rows are flattened into the parent grid; a Fragment keeps the JSX grouped. */
function Row({ children }: { children: ReactNode }) {
  return <Fragment>{children}</Fragment>;
}

export type HeatCell = {
  row: number;
  col: number;
  value: number;
  label?: string;
};

/**
 * Sequential grayscale heatmap. One hue, five lightness steps including the
 * surface. Cell hover shows a tooltip with the raw value.
 */
export function Heatmap({
  cells,
  rows,
  cols,
  rowLabels,
  colLabels,
}: {
  cells: HeatCell[];
  rows: number;
  cols: number;
  rowLabels?: string[];
  colLabels?: string[];
}) {
  const [hover, setHover] = useState<HeatCell | null>(null);
  const max = Math.max(1, ...cells.map((c) => c.value));
  const grid = useMemo(() => {
    const m = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));
    const labels = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ""));
    for (const c of cells) {
      if (c.row < rows && c.col < cols) {
        m[c.row][c.col] = c.value;
        if (c.label) labels[c.row][c.col] = c.label;
      }
    }
    return { m, labels };
  }, [cells, rows, cols]);

  // 5-step sequential ramp from the near-white surface to near-black fg.
  const steps = ["#F5F5F5", "#E5E5E5", "#D4D4D4", "#6B6B6B", "#0A0A0A"];
  function fillFor(v: number) {
    if (v === 0) return "#F5F5F5";
    const t = v / max;
    const idx = Math.min(steps.length - 1, 1 + Math.floor(t * (steps.length - 1)));
    return steps[idx];
  }

  // Fluid grid: cells stretch to fill the card's width, with a fixed row height so the
  // chart reads as a strip rather than a tall column of tiny squares.
  return (
    <div>
      <div
        className="grid gap-1.5 items-center"
        style={{ gridTemplateColumns: `auto repeat(${cols}, minmax(0, 1fr))` }}
      >
        <span aria-hidden />
        {Array.from({ length: cols }).map((_, c) => (
          <span key={`h${c}`} className="text-[11px] text-fg-subtle text-center truncate">
            {colLabels?.[c] ?? ""}
          </span>
        ))}
        {Array.from({ length: rows }).map((_, r) => (
          <Row key={r}>
            <span className="text-[11px] text-fg-muted pr-2 whitespace-nowrap num">{rowLabels?.[r] ?? ""}</span>
            {Array.from({ length: cols }).map((_, c) => {
              const v = grid.m[r][c];
              const label = grid.labels[r][c];
              return (
                <div
                  key={c}
                  role="img"
                  aria-label={label || `${v}`}
                  onMouseEnter={() => setHover({ row: r, col: c, value: v, label })}
                  onMouseLeave={() => setHover(null)}
                  className="h-9 rounded-sm transition-colors"
                  style={{ background: fillFor(v) }}
                />
              );
            })}
          </Row>
        ))}
      </div>
      <div className="mt-3 h-4 text-xs text-fg-muted num">
        {hover ? (
          <>
            {hover.label || `${rowLabels?.[hover.row] ?? hover.row + 1} · ${colLabels?.[hover.col] ?? hover.col + 1}`}:{" "}
            <span className="text-fg">{hover.value}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

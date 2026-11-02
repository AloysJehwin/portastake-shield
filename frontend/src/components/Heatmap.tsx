import { useMemo, useState } from "react";

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

  const cell = 20;
  const gap = 3;

  return (
    <div>
      <table className="border-separate" style={{ borderSpacing: 0 }}>
        <thead>
          <tr>
            <th aria-hidden></th>
            {colLabels?.map((l, i) => (
              <th key={i} className="text-[11px] text-fg-subtle font-normal pb-1 px-0.5">
                {l}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, r) => (
            <tr key={r}>
              <td className="text-[11px] text-fg-muted pr-2 whitespace-nowrap">
                {rowLabels?.[r] ?? ""}
              </td>
              {Array.from({ length: cols }).map((_, c) => {
                const v = grid.m[r][c];
                const label = grid.labels[r][c];
                return (
                  <td key={c} className="p-0" style={{ paddingRight: gap, paddingBottom: gap }}>
                    <div
                      role="img"
                      aria-label={label || `${v}`}
                      onMouseEnter={() => setHover({ row: r, col: c, value: v, label })}
                      onMouseLeave={() => setHover(null)}
                      className="rounded-sm transition-colors"
                      style={{
                        width: cell,
                        height: cell,
                        background: fillFor(v),
                      }}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {hover && (
        <div className="mt-2 text-xs text-fg-muted num">
          {hover.label ?? `(${hover.row + 1},${hover.col + 1})`}: <span className="text-fg">{hover.value}</span>
        </div>
      )}
    </div>
  );
}

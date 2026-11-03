const PRESETS = [10, 50, 100] as const; // bps

export function SlippageControl({ bps, onChange }: { bps: number; onChange: (bps: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-fg-muted">Slippage</span>
      <div className="flex gap-1">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onChange(p)}
            className={`chip ${bps === p ? "border-fg text-fg" : ""}`}
          >
            {p / 100}%
          </button>
        ))}
      </div>
    </div>
  );
}

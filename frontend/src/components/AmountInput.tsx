import { formatUnits } from "viem";
import { formatUsd, formatPot } from "../format";

type Props = {
  label: string;
  symbol: string;
  decimals: number;
  value: string;
  onChange: (v: string) => void;
  max?: bigint;
  helper?: string;
};

export function AmountInput({ label, symbol, decimals, value, onChange, max, helper }: Props) {
  return (
    <label className="block">
      <div className="flex items-center justify-between text-xs text-fg-muted mb-1.5">
        <span>{label}</span>
        {max !== undefined && (
          <button
            type="button"
            onClick={() => onChange(formatUnits(max, decimals))}
            className="text-fg hover:underline"
          >
            Max {decimals === 6 ? formatUsd(max) : formatPot(max)}
          </button>
        )}
      </div>
      <div className="flex items-stretch gap-2">
        <input
          className="input num flex-1 text-right"
          inputMode="decimal"
          placeholder="0.00"
          value={value}
          onChange={(e) => onChange(sanitize(e.target.value, decimals))}
        />
        <span className="inline-flex items-center px-3 rounded-sm border border-line bg-surface text-sm text-fg">
          {symbol}
        </span>
      </div>
      {helper && <div className="mt-1 text-xs text-fg-subtle">{helper}</div>}
    </label>
  );
}

function sanitize(v: string, decimals: number): string {
  // Allow only digits + a single dot, cap decimals.
  v = v.replace(/,/g, ".").replace(/[^0-9.]/g, "");
  const parts = v.split(".");
  if (parts.length > 2) v = `${parts[0]}.${parts.slice(1).join("")}`;
  const [whole, frac = ""] = v.split(".");
  if (frac.length > decimals) return `${whole}.${frac.slice(0, decimals)}`;
  return v;
}

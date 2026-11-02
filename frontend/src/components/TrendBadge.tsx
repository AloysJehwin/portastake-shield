import { TrendingUp, TrendingDown, Minus } from "lucide-react";

/**
 * Status chip — status palette is reserved (success/danger), icon + label never
 * color-alone. Set `invertNegativeIsGood` when a drop is actually a good thing
 * (e.g. a shrinking reserve-draw).
 */
export function TrendBadge({
  deltaBps,
  invertNegativeIsGood = false,
}: {
  deltaBps: number | undefined;
  invertNegativeIsGood?: boolean;
}) {
  if (deltaBps === undefined || Number.isNaN(deltaBps)) return null;

  const up = deltaBps > 0;
  const flat = deltaBps === 0;
  const good = invertNegativeIsGood ? !up : up;
  const Icon = flat ? Minus : up ? TrendingUp : TrendingDown;
  const cls = flat ? "chip" : good ? "chip-success" : "chip-danger";
  const sign = up ? "+" : "";
  return (
    <span className={cls}>
      <Icon size={12} aria-hidden />
      <span className="num">{sign}{(deltaBps / 100).toFixed(2)}%</span>
    </span>
  );
}

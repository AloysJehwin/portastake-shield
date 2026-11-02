import type { ReactNode } from "react";

export function BalanceTile({
  label,
  value,
  secondary,
  trend,
}: {
  label: string;
  value: ReactNode;
  secondary?: ReactNode;
  trend?: ReactNode;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-fg-muted">{label}</div>
      <div className="num mt-1 text-xl text-fg">{value}</div>
      {secondary && <div className="num text-sm text-fg-muted">{secondary}</div>}
      {trend && <div className="mt-2">{trend}</div>}
    </div>
  );
}

import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";

/**
 * Reusable card header with an eyebrow icon, uppercase title, and an optional
 * action (dropdown, link, button). Matches the pattern on every card in the
 * reference dashboard — tight line, small icon, and a 24px CTA on the far right.
 */
export function CardHeader({
  icon,
  title,
  action,
  to,
}: {
  icon?: ReactNode;
  title: string;
  action?: ReactNode;
  to?: string;
}) {
  return (
    <header className="flex items-center justify-between gap-3 mb-5">
      <div className="flex items-center gap-2 text-fg-muted">
        {icon && <span className="inline-flex items-center">{icon}</span>}
        <h3 className="text-xs uppercase tracking-widest font-medium">{title}</h3>
      </div>
      <div className="flex items-center gap-2">
        {action}
        {to && (
          <Link
            to={to}
            className="inline-flex items-center justify-center w-7 h-7 rounded-sm border border-line hover:border-line-strong"
          >
            <ArrowUpRight size={14} />
          </Link>
        )}
      </div>
    </header>
  );
}

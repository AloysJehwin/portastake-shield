import type { ReactNode } from "react";
import { timeAgo } from "../format";

export function EventRow({
  icon,
  title,
  detail,
  timestamp,
  href,
  trailing,
}: {
  icon: ReactNode;
  title: string;
  detail?: ReactNode;
  timestamp?: bigint | number;
  href?: string;
  /** Right-aligned slot, e.g. an explorer link. */
  trailing?: ReactNode;
}) {
  const content = (
    <div className="flex items-center gap-3 py-3">
      <span className="inline-flex items-center justify-center w-8 h-8 rounded-sm bg-surface border border-line text-fg-muted">
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-fg truncate">{title}</div>
        {detail && <div className="text-xs text-fg-muted truncate">{detail}</div>}
      </div>
      {timestamp !== undefined && <div className="text-xs text-fg-subtle num">{timeAgo(timestamp)}</div>}
      {trailing && <div className="shrink-0">{trailing}</div>}
    </div>
  );
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="block hover:bg-white/40 rounded-sm px-2 -mx-2">
      {content}
    </a>
  ) : (
    <div className="px-2 -mx-2">{content}</div>
  );
}

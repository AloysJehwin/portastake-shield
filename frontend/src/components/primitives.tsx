import { type ReactNode, type ButtonHTMLAttributes, forwardRef } from "react";

/** Solid elevated surface — tables, forms, dense content. */
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card p-4 sm:p-5 min-w-0 ${className}`}>{children}</div>;
}

/** Frosted glass surface — hero cards, summary panels. */
export function GlassCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card-glass p-5 sm:p-6 min-w-0 ${className}`}>{children}</div>;
}

export function Section({
  title,
  action,
  children,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-8">
      {(title || action) && (
        <header className="mb-3 flex items-center justify-between">
          {title && <h2 className="text-sm font-medium text-fg-muted uppercase tracking-wider">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", loading, children, className = "", disabled, ...rest },
  ref,
) {
  const cls =
    variant === "primary" ? "btn-primary" : variant === "secondary" ? "btn-secondary" : "btn-ghost";
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={`${cls} ${className}`.trim()}
      {...rest}
    >
      {loading ? <span className="animate-pulse">…</span> : children}
    </button>
  );
});

export function Divider({ className = "" }: { className?: string }) {
  return <hr className={`border-0 border-t border-line ${className}`} />;
}

export function Empty({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-md border border-dashed border-line p-10 text-center">
      {icon && <div className="mb-3 inline-flex text-fg-subtle">{icon}</div>}
      <p className="text-fg font-medium">{title}</p>
      {hint && <p className="mt-1 text-sm text-fg-muted">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function KeyValue({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <span className="text-sm text-fg-muted">{label}</span>
      <span className="text-right">
        <span className="text-fg num text-sm">{value}</span>
        {hint && <div className="text-xs text-fg-subtle">{hint}</div>}
      </span>
    </div>
  );
}

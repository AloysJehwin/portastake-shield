import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";

/**
 * Headless dropdown that renders as a small chip — matches the "Daily / Weekly"
 * selectors on the reference dashboard. Controlled component; the parent owns
 * the selected key.
 */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function off(e: MouseEvent) {
      if (
        !btnRef.current?.contains(e.target as Node) &&
        !popRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div className="relative inline-block">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs bg-surface border border-line text-fg hover:border-line-strong"
      >
        {current?.label ?? "—"}
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <div
          ref={popRef}
          role="listbox"
          className="absolute right-0 top-full mt-1 min-w-[8rem] bg-bg border border-line rounded-sm shadow-sm z-10 py-1"
        >
          {options.map((o) => (
            <button
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className="w-full flex items-center justify-between gap-3 px-3 h-8 text-xs text-fg hover:bg-surface"
            >
              {o.label}
              {o.value === value && <Check size={12} aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

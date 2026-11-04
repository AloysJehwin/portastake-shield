import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";

export type SelectOption<T extends string | number> = {
  value: T;
  label: string;
  /** Small text under or after the label, e.g. a token symbol. */
  hint?: string;
  /** Leading visual, e.g. a coloured dot. */
  icon?: ReactNode;
};

/**
 * Keyboard and pointer logic shared by every dropdown in the app: open/close, outside click,
 * Escape, arrow keys, Home/End, Enter/Space to pick, and focus back on the trigger.
 */
function useListbox<T extends string | number>(options: ReadonlyArray<SelectOption<T>>, value: T, onChange: (v: T) => void) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const off = (e: PointerEvent) => {
      if (!triggerRef.current?.contains(e.target as Node) && !listRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", off);
    return () => document.removeEventListener("pointerdown", off);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function pick(i: number) {
    const o = options[i];
    if (!o) return;
    onChange(o.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent) {
    const last = options.length - 1;
    const keys: Record<string, () => void> = {
      ArrowDown: () => (open ? setActive((a) => Math.min(last, a + 1)) : setOpen(true)),
      ArrowUp: () => (open ? setActive((a) => Math.max(0, a - 1)) : setOpen(true)),
      Home: () => open && setActive(0),
      End: () => open && setActive(last),
      Enter: () => (open ? pick(active) : setOpen(true)),
      " ": () => (open ? pick(active) : setOpen(true)),
      Escape: () => setOpen(false),
      Tab: () => setOpen(false),
    };
    const run = keys[e.key];
    if (!run) return;
    if (e.key !== "Tab") e.preventDefault();
    run();
  }

  return { open, setOpen, active, setActive, triggerRef, listRef, pick, onKeyDown, listId: `${id}-list` };
}

/** The floating list both dropdown variants share: frosted, like the rest of the app. */
function Popover<T extends string | number>({
  lb,
  options,
  value,
  align,
  label,
  dense,
}: {
  lb: ReturnType<typeof useListbox<T>>;
  options: ReadonlyArray<SelectOption<T>>;
  value: T;
  align: "stretch" | "right";
  label?: string;
  dense?: boolean;
}) {
  if (!lb.open) return null;
  return (
    <div
      ref={lb.listRef}
      id={lb.listId}
      role="listbox"
      aria-label={label}
      className={`absolute z-30 top-full mt-1.5 p-1 max-h-72 overflow-auto rounded-md border border-white/60 ring-1 ring-black/5 bg-white/[0.97] backdrop-blur-xl shadow-[0_12px_32px_rgba(0,0,0,0.10)] ${
        align === "stretch" ? "left-0 right-0" : "right-0 min-w-[9rem]"
      }`}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <div
            key={String(o.value)}
            role="option"
            data-index={i}
            aria-selected={selected}
            onPointerEnter={() => lb.setActive(i)}
            onClick={() => lb.pick(i)}
            className={`flex items-center gap-2.5 px-2.5 rounded-sm cursor-pointer select-none ${dense ? "h-8 text-xs" : "min-h-10 py-1.5 text-sm"} ${
              i === lb.active ? "bg-fg/[0.06]" : ""
            } ${selected ? "text-fg font-medium" : "text-fg/80"}`}
          >
            {o.icon}
            <span className="flex-1 min-w-0 truncate">{o.label}</span>
            {o.hint && <span className="text-xs text-fg-subtle shrink-0">{o.hint}</span>}
            <Check size={dense ? 12 : 14} className={`shrink-0 ${selected ? "opacity-100" : "opacity-0"}`} aria-hidden />
          </div>
        );
      })}
    </div>
  );
}

/** A form-field dropdown, sized like `.input`. Use in place of a native <select>. */
export function Select<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled,
  className = "",
}: {
  value: T;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (v: T) => void;
  /** Accessible name when there is no visible <label>. */
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  const lb = useListbox(options, value, onChange);
  const current = options.find((o) => o.value === value);
  const single = options.length <= 1;
  return (
    <div className={`relative ${className}`}>
      <button
        ref={lb.triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={lb.open}
        aria-controls={lb.listId}
        aria-label={label}
        disabled={disabled}
        onClick={() => !single && lb.setOpen((o) => !o)}
        onKeyDown={single ? undefined : lb.onKeyDown}
        className={`w-full h-11 px-3 inline-flex items-center gap-2.5 rounded-sm bg-bg border text-sm text-fg text-left transition-colors ${
          lb.open ? "border-line-strong ring-2 ring-fg/5" : "border-line hover:border-line-strong"
        } ${single ? "cursor-default" : ""}`}
      >
        {current?.icon}
        <span className="flex-1 min-w-0 truncate">{current?.label ?? "Select…"}</span>
        {current?.hint && <span className="text-xs text-fg-subtle shrink-0">{current.hint}</span>}
        {!single && (
          <ChevronDown size={14} className={`shrink-0 text-fg-muted transition-transform ${lb.open ? "rotate-180" : ""}`} aria-hidden />
        )}
      </button>
      <Popover lb={lb} options={options} value={value} align="stretch" label={label} />
    </div>
  );
}

/** A compact chip dropdown for card headers ("Weekly", "Last 14 days"). */
export function ChipSelect<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (v: T) => void;
  label?: string;
}) {
  const lb = useListbox(options, value, onChange);
  const current = options.find((o) => o.value === value);
  return (
    <div className="relative inline-block">
      <button
        ref={lb.triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={lb.open}
        aria-controls={lb.listId}
        aria-label={label}
        onClick={() => lb.setOpen((o) => !o)}
        onKeyDown={lb.onKeyDown}
        className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs bg-white/70 border text-fg transition-colors ${
          lb.open ? "border-line-strong" : "border-line hover:border-line-strong"
        }`}
      >
        {current?.label ?? "—"}
        <ChevronDown size={12} className={`transition-transform ${lb.open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      <Popover lb={lb} options={options} value={value} align="right" label={label} dense />
    </div>
  );
}

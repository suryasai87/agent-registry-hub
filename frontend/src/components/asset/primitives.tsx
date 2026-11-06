// Small building blocks shared by the catalog, home and entity tabs: copy button, inline error card,
// segmented control, data table shell, chart frame with "view as table", meters and an accessible menu.
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, Copy, RotateCcw, Table2, TriangleAlert, ChartColumn } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cx } from "../../lib/cx";
import { Button, Card, IconButton, Skeleton, useToast } from "../ui";
import { readErrorMessage } from "./errors";

const BTN_ICON = { size: 14, "aria-hidden": true } as const;

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea fallback */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Icon button that copies ``value``; confirms with a check mark and a toast. */
export function CopyButton({ value, label = "Copy", onCopied, size = "sm", className }: { value: string; label?: string; onCopied?: () => void; size?: "sm" | "md"; className?: string }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1600);
    return () => {
      clearTimeout(t);
    };
  }, [done]);
  return (
    <IconButton
      size={size}
      label={label}
      className={className}
      icon={done ? <Check {...BTN_ICON} className="text-success" /> : <Copy {...BTN_ICON} />}
      onClick={async () => {
        const ok = await copyText(value);
        if (ok) {
          setDone(true);
          toast.success("Copied to clipboard");
          onCopied?.();
        } else toast.error("Copy failed", "Your browser blocked clipboard access.");
      }}
    />
  );
}

/** Inline read-failure card with a retry. Never blocks the page around it. */
export function ErrorCard({ error, onRetry, title = "Couldn't load this section", className }: { error: unknown; onRetry?: () => void; title?: string; className?: string }) {
  return (
    <div role="alert" className={cx("flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/5 p-4", className)}>
      <TriangleAlert size={18} className="mt-0.5 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-ui-base font-semibold">{title}</div>
        <p className="mt-0.5 break-words text-ui-sm text-muted-foreground">{readErrorMessage(error)}</p>
      </div>
      {onRetry && (
        <Button size="sm" variant="secondary" icon={<RotateCcw {...BTN_ICON} />} onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/** Content-shaped skeleton for a table. */
export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="space-y-2">
      <Skeleton className="h-8 w-full" />
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className={cx("h-6", c === 0 ? "w-1/3" : "flex-1")} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SectionSkeleton({ blocks = 3 }: { blocks?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={i} className="space-y-2 !p-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-24" />
          </Card>
        ))}
      </div>
      {Array.from({ length: blocks - 1 }, (_, i) => (
        <Skeleton key={i} className="h-48 w-full rounded-xl" />
      ))}
    </div>
  );
}

/** Radio-like segmented control built from native buttons with aria-pressed. */
export function Segmented<T extends string | number>({ value, onChange, options, label, size = "sm", className }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; icon?: ReactNode; title?: string }[]; label: string; size?: "sm" | "md"; className?: string }) {
  return (
    <div role="group" aria-label={label} className={cx("inline-flex rounded-lg border border-border bg-background/40 p-0.5", className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={active}
            title={o.title}
            aria-label={o.title}
            onClick={() => onChange(o.value)}
            className={cx(
              "relative inline-flex items-center gap-1.5 rounded-md font-semibold transition-colors",
              size === "sm" ? "h-7 px-2.5 text-ui-sm" : "h-8 px-3 text-ui-base",
              active ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active && <motion.span layoutId={`${label}-seg`} transition={{ type: "spring", stiffness: 500, damping: 30 }} className="absolute inset-0 rounded-md bg-primary" />}
            <span className="relative inline-flex items-center gap-1.5">
              {o.icon}
              {o.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Table shell: horizontal scroll, sticky header styling, consistent cell padding. */
export function DataTable({ children, label, className, dense = false }: { children: ReactNode; label: string; className?: string; dense?: boolean }) {
  return (
    <div className={cx("overflow-x-auto rounded-xl border border-border", className)}>
      <table aria-label={label} className={cx("w-full border-collapse text-left text-ui-sm", dense ? "[&_td]:py-1.5 [&_th]:py-1.5" : "[&_td]:py-2.5 [&_th]:py-2")}>
        {children}
      </table>
    </div>
  );
}

export function Th({ children, className, align = "left" }: { children?: ReactNode; className?: string; align?: "left" | "right" | "center" }) {
  return (
    <th scope="col" className={cx("whitespace-nowrap border-b border-border bg-muted/40 px-3 text-ui-xs font-semibold uppercase tracking-wide text-muted-foreground", align === "right" && "text-right", align === "center" && "text-center", className)}>
      {children}
    </th>
  );
}

export function Td({ children, className, align = "left", colSpan }: { children?: ReactNode; className?: string; align?: "left" | "right" | "center"; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={cx("border-b border-border/60 px-3 align-middle", align === "right" && "text-right tabular-nums", align === "center" && "text-center", className)}>
      {children}
    </td>
  );
}

/** A chart card with a title, an aria summary and a "View as table" toggle (WCAG: a non-visual alternative). */
export function ChartFrame({ title, summary, actions, table, children, className, height = 220 }: { title: ReactNode; summary: string; actions?: ReactNode; table: ReactNode; children: ReactNode; className?: string; height?: number }) {
  const [asTable, setAsTable] = useState(false);
  const titleId = useId();
  return (
    <Card className={cx("!p-4", className)}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={titleId} className="text-ui-md font-bold">{title}</h3>
          <p className="text-ui-xs text-muted-foreground">{summary}</p>
        </div>
        <div className="flex items-center gap-2">
          {actions}
          <Button size="sm" variant="ghost" aria-pressed={asTable} icon={asTable ? <ChartColumn {...BTN_ICON} /> : <Table2 {...BTN_ICON} />} onClick={() => setAsTable((v) => !v)}>
            {asTable ? "View as chart" : "View as table"}
          </Button>
        </div>
      </div>
      {asTable ? (
        <div className="max-h-[320px] overflow-auto">{table}</div>
      ) : (
        <div role="img" aria-labelledby={titleId} aria-describedby={`${titleId}-sum`} className="text-ui-xs" style={{ height }}>
          <span id={`${titleId}-sum`} className="sr-only">{summary}</span>
          {children}
        </div>
      )}
    </Card>
  );
}

/** Horizontal meter with a numeric label (never colour alone). */
export function Meter({ value, label, tone = "primary", className, showValue = true }: { value: number; label: string; tone?: "primary" | "success" | "warning" | "destructive"; className?: string; showValue?: boolean }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  const bar = { primary: "bg-primary", success: "bg-success", warning: "bg-warning", destructive: "bg-destructive" }[tone];
  return (
    <div className={cx("flex items-center gap-2", className)}>
      <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} aria-valuetext={`${v}%`} className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <motion.div className={cx("h-full rounded-full", bar)} initial={{ width: 0 }} animate={{ width: `${v}%` }} transition={{ duration: 0.6, ease: "easeOut" }} />
      </div>
      {showValue && <span className="w-10 text-right text-ui-sm font-semibold tabular-nums">{v}%</span>}
    </div>
  );
}

export function toneForPct(v: number): "success" | "warning" | "destructive" {
  return v >= 80 ? "success" : v >= 50 ? "warning" : "destructive";
}

export interface MenuItemDef {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}

/** Accessible menu button (WAI-ARIA menu): arrow keys, Home/End, Escape, click outside. */
export function MenuButton({ label, icon, items, align = "right", buttonLabel, variant = "secondary" }: { label: string; icon?: ReactNode; items: MenuItemDef[]; align?: "left" | "right"; buttonLabel?: ReactNode; variant?: "secondary" | "ghost" }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) itemRefs.current[active]?.focus();
  }, [open, active]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const onKey = (e: ReactKeyboardEvent) => {
    if (!enabled.length) return;
    const pos = Math.max(0, enabled.indexOf(active));
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(enabled[(pos + 1) % enabled.length]);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(enabled[(pos - 1 + enabled.length) % enabled.length]);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(enabled[0]);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(enabled[enabled.length - 1]);
    } else if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      close(e.key === "Escape");
    }
  };

  return (
    <div ref={wrap} className="relative">
      <Button
        ref={triggerRef}
        variant={variant}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={buttonLabel ? undefined : label}
        title={label}
        className={buttonLabel ? undefined : "!px-0 w-9"}
        icon={icon}
        onClick={() => {
          setActive(enabled[0] ?? 0);
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setActive(enabled[0] ?? 0);
            setOpen(true);
          }
        }}
      >
        {buttonLabel}
        {buttonLabel && <ChevronDown size={14} aria-hidden />}
      </Button>
      <AnimatePresence>
        {open && (
          <motion.div
            id={menuId}
            role="menu"
            aria-label={label}
            onKeyDown={onKey}
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
            className={cx("absolute z-50 mt-1 min-w-[220px] rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl", align === "right" ? "right-0" : "left-0")}
          >
            {items.map((it, i) => (
              <button
                key={it.id}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={i === active ? 0 : -1}
                disabled={it.disabled}
                title={it.hint}
                onMouseEnter={() => !it.disabled && setActive(i)}
                onClick={() => {
                  close(false);
                  it.onSelect();
                }}
                className={cx(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-ui-base font-medium disabled:cursor-not-allowed disabled:opacity-45",
                  i === active && "bg-accent",
                  it.danger ? "text-destructive" : "text-foreground",
                )}
              >
                <span className="shrink-0 text-muted-foreground">{it.icon}</span>
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Banner (info / warning / danger) with icon + text; pass ``role="alert"`` for urgent ones. */
export function Banner({ tone = "warning", icon, title, children, actions, className, role }: { tone?: "info" | "warning" | "danger" | "success"; icon?: ReactNode; title: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string; role?: "alert" | "status" }) {
  const tones = {
    info: "border-info/40 bg-info/8 text-info",
    warning: "border-warning/45 bg-warning/10 text-warning",
    danger: "border-destructive/45 bg-destructive/10 text-destructive",
    success: "border-success/40 bg-success/10 text-success",
  }[tone];
  return (
    <div role={role} className={cx("flex flex-wrap items-start gap-3 rounded-xl border px-4 py-3", tones, className)}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1 text-foreground">
        <div className="text-ui-base font-semibold">{title}</div>
        {children && <div className="mt-0.5 text-ui-sm text-muted-foreground">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Pretty-printed, collapsible JSON with a copy button. */
export function JsonViewer({ value, label = "JSON", defaultOpen = false, maxHeight = 320 }: { value: unknown; label?: string; defaultOpen?: boolean; maxHeight?: number }) {
  const [open, setOpen] = useState(defaultOpen);
  const text = (() => {
    try {
      return JSON.stringify(value, null, 2) ?? "null";
    } catch {
      return String(value);
    }
  })();
  const regionId = useId();
  return (
    <div className="rounded-lg border border-border bg-background/40">
      <div className="flex items-center justify-between gap-2 px-2 py-1">
        <button type="button" aria-expanded={open} aria-controls={regionId} onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-ui-sm font-semibold text-muted-foreground hover:text-foreground">
          <ChevronDown size={14} aria-hidden className={cx("transition-transform", !open && "-rotate-90")} />
          {label}
        </button>
        <CopyButton value={text} label={`Copy ${label}`} />
      </div>
      {open && (
        <pre id={regionId} className="overflow-auto border-t border-border px-3 py-2 font-mono text-ui-xs leading-relaxed" style={{ maxHeight }}>
          {text}
        </pre>
      )}
    </div>
  );
}

/** A label/value list for side cards. */
export function DefinitionList({ items, className }: { items: { label: ReactNode; value: ReactNode; key?: string }[]; className?: string }) {
  return (
    <dl className={cx("grid grid-cols-[minmax(90px,auto)_1fr] gap-x-4 gap-y-2 text-ui-sm", className)}>
      {items.map((it, i) => (
        <div key={it.key ?? i} className="contents">
          <dt className="text-muted-foreground">{it.label}</dt>
          <dd className="min-w-0 break-words font-medium">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

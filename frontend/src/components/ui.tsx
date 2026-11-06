// Shared UI kit. Native semantics first (button, select, input, role="dialog"/"tablist"/"switch"), visible focus
// rings from --ring, and the shared motion grammar from lib/motion.
import { AnimatePresence, motion, type HTMLMotionProps } from "framer-motion";
import {
  Bot,
  ChevronDown,
  CircleCheck,
  CircleX,
  Info,
  LoaderCircle,
  Minus,
  Server,
  Sparkles,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";
import { entrance, settle, spring } from "../lib/motion";

// ------------------------------------------------------------------------------------------------ surfaces
export function Card({ className, interactive = false, children, ...rest }: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cx(
        "rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm",
        interactive && "transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function SectionTitle({ title, subtitle, actions, id, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; id?: string; className?: string }) {
  return (
    <div className={cx("mb-3 flex flex-wrap items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2 id={id} className="text-ui-lg font-bold tracking-tight">{title}</h2>
        {subtitle && <p className="mt-0.5 text-ui-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Page title row: title + optional source pill, subtitle, and right-aligned actions. */
export function PageHeader({ title, subtitle, actions, source, icon }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; source?: ReactNode; icon?: ReactNode }) {
  return (
    <motion.header {...entrance} className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        {icon && <div className="mt-1 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary">{icon}</div>}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-ui-2xl font-extrabold tracking-tight">{title}</h1>
            {source}
          </div>
          {subtitle && <p className="mt-1 max-w-3xl text-ui-md text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </motion.header>
  );
}

// ------------------------------------------------------------------------------------------------ badges
export type BadgeVariant = "neutral" | "primary" | "success" | "warning" | "destructive" | "info" | "agent" | "mcp" | "tool" | "skill";

const BADGE: Record<BadgeVariant, string> = {
  neutral: "border-border bg-secondary text-secondary-foreground",
  primary: "border-primary/35 bg-primary/15 text-primary",
  success: "border-success/35 bg-success/15 text-success",
  warning: "border-warning/35 bg-warning/15 text-warning",
  destructive: "border-destructive/35 bg-destructive/15 text-destructive",
  info: "border-info/35 bg-info/15 text-info",
  agent: "border-type-agent/35 bg-type-agent/15 text-type-agent",
  mcp: "border-type-mcp/35 bg-type-mcp/15 text-type-mcp",
  tool: "border-type-tool/35 bg-type-tool/15 text-type-tool",
  skill: "border-type-skill/35 bg-type-skill/15 text-type-skill",
};

export function Badge({ variant = "neutral", icon, children, className, title }: { variant?: BadgeVariant; icon?: ReactNode; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-ui-xs font-semibold leading-tight", BADGE[variant], className)}>
      {icon}
      {children}
    </span>
  );
}

export type EntityType = "agent" | "mcp" | "tool" | "skill";

export const ENTITY_TYPES: Record<EntityType, { label: string; plural: string; icon: LucideIcon }> = {
  agent: { label: "Agent", plural: "Agents", icon: Bot },
  mcp: { label: "MCP server", plural: "MCP servers", icon: Server },
  tool: { label: "Tool", plural: "Tools", icon: Wrench },
  skill: { label: "Skill", plural: "Skills", icon: Sparkles },
};

/** Icon-tile tone per entity type (static class names so Tailwind can see them). */
export const TYPE_TONE: Record<EntityType, string> = {
  agent: "bg-type-agent/15 text-type-agent",
  mcp: "bg-type-mcp/15 text-type-mcp",
  tool: "bg-type-tool/15 text-type-tool",
  skill: "bg-type-skill/15 text-type-skill",
};

export function TypeBadge({ type, className }: { type: EntityType; className?: string }) {
  const { label, icon: Icon } = ENTITY_TYPES[type];
  return (
    <Badge variant={type} icon={<Icon size={12} aria-hidden />} className={className}>
      {label}
    </Badge>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cx("rounded border border-border bg-muted px-1.5 py-px font-mono text-ui-xs text-muted-foreground", className)}>{children}</kbd>;
}

// ------------------------------------------------------------------------------------------------ buttons
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-primary text-primary-foreground shadow-sm hover:brightness-110",
  secondary: "border-border bg-secondary text-secondary-foreground hover:border-primary/40 hover:bg-accent",
  ghost: "border-transparent bg-transparent text-foreground hover:bg-accent",
  danger: "border-transparent bg-destructive text-white shadow-sm hover:brightness-110",
};
const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-7 gap-1.5 px-2.5 text-ui-sm",
  md: "h-9 gap-2 px-3.5 text-ui-base",
  lg: "h-11 gap-2 px-5 text-ui-md",
};
const ICON_SIZE: Record<ButtonSize, string> = { sm: "h-7 w-7", md: "h-9 w-9", lg: "h-11 w-11" };

export interface ButtonProps extends Omit<HTMLMotionProps<"button">, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
}

export function Button({ variant = "primary", size = "md", loading = false, icon, children, className, disabled, type = "button", ...rest }: ButtonProps) {
  const inert = disabled || loading;
  return (
    <motion.button
      type={type}
      disabled={inert}
      aria-busy={loading || undefined}
      whileHover={inert ? undefined : { y: -1 }}
      whileTap={inert ? undefined : { scale: 0.97 }}
      transition={spring}
      className={cx(
        "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-lg border font-semibold transition-[background-color,border-color,filter] disabled:cursor-not-allowed disabled:opacity-50",
        BUTTON_VARIANT[variant],
        BUTTON_SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle size={size === "sm" ? 13 : 15} className="animate-spin" aria-hidden /> : icon}
      {children}
    </motion.button>
  );
}

export function IconButton({ label, icon, variant = "ghost", size = "md", className, ...rest }: Omit<ButtonProps, "children"> & { label: string; icon: ReactNode }) {
  return (
    <Button aria-label={label} title={label} variant={variant} size={size} className={cx("!px-0", ICON_SIZE[size], className)} {...rest}>
      {icon}
    </Button>
  );
}

// ------------------------------------------------------------------------------------------------ tabs
export interface TabItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
}

function hashTab(ids: string[]): string | null {
  const raw = typeof window === "undefined" ? "" : decodeURIComponent(window.location.hash.slice(1));
  return ids.includes(raw) ? raw : null;
}

/**
 * Accessible tabs (arrow keys, Home/End). With ``syncHash`` (default) the active tab is mirrored to the URL hash
 * (#tab-id), so tabs are linkable and survive reloads. Controlled with ``value``/``onChange`` or uncontrolled.
 */
export function Tabs({
  tabs,
  value,
  defaultValue,
  onChange,
  syncHash = true,
  className,
  children,
}: {
  tabs: TabItem[];
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
  syncHash?: boolean;
  className?: string;
  children?: (active: string) => ReactNode;
}) {
  const baseId = useId();
  const ids = tabs.map((t) => t.id);
  const idsKey = ids.join("|");
  const [internal, setInternal] = useState<string>(() => (syncHash && hashTab(ids)) || defaultValue || tabs.find((t) => !t.disabled)?.id || "");
  const active = value ?? internal;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!syncHash) return;
    const onHash = () => {
      const next = hashTab(idsKey.split("|"));
      if (next) {
        setInternal(next);
        onChangeRef.current?.(next);
      }
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
    };
  }, [syncHash, idsKey]);

  const select = (id: string) => {
    setInternal(id);
    onChange?.(id);
    if (syncHash) window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${encodeURIComponent(id)}`);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const enabled = tabs.map((t, i) => (t.disabled ? -1 : i)).filter((i) => i >= 0);
    if (enabled.length === 0) return;
    const pos = enabled.indexOf(tabs.findIndex((t) => t.id === active));
    let next: number | null = null;
    if (e.key === "ArrowRight") next = enabled[(pos + 1) % enabled.length];
    else if (e.key === "ArrowLeft") next = enabled[(pos - 1 + enabled.length) % enabled.length];
    else if (e.key === "Home") next = enabled[0];
    else if (e.key === "End") next = enabled[enabled.length - 1];
    if (next === null) return;
    e.preventDefault();
    select(tabs[next].id);
    refs.current[next]?.focus();
  };

  return (
    <div className={className}>
      <div role="tablist" aria-orientation="horizontal" onKeyDown={onKeyDown} className="relative flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map((t, i) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={children ? `${baseId}-panel-${t.id}` : undefined}
              tabIndex={selected ? 0 : -1}
              disabled={t.disabled}
              onClick={() => select(t.id)}
              className={cx(
                "relative inline-flex items-center gap-2 whitespace-nowrap px-3 py-2 text-ui-base font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                selected ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.icon}
              {t.label}
              {t.badge}
              {selected && <motion.span layoutId={`${baseId}-underline`} transition={spring} className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-primary" />}
            </button>
          );
        })}
      </div>
      {children && (
        <div role="tabpanel" id={`${baseId}-panel-${active}`} aria-labelledby={`${baseId}-tab-${active}`} tabIndex={0} className="pt-4">
          {children(active)}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ data display
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx("animate-pulse rounded-md bg-muted", className)} />;
}

const pct = (d: number) => `${d > 0 ? "+" : ""}${Number.isInteger(d) ? d : d.toFixed(1)}%`;

/** A KPI: value, optional delta (green when it moves the good way), icon, hint and a sparkline slot. */
export function KpiTile({
  label,
  value,
  delta,
  deltaLabel,
  formatDelta = pct,
  invertDelta = false,
  icon,
  sparkline,
  hint,
  loading = false,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  delta?: number | null;
  deltaLabel?: ReactNode;
  formatDelta?: (delta: number) => string;
  invertDelta?: boolean;
  icon?: ReactNode;
  sparkline?: ReactNode;
  hint?: ReactNode;
  loading?: boolean;
  className?: string;
}) {
  const up = delta != null && delta > 0;
  const down = delta != null && delta < 0;
  const good = invertDelta ? down : up;
  const bad = invertDelta ? up : down;
  const Trend = up ? TrendingUp : down ? TrendingDown : Minus;
  return (
    <Card className={cx("flex flex-col gap-2 !p-4", className)}>
      <div className="flex items-center justify-between gap-2 text-ui-sm font-medium text-muted-foreground">
        <span className="truncate">{label}</span>
        {icon && <span className="text-primary">{icon}</span>}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          {loading ? <Skeleton className="h-8 w-20" /> : <div className="text-ui-2xl font-extrabold leading-none tabular-nums">{value}</div>}
          {delta != null && !loading && (
            <div className={cx("mt-1.5 inline-flex items-center gap-1 text-ui-xs font-semibold", good && "text-success", bad && "text-destructive", !good && !bad && "text-muted-foreground")}>
              <Trend size={12} aria-hidden />
              {formatDelta(delta)}
              {deltaLabel && <span className="font-normal text-muted-foreground">{deltaLabel}</span>}
            </div>
          )}
        </div>
        {sparkline && <div className="h-10 w-24 shrink-0">{sparkline}</div>}
      </div>
      {hint && <div className="text-ui-xs text-muted-foreground">{hint}</div>}
    </Card>
  );
}

export const Stat = KpiTile;

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <motion.div {...entrance} className={cx("flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border px-6 py-12 text-center", className)}>
      {icon && <div className="mb-1 grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground">{icon}</div>}
      <div className="text-ui-md font-bold">{title}</div>
      {description && <p className="max-w-md text-ui-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </motion.div>
  );
}

export function initials(email: string, name?: string | null): string {
  const source = (name && name.trim()) || email.split("@")[0] || "?";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** A stable hue (0-359) per key, so a person keeps their avatar color everywhere. */
export function avatarHue(key: string): number {
  let h = 0;
  for (const ch of key.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

export function Avatar({ email, name, size = 28, className }: { email: string; name?: string | null; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      title={name || email}
      className={cx("inline-grid shrink-0 select-none place-items-center rounded-full font-bold text-white", className)}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.4)), background: `hsl(${avatarHue(email)} 55% 42%)` }}
    >
      {initials(email, name)}
    </span>
  );
}

// ------------------------------------------------------------------------------------------------ toasts
export type ToastKind = "success" | "error" | "info" | "warning";

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
  action?: ToastAction;
}

/** An optional inline action on a toast (e.g. "Undo"). Clicking it runs ``onClick`` and dismisses the toast. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  kind?: ToastKind;
  title: string;
  description?: string;
  /** Milliseconds; 0 keeps it until dismissed. Default 4.5 s (errors 7 s). */
  duration?: number;
  action?: ToastAction;
}

export interface ToastApi {
  toast: (options: ToastOptions) => number;
  success: (title: string, description?: string) => number;
  error: (title: string, description?: string) => number;
  info: (title: string, description?: string) => number;
  warning: (title: string, description?: string) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TOAST_ICON: Record<ToastKind, { icon: LucideIcon; tone: string }> = {
  success: { icon: CircleCheck, tone: "text-success" },
  error: { icon: CircleX, tone: "text-destructive" },
  info: { icon: Info, tone: "text-info" },
  warning: { icon: TriangleAlert, tone: "text-warning" },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const toast = useCallback(
    ({ kind = "info", title, description, duration, action }: ToastOptions) => {
      seq.current += 1;
      const id = seq.current;
      setItems((xs) => [...xs.slice(-4), { id, kind, title, description, action }]);
      const ms = duration ?? (kind === "error" ? 7000 : 4500);
      if (ms > 0) timers.current.set(id, setTimeout(() => dismiss(id), ms));
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
    };
  }, []);

  const value = useMemo<ToastApi>(
    () => ({
      toast,
      dismiss,
      success: (title, description) => toast({ kind: "success", title, description }),
      error: (title, description) => toast({ kind: "error", title, description }),
      info: (title, description) => toast({ kind: "info", title, description }),
      warning: (title, description) => toast({ kind: "warning", title, description }),
    }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
        <AnimatePresence initial={false}>
          {items.map((t) => {
            const { icon: Icon, tone } = TOAST_ICON[t.kind];
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: 12, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, x: 24 }}
                transition={{ duration: 0.25, ease: "easeOut" }}
                role={t.kind === "error" ? "alert" : "status"}
                className="pointer-events-auto flex items-start gap-3 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl"
              >
                <Icon size={18} className={cx("mt-0.5 shrink-0", tone)} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="text-ui-base font-semibold">{t.title}</div>
                  {t.description && <div className="mt-0.5 break-words text-ui-sm text-muted-foreground">{t.description}</div>}
                  {t.action && (
                    <button
                      type="button"
                      onClick={() => {
                        t.action?.onClick();
                        dismiss(t.id);
                      }}
                      className="mt-1.5 rounded-md border border-border px-2 py-0.5 text-ui-sm font-semibold text-primary hover:bg-accent"
                    >
                      {t.action.label}
                    </button>
                  )}
                </div>
                <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(t.id)} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
                  <X size={14} aria-hidden />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast() must be used inside <ToastProvider>");
  return ctx;
}

// ------------------------------------------------------------------------------------------------ overlays
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Focus management for overlays: focuses [data-autofocus] (else the container) on open, keeps Tab inside,
 * closes on Escape, and returns focus to the previously focused element on close.
 */
export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T>(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = ref.current;
    (node?.querySelector<HTMLElement>("[data-autofocus]") ?? node)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getAttribute("aria-hidden") !== "true");
      if (items.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || current === node || !node.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !node.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [open]);

  return ref;
}

const MODAL_SIZE = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" } as const;

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof MODAL_SIZE;
  className?: string;
}) {
  const ref = useFocusTrap<HTMLDivElement>(open, onClose);
  const titleId = useId();
  const descId = useId();
  return createPortal(
    <AnimatePresence>
      {open && (
        <div key="modal" className="fixed inset-0 z-[90] flex items-center justify-center p-4">
          <motion.div aria-hidden className="absolute inset-0 bg-black/60 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} onClick={onClose} />
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descId : undefined}
            tabIndex={-1}
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className={cx("relative flex max-h-[calc(100vh-2rem)] w-full flex-col rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl focus:outline-none", MODAL_SIZE[size], className)}
          >
            <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <h2 id={titleId} className="text-ui-lg font-bold">{title}</h2>
                {description && <p id={descId} className="mt-0.5 text-ui-sm text-muted-foreground">{description}</p>}
              </div>
              <IconButton label="Close" size="sm" icon={<X size={16} aria-hidden />} onClick={onClose} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
            {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  side = "right",
  width = 480,
  id,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  side?: "left" | "right";
  width?: number;
  id?: string;
  className?: string;
}) {
  const ref = useFocusTrap<HTMLDivElement>(open, onClose);
  const titleId = useId();
  const offscreen = side === "right" ? "100%" : "-100%";
  return createPortal(
    <AnimatePresence>
      {open && (
        <div key="drawer" className="fixed inset-0 z-[90]">
          <motion.div aria-hidden className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} onClick={onClose} />
          <motion.aside
            ref={ref}
            id={id}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={{ x: offscreen }}
            animate={{ x: 0 }}
            exit={{ x: offscreen }}
            transition={settle}
            style={{ width: `min(${width}px, 100vw)` }}
            className={cx("absolute inset-y-0 flex flex-col border-border bg-popover text-popover-foreground shadow-2xl focus:outline-none", side === "right" ? "right-0 border-l" : "left-0 border-r", className)}
          >
            <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <h2 id={titleId} className="text-ui-lg font-bold">{title}</h2>
                {description && <p className="mt-0.5 text-ui-sm text-muted-foreground">{description}</p>}
              </div>
              <IconButton label="Close" size="sm" icon={<X size={16} aria-hidden />} onClick={onClose} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
            {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

const TOOLTIP_SIDE = {
  top: "bottom-full left-1/2 mb-2 -translate-x-1/2",
  bottom: "top-full left-1/2 mt-2 -translate-x-1/2",
  right: "left-full top-1/2 ml-2 -translate-y-1/2",
  left: "right-full top-1/2 mr-2 -translate-y-1/2",
} as const;

/** Hover/focus tooltip. The child gets aria-describedby while the tooltip is shown; Escape hides it. */
export function Tooltip({ content, children, side = "top", className }: { content: ReactNode; children: ReactElement; side?: keyof typeof TOOLTIP_SIDE; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (content === null || content === undefined || content === "" || content === false) return children;
  const child = isValidElement(children) ? cloneElement(children as ReactElement<Record<string, unknown>>, { "aria-describedby": open ? id : undefined }) : children;
  return (
    <span
      className={cx("relative inline-flex", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
    >
      {child}
      <AnimatePresence>
        {open && (
          <motion.span
            key="tip"
            role="tooltip"
            id={id}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className={cx("pointer-events-none absolute z-[80] w-max max-w-xs whitespace-normal rounded-md border border-border bg-popover px-2.5 py-1.5 text-left text-ui-xs font-medium text-popover-foreground shadow-lg", TOOLTIP_SIDE[side])}
          >
            {content}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

// ------------------------------------------------------------------------------------------------ form controls
const CONTROL =
  "w-full rounded-lg border border-input bg-background/60 px-3 py-2 text-ui-base text-foreground shadow-sm transition-colors placeholder:text-muted-foreground/70 hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive";

function Field({ id, label, hint, error, children, className }: { id: string; label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={id} className="text-ui-sm font-semibold text-foreground">
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-ui-xs font-medium text-destructive">{error}</p>
      ) : (
        hint && <p id={`${id}-hint`} className="text-ui-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

const describedBy = (id: string, hint?: ReactNode, error?: ReactNode) => (error ? `${id}-error` : hint ? `${id}-hint` : undefined);

interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  wrapperClassName?: string;
}

export function Input({ label, hint, error, icon, id, className, wrapperClassName, ...rest }: InputHTMLAttributes<HTMLInputElement> & FieldProps & { icon?: ReactNode }) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <Field id={inputId} label={label} hint={hint} error={error} className={wrapperClassName}>
      <div className="relative">
        {icon && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">{icon}</span>}
        <input id={inputId} aria-invalid={error ? true : undefined} aria-describedby={describedBy(inputId, hint, error)} className={cx(CONTROL, icon ? "pl-9" : undefined, className)} {...rest} />
      </div>
    </Field>
  );
}

export function TextArea({ label, hint, error, id, className, wrapperClassName, rows = 4, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & FieldProps) {
  const autoId = useId();
  const areaId = id ?? autoId;
  return (
    <Field id={areaId} label={label} hint={hint} error={error} className={wrapperClassName}>
      <textarea id={areaId} rows={rows} aria-invalid={error ? true : undefined} aria-describedby={describedBy(areaId, hint, error)} className={cx(CONTROL, "resize-y leading-relaxed", className)} {...rest} />
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** Native <select> (accessible and keyboard-friendly by default) with the app's styling. */
export function Select({
  label,
  hint,
  error,
  options,
  placeholder,
  id,
  className,
  wrapperClassName,
  onChange,
  onValueChange,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> & FieldProps & { options: SelectOption[]; placeholder?: string; onValueChange?: (value: string) => void }) {
  const autoId = useId();
  const selectId = id ?? autoId;
  return (
    <Field id={selectId} label={label} hint={hint} error={error} className={wrapperClassName}>
      <div className="relative">
        <select
          id={selectId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(selectId, hint, error)}
          className={cx(CONTROL, "appearance-none pr-9", className)}
          onChange={(e) => {
            onChange?.(e);
            onValueChange?.(e.target.value);
          }}
          {...rest}
        >
          {placeholder !== undefined && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown size={14} aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
      </div>
    </Field>
  );
}

export function Toggle({ checked, onChange, label, description, disabled, className }: { checked: boolean; onChange: (next: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean; className?: string }) {
  const descId = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby={description ? descId : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx("inline-flex items-center gap-3 rounded-md text-left disabled:cursor-not-allowed disabled:opacity-50", className)}
    >
      <span className={cx("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors", checked ? "justify-end border-primary bg-primary" : "justify-start border-input bg-muted")}>
        <motion.span layout transition={spring} className="mx-0.5 h-3.5 w-3.5 rounded-full bg-white shadow" />
      </span>
      <span className="flex flex-col">
        <span className="text-ui-base font-medium">{label}</span>
        {description && <span id={descId} className="text-ui-xs text-muted-foreground">{description}</span>}
      </span>
    </button>
  );
}

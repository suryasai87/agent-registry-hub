// Navbar additions: the notifications bell (unread count + latest 8), the admin "View as" switcher with its
// "Previewing as X" banner, and the Cmd+K palette's live search results (GET /api/search?q=).
import { AnimatePresence, motion } from "framer-motion";
import { Bell, CheckCheck, Eye, FileText, LayoutGrid, Search, User, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, enc } from "../../lib/api";
import { cx } from "../../lib/cx";
import type { Session } from "../../lib/session";
import type { Notification, Role, SearchHit } from "../../lib/types";
import type { PaletteItem } from "../CommandPalette";
import { Button, ENTITY_TYPES, useFocusTrap, useToast } from "../ui";
import { ENTITY_OF, ROLE_LABEL } from "./chips";
import { useDebounced } from "./AssetSearch";
import { writeErrorText } from "./feedback";
import { fmtRelative } from "./format";
import { notificationHref, notificationIcon } from "./notifications";

// ------------------------------------------------------------------------------------------------ bell
export function NotificationsBell({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const navigate = useNavigate();
  const close = useCallback(() => setOpen(false), []);
  const panelRef = useFocusTrap<HTMLDivElement>(open, close);
  const wrapRef = useRef<HTMLDivElement>(null);
  const unread = session.me?.counts.unread_notifications ?? 0;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError(null);
    api.get<Notification[]>("/api/notifications", { signal: controller.signal }).then(
      (env) => {
        if (controller.signal.aborted) return;
        setItems([...(env.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 8));
      },
      (err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      controller.abort();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
    };
  }, [open]);

  const markRead = async (n: Notification) => {
    if (n.read_at) return;
    try {
      await api.post(`/api/notifications/${n.notification_id}/read`);
      setItems((xs) => xs?.map((x) => (x.notification_id === n.notification_id ? { ...x, read_at: new Date().toISOString() } : x)) ?? xs);
      session.refresh();
    } catch (err) {
      toast.error("Couldn't mark it read", writeErrorText(err));
    }
  };

  const markAll = async () => {
    try {
      await api.post("/api/notifications/read-all");
      const now = new Date().toISOString();
      setItems((xs) => xs?.map((x) => ({ ...x, read_at: x.read_at ?? now })) ?? xs);
      session.refresh();
    } catch (err) {
      toast.error("Couldn't mark all read", writeErrorText(err));
    }
  };

  const openItem = (n: Notification) => {
    void markRead(n);
    const href = notificationHref(n);
    setOpen(false);
    if (href) navigate(href);
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative grid h-9 w-9 place-items-center rounded-lg text-foreground transition-colors hover:bg-accent"
      >
        <Bell size={18} aria-hidden />
        {unread > 0 && (
          <span aria-hidden className="absolute -right-0.5 -top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground ring-2 ring-sidebar">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-label="Notifications"
            tabIndex={-1}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="absolute right-0 top-full z-50 mt-2 w-[min(380px,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl focus:outline-none"
          >
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
              <div className="text-ui-md font-bold">Notifications</div>
              <Button size="sm" variant="ghost" icon={<CheckCheck size={13} aria-hidden />} onClick={markAll} disabled={!items?.some((n) => !n.read_at)}>
                Mark all read
              </Button>
            </div>
            <ul className="max-h-[min(60vh,420px)] overflow-y-auto">
              {error && <li className="px-4 py-6 text-center text-ui-sm text-destructive">Couldn't load notifications: {error}</li>}
              {!error && items === null && <li className="px-4 py-6 text-center text-ui-sm text-muted-foreground">Loading…</li>}
              {!error && items?.length === 0 && <li className="px-4 py-8 text-center text-ui-sm text-muted-foreground">You're all caught up.</li>}
              {items?.map((n) => {
                const Icon = notificationIcon(n.kind);
                return (
                  <li key={n.notification_id} className="border-b border-border/60 last:border-0">
                    <div className={cx("flex items-start gap-3 px-4 py-2.5", !n.read_at && "bg-primary/5")}>
                      <span className={cx("mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md", n.read_at ? "bg-muted text-muted-foreground" : "bg-primary/15 text-primary")}>
                        <Icon size={14} aria-hidden />
                      </span>
                      <button type="button" onClick={() => openItem(n)} className="min-w-0 flex-1 text-left">
                        <span className={cx("block text-ui-sm", n.read_at ? "font-medium" : "font-bold")}>{n.title}</span>
                        {n.body && <span className="line-clamp-2 block text-ui-xs text-muted-foreground">{n.body}</span>}
                        <span className="block text-ui-xs text-muted-foreground">{fmtRelative(n.created_at)}{!n.read_at && <span className="sr-only">, unread</span>}</span>
                      </button>
                      {!n.read_at && (
                        <button type="button" onClick={() => void markRead(n)} aria-label={`Mark “${n.title}” read`} title="Mark read" className="mt-0.5 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                          <CheckCheck size={14} aria-hidden />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="border-t border-border px-4 py-2 text-right">
              <Link to="/notifications" onClick={() => setOpen(false)} className="text-ui-sm font-semibold text-primary hover:underline">
                View all
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ view as
export const VIEW_AS_OPTIONS: { value: "admin" | Exclude<Role, "admin">; label: string }[] = [
  { value: "admin", label: "Admin (you)" },
  { value: "steward", label: "Steward" },
  { value: "owner", label: "Owner" },
  { value: "consumer", label: "Consumer" },
  { value: "viewer", label: "Viewer" },
  { value: "auditor", label: "Auditor" },
];

/** Only for actual admins (is_admin stays true while previewing): preview the app as a lower role. */
export function ViewAsSwitcher({ session }: { session: Session }) {
  if (!session.me?.is_admin && !session.viewAs) return null;
  return (
    <label className="hidden items-center gap-1.5 rounded-lg border border-border bg-background/50 py-0.5 pl-2 pr-1 text-ui-xs font-semibold text-muted-foreground lg:flex">
      <Eye size={13} aria-hidden />
      <span>View as</span>
      <select
        name="view-as"
        aria-label="View as role"
        value={session.viewAs ?? "admin"}
        onChange={(e) => session.setViewAs(e.target.value === "admin" ? null : (e.target.value as Role))}
        className="h-7 rounded-md border-0 bg-transparent pr-1 text-ui-sm font-semibold text-foreground focus-visible:outline-2"
      >
        {VIEW_AS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

export function PreviewBanner({ session }: { session: Session }) {
  const role = session.viewAs;
  return (
    <AnimatePresence initial={false}>
      {role && (
        <motion.div
          key="preview"
          role="status"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          className="shrink-0 overflow-hidden border-b border-warning/40 bg-warning/12"
        >
          <div className="flex flex-wrap items-center gap-3 px-4 py-1.5 text-ui-sm">
            <Eye size={15} aria-hidden className="text-warning" />
            <span>
              <b>Previewing as {ROLE_LABEL[role] ?? role}.</b>{" "}
              <span className="text-muted-foreground">You see what this role can see and do; your admin rights are paused until you exit.</span>
            </span>
            <Button size="sm" variant="secondary" className="ml-auto" onClick={() => session.setViewAs(null)}>
              Exit preview
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ------------------------------------------------------------------------------------------------ palette search
const KIND_GROUP: Record<SearchHit["kind"], string> = { asset: "Asset", person: "Person", page: "Page", action: "Action" };
const KIND_ICON: Record<SearchHit["kind"], LucideIcon> = { asset: LayoutGrid, person: User, page: FileText, action: Search };

export function searchHitsToPalette(hits: SearchHit[], query: string, navigate: (href: string) => void, skipHrefs: ReadonlySet<string> = new Set()): PaletteItem[] {
  return hits
    .filter((h) => !(h.kind === "page" && skipHrefs.has(h.href)))
    .map((h) => {
      const entity = h.asset_type ? ENTITY_OF[h.asset_type] : undefined;
      return {
        id: `search:${h.kind}:${h.id}`,
        label: h.label,
        hint: h.sublabel ?? undefined,
        group: entity ? ENTITY_TYPES[entity].label : KIND_GROUP[h.kind] ?? "Result",
        icon: entity ? ENTITY_TYPES[entity].icon : KIND_ICON[h.kind] ?? Search,
        // The server matched these semantically; the query as a keyword keeps them in the palette's fuzzy filter.
        keywords: [query, h.id],
        perform: () => navigate(h.href),
      };
    });
}

/**
 * Live search for the command palette. The palette owns its input, so this listens (delegated) for input events
 * from its combobox while it is open, debounces the query and fetches /api/search.
 */
export function usePaletteSearch(open: boolean, skipHrefs: ReadonlySet<string>): PaletteItem[] {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const navigate = useNavigate();
  const debounced = useDebounced(query.trim(), 200);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHits([]);
      return;
    }
    const onInput = (e: Event) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && t.getAttribute("role") === "combobox" && t.closest('[aria-label="Command palette"]')) setQuery(t.value);
    };
    document.addEventListener("input", onInput, true);
    return () => {
      document.removeEventListener("input", onInput, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || debounced.length < 2) {
      setHits([]);
      return;
    }
    const controller = new AbortController();
    api.get<SearchHit[]>(`/api/search?q=${enc(debounced)}`, { signal: controller.signal }).then(
      (env) => {
        if (!controller.signal.aborted) setHits(env.data ?? []);
      },
      () => {
        if (!controller.signal.aborted) setHits([]);
      },
    );
    return () => {
      controller.abort();
    };
  }, [debounced, open]);

  return useMemo(() => searchHitsToPalette(hits, debounced, (href) => navigate(href), skipHrefs), [hits, debounced, navigate, skipHrefs]);
}

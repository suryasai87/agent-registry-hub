// App shell: fixed top navbar, collapsible left sidebar (persisted; icons-only when collapsed), mobile overlay
// drawer below md, a single scrolling <main>, and the Cmd/Ctrl+K command palette.
import { motion } from "framer-motion";
import { Menu, Moon, PanelLeft, PanelLeftClose, PanelLeftOpen, Search, Sun } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { cx } from "../lib/cx";
import { spring } from "../lib/motion";
import { useSession, type Health, type SessionUser } from "../lib/session";
import { readBool, writeStored } from "../lib/storage";
import { useTheme } from "../lib/theme";
import CommandPalette, { type PaletteItem } from "./CommandPalette";
import { NAV, navSections, visibleNav, type NavItem } from "./nav";
import { Avatar, Badge, Drawer, IconButton, Kbd, Tooltip } from "./ui";
import { roleLabel } from "./workspace/chips";
import AdminUpdatesBanner from "./updates/AdminUpdatesBanner";
import { NotificationsBell, PreviewBanner, ViewAsSwitcher, usePaletteSearch } from "./workspace/NavbarExtras";

export const SIDEBAR_KEY = "arh.sidebar.collapsed";
export const APP_NAME = "Agent Registry Hub";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <rect width="32" height="32" rx="8" fill="hsl(var(--secondary))" />
      <path d="M16 6 25 11v10l-9 5-9-5V11z" fill="none" stroke="hsl(var(--db-lava))" strokeWidth="2.4" strokeLinejoin="round" />
      <circle cx="16" cy="16" r="3.2" fill="hsl(var(--db-orange))" />
    </svg>
  );
}

function NavEntry({ item, collapsed, onNavigate }: { item: NavItem; collapsed: boolean; onNavigate?: () => void }) {
  const Icon = item.icon;
  const link = (
    <NavLink
      to={item.path}
      onClick={onNavigate}
      aria-label={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        cx(
          "relative flex items-center gap-3 rounded-lg py-2 text-ui-base font-medium transition-colors",
          collapsed ? "justify-center px-0" : "px-3",
          isActive ? "text-sidebar-accent-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && <motion.span layoutId="nav-active" transition={spring} className="absolute inset-0 rounded-lg bg-sidebar-accent ring-1 ring-sidebar-primary/30" />}
          {isActive && <span aria-hidden className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-sidebar-primary" />}
          <Icon size={18} aria-hidden className={cx("relative shrink-0", isActive && "text-sidebar-primary")} />
          {!collapsed && <span className="relative truncate">{item.label}</span>}
        </>
      )}
    </NavLink>
  );
  return collapsed ? (
    <Tooltip content={item.label} side="right" className="w-full">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

function NavList({ items, collapsed, onNavigate }: { items: NavItem[]; collapsed: boolean; onNavigate?: () => void }) {
  return (
    <>
      {navSections(items).map(([section, list]) => (
        <div key={section} className="mb-4">
          {collapsed ? (
            <div aria-hidden className="mx-3 mb-2 border-t border-sidebar-border" />
          ) : (
            <div className="px-3 pb-1.5 text-ui-xs font-semibold uppercase tracking-wider text-sidebar-muted">{section}</div>
          )}
          <ul className="space-y-0.5">
            {list.map((item) => (
              <li key={item.path}>
                <NavEntry item={item} collapsed={collapsed} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

function HealthDot({ health, loading }: { health: Health | null; loading: boolean }) {
  if (loading) return <span aria-hidden className="h-2.5 w-2.5 animate-pulse rounded-full bg-muted-foreground/40" />;
  const ok = !!health?.lakebase.ok;
  const label = !health
    ? "Backend unreachable"
    : ok
      ? `Lakebase connected${health.lakebase.latency_ms != null ? ` · ${health.lakebase.latency_ms} ms` : ""}`
      : `Lakebase unavailable${health.lakebase.error ? `: ${health.lakebase.error}` : ""}`;
  const readOnly = health && !health.allow_mutations ? " · read-only mode" : "";
  return (
    <Tooltip content={`${label}${readOnly}`} side="bottom">
      <span tabIndex={0} role="img" aria-label={`${label}${readOnly}`} className="grid h-9 w-6 place-items-center">
        <span className="relative flex h-2.5 w-2.5">
          {ok && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-40" />}
          <span className={cx("relative inline-flex h-2.5 w-2.5 rounded-full", ok ? "bg-success" : health ? "bg-warning" : "bg-destructive")} />
        </span>
      </span>
    </Tooltip>
  );
}

function UserChip({ user }: { user: SessionUser | null }) {
  if (!user) return null;
  return (
    <div className="flex items-center gap-2 rounded-full border border-border bg-background/50 py-1 pl-1 pr-1 sm:pr-3" title={user.email}>
      <Avatar email={user.email} name={user.name} size={26} />
      <span className="hidden min-w-0 flex-col leading-tight sm:flex">
        <span className="max-w-[160px] truncate text-ui-sm font-semibold">{user.name}</span>
        <span className="max-w-[160px] truncate text-ui-xs text-muted-foreground">{user.email}</span>
      </span>
      {user.role && (
        <Badge variant="primary" className="hidden md:inline-flex" title="Your primary role in the registry">
          {roleLabel(user.role)}
        </Badge>
      )}
    </div>
  );
}

export default function Shell({ children, nav = NAV, paletteItems = [] }: { children: ReactNode; nav?: NavItem[]; paletteItems?: PaletteItem[] }) {
  const session = useSession();
  const [collapsed, setCollapsed] = useState(() => readBool(SIDEBAR_KEY, false));
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, , toggleTheme] = useTheme();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const roles = session.me?.roles ?? null;
  const items = useMemo(() => visibleNav(nav, roles).filter((item) => item.path !== "/notifications"), [nav, roles]);

  useEffect(() => {
    writeStored(SIDEBAR_KEY, String(collapsed));
  }, [collapsed]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const toggleSidebar = useCallback(() => setCollapsed((c) => !c), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  const navHrefs = useMemo(() => new Set(items.map((item) => item.path)), [items]);
  const searchItems = usePaletteSearch(paletteOpen, navHrefs);

  const commands = useMemo<PaletteItem[]>(
    () => [
      ...items.map((item) => ({ id: `nav:${item.path}`, label: item.label, hint: item.description ?? item.section, group: "Page", icon: item.icon, perform: () => navigate(item.path) })),
      { id: "action:theme", label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme", group: "Action", icon: theme === "dark" ? Sun : Moon, keywords: ["theme", "appearance", "dark", "light"], perform: toggleTheme },
      { id: "action:sidebar", label: collapsed ? "Expand sidebar" : "Collapse sidebar", group: "Action", icon: PanelLeft, keywords: ["sidebar", "navigation"], perform: toggleSidebar },
      ...paletteItems,
      ...searchItems,
    ],
    [items, theme, collapsed, paletteItems, searchItems, navigate, toggleTheme, toggleSidebar],
  );

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[120] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground">
        Skip to content
      </a>

      <header className="z-40 flex h-14 shrink-0 items-center gap-2 border-b border-sidebar-border bg-sidebar/95 px-3 backdrop-blur md:gap-3 md:px-4">
        <IconButton className="md:hidden" label="Open navigation" icon={<Menu size={18} aria-hidden />} onClick={() => setMobileOpen(true)} aria-expanded={mobileOpen} aria-controls="mobile-nav" />
        <Link to="/" className="flex min-w-0 items-center gap-2.5 rounded-md">
          <Logo />
          <span className="truncate text-ui-md font-extrabold tracking-tight">{APP_NAME}</span>
        </Link>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          aria-label="Search"
          aria-keyshortcuts="Meta+K Control+K"
          className="flex h-9 w-9 items-center justify-center gap-2 rounded-lg border border-border bg-background/60 text-ui-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground sm:w-64 sm:justify-start sm:px-3 lg:w-80"
        >
          <Search size={15} aria-hidden />
          <span aria-hidden className="hidden flex-1 text-left sm:inline">Search</span>
          <Kbd className="hidden sm:inline">{isMac() ? "⌘" : "Ctrl"} K</Kbd>
        </button>
        <HealthDot health={session.health} loading={session.loading} />
        <ViewAsSwitcher session={session} />
        <NotificationsBell session={session} />
        <IconButton label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} icon={theme === "dark" ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />} onClick={toggleTheme} />
        <UserChip user={session.user} />
      </header>
      <PreviewBanner session={session} />
      <AdminUpdatesBanner session={session} />

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Primary"
          data-collapsed={collapsed}
          className={cx("hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-300 ease-out md:flex", collapsed ? "w-16" : "w-60")}
        >
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-4">
            <NavList items={items} collapsed={collapsed} />
          </div>
          <div className="border-t border-sidebar-border p-2">
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              className={cx("flex w-full items-center gap-3 rounded-lg py-2 text-ui-sm font-medium text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground", collapsed ? "justify-center" : "px-3")}
            >
              {collapsed ? <PanelLeftOpen size={18} aria-hidden /> : <PanelLeftClose size={18} aria-hidden />}
              {!collapsed && <span>Collapse</span>}
            </button>
          </div>
        </nav>

        <Drawer id="mobile-nav" open={mobileOpen} onClose={closeMobile} title={APP_NAME} side="left" width={288}>
          <nav aria-label="Primary (mobile)" className="-mx-2">
            <NavList items={items} collapsed={false} onNavigate={closeMobile} />
          </nav>
        </Drawer>

        <main id="main" tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto focus:outline-none">
          {/* Keyed by the previewed role so every page refetches with the new x-registry-view-as header. */}
          <div key={session.viewAs ?? "self"} className="mx-auto w-full max-w-[1600px] px-4 py-6 md:px-8 md:py-8">
            {children}
          </div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={closePalette} items={commands} />
    </div>
  );
}

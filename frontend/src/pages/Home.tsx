// Home (benchmark §1 pattern 1): a role-aware "Top actions for you" strip, the fleet KPI row, my subscriptions,
// recent changes (breaking first, with my acknowledgement), trending assets and the registry's sync freshness.
import { motion } from "framer-motion";
import {
  Activity,
  ArrowRight,
  BellRing,
  Bot,
  CircleCheck,
  Clock,
  Coins,
  FileClock,
  GitCompareArrows,
  Inbox,
  Info,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  UserX,
  UsersRound,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router-dom";
import AssetCard from "../components/asset/AssetCard";
import { ChangeEntry } from "../components/asset/ChangeEntry";
import { ErrorCard } from "../components/asset/primitives";
import useCardActions from "../components/asset/useCardActions";
import SourcePill from "../components/SourcePill";
import { Badge, Card, EmptyState, KpiTile, PageHeader, SectionTitle, Skeleton } from "../components/ui";
import { useApi } from "../lib/api";
import { fmtAgo, fmtNum, fmtUsd } from "../lib/assets";
import { cx } from "../lib/cx";
import { stagger, staggerItem } from "../lib/motion";
import { useSession } from "../lib/session";
import type { HomeData, TopAction } from "../lib/types";

const KIND_ICON: Record<string, LucideIcon> = {
  ownerless: UserX,
  pending_approvals: Inbox,
  pending_requests: Inbox,
  approvals: Inbox,
  my_requests: Clock,
  unacked_impacts: BellRing,
  impacts: BellRing,
  breaking: TriangleAlert,
  expiring: Clock,
  expiring_access: Clock,
  anomalies: Activity,
  drift: GitCompareArrows,
  curation: ShieldCheck,
  discovered: Sparkles,
  coverage: ShieldCheck,
  budget: Coins,
};

const SEVERITY: Record<TopAction["severity"], { tone: string; icon: LucideIcon; label: string }> = {
  critical: { tone: "border-destructive/45 bg-destructive/8 hover:border-destructive/70", icon: TriangleAlert, label: "Critical" },
  warning: { tone: "border-warning/45 bg-warning/8 hover:border-warning/70", icon: TriangleAlert, label: "Needs attention" },
  info: { tone: "border-info/35 bg-info/6 hover:border-info/60", icon: Info, label: "For your information" },
};
const SEVERITY_TEXT: Record<TopAction["severity"], string> = { critical: "text-destructive", warning: "text-warning", info: "text-info" };
const SEVERITY_RANK: Record<TopAction["severity"], number> = { critical: 0, warning: 1, info: 2 };

function TopActions({ actions }: { actions: TopAction[] }) {
  if (actions.length === 0)
    return (
      <Card className="flex items-center gap-3 !p-4">
        <CircleCheck size={20} className="text-success" aria-hidden />
        <div>
          <div className="text-ui-base font-semibold">You're all caught up</div>
          <div className="text-ui-sm text-muted-foreground">No approvals, acknowledgements or governance gaps need you right now.</div>
        </div>
      </Card>
    );
  const sorted = [...actions].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count);
  return (
    <motion.ul variants={stagger} initial="hidden" animate="show" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Top actions for you">
      {sorted.map((a) => {
        const sev = SEVERITY[a.severity] ?? SEVERITY.info;
        const Icon = KIND_ICON[a.kind] ?? sev.icon;
        return (
          <motion.li key={`${a.kind}-${a.href}`} variants={staggerItem} whileHover={{ y: -2 }} transition={{ type: "spring", stiffness: 500, damping: 30 }}>
            <Link to={a.href} className={cx("group flex h-full items-start gap-3 rounded-xl border p-4 transition-colors", sev.tone)}>
              <span className={cx("grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-card", SEVERITY_TEXT[a.severity])}>
                <Icon size={18} aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className={cx("block text-ui-2xl font-extrabold leading-none tabular-nums", SEVERITY_TEXT[a.severity])}>{a.count.toLocaleString()}</span>
                <span className="mt-1 block text-ui-sm font-medium text-foreground">{a.label}</span>
                <span className="sr-only">Severity: {sev.label}</span>
              </span>
              <ArrowRight size={15} aria-hidden className="mt-1 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
          </motion.li>
        );
      })}
    </motion.ul>
  );
}

function HomeSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading home" className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 9 }, (_, i) => (
          <Card key={i} className="space-y-2 !p-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-16" />
          </Card>
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

export default function Home() {
  const home = useApi<HomeData>("/api/home");
  const session = useSession();
  const { dialogs, subscribe, requestAccess } = useCardActions((assetId, fn) =>
    home.mutate((prev) =>
      prev
        ? { ...prev, my_subscriptions: prev.my_subscriptions.map((c) => (c.asset_id === assetId ? fn(c) : c)), trending: prev.trending.map((c) => (c.asset_id === assetId ? fn(c) : c)) }
        : (prev as unknown as HomeData),
    ),
  );
  const first = (session.me?.display_name || session.user?.name || "").split(/\s+/)[0];
  const d = home.data;

  const header = (
    <PageHeader
      title={first ? `Welcome back, ${first}` : "Home"}
      subtitle={
        <span className="inline-flex flex-wrap items-center gap-2">
          What needs you, what you depend on, and what changed across the registry.
          {d && (
            <span className="inline-flex items-center gap-1 text-ui-sm">
              <RefreshCw size={12} aria-hidden />
              {d.sync.last_run_at ? `Synced ${fmtAgo(d.sync.last_run_at)}` : "Not synced yet"}
              {d.sync.status && <Badge variant={d.sync.status === "ok" || d.sync.status === "succeeded" || d.sync.status === "success" ? "success" : d.sync.status === "running" ? "info" : "warning"}>{d.sync.status}</Badge>}
            </span>
          )}
        </span>
      }
      source={<SourcePill source={home.source} degradedReason={home.degradedReason} asOf={home.asOf} />}
    />
  );

  if (home.error && !d)
    return (
      <>
        {header}
        <ErrorCard error={home.error} onRetry={home.reload} title="Couldn't load your home page" />
      </>
    );
  if (!d)
    return (
      <>
        {header}
        <HomeSkeleton />
      </>
    );

  const k = d.kpis;
  const changes = [...d.recent_changes].sort((a, b) => Number(b.breaking) - Number(a.breaking) || (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at));
  const kpis: { key: string; label: string; value: string; icon: LucideIcon; href?: string; hint?: string; warn?: boolean }[] = [
    { key: "agents", label: "Agents", value: fmtNum(k.agents), icon: Bot, href: "/catalog?type=agent" },
    { key: "mcp", label: "MCP servers", value: fmtNum(k.mcp_servers), icon: Server, href: "/catalog?type=mcp_server" },
    { key: "tools", label: "Tools", value: fmtNum(k.tools), icon: Wrench, href: "/catalog?type=tool" },
    { key: "skills", label: "Skills", value: fmtNum(k.skills), icon: Sparkles, href: "/catalog?type=skill" },
    { key: "subs", label: "Subscribers", value: fmtNum(k.subscribers), icon: UsersRound },
    { key: "req", label: "Requests · 30 d", value: fmtNum(k.requests_30d), icon: Activity, href: "/usage-cost" },
    { key: "cost", label: "Cost · 30 d", value: fmtUsd(k.cost_30d_usd), icon: Coins, href: "/usage-cost", hint: "Estimated (list price)" },
    { key: "gov", label: "Governed traffic", value: `${Math.round(k.governed_pct)}%`, icon: ShieldCheck, href: "/policies", hint: "Through a gateway with ≥ 1 guardrail" },
    { key: "ownerless", label: "Ownerless", value: fmtNum(k.ownerless), icon: UserX, href: "/catalog?ownerless=true", warn: k.ownerless > 0, hint: k.ownerless > 0 ? "Needs an accountable owner" : "Every asset has an owner" },
  ];

  return (
    <div className="space-y-8">
      {header}

      <section aria-labelledby="top-actions">
        <SectionTitle id="top-actions" title="Top actions for you" subtitle="Each opens a pre-filtered list where you can act." />
        <TopActions actions={d.top_actions} />
      </section>

      <section aria-label="Registry at a glance">
        <motion.div variants={stagger} initial="hidden" animate="show" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-9">
          {kpis.map((t) => {
            const tile = <KpiTile label={t.label} value={t.value} icon={<t.icon size={15} aria-hidden />} hint={t.hint} className={cx("h-full", t.warn && "border-warning/50", t.href && "transition-colors hover:border-primary/40")} />;
            return (
              <motion.div key={t.key} variants={staggerItem} className={cx(t.warn && "[&_.text-ui-2xl]:text-warning")}>
                {t.href ? (
                  <Link to={t.href} aria-label={`${t.label}: ${t.value}`} className="block h-full rounded-xl">
                    {tile}
                  </Link>
                ) : (
                  tile
                )}
              </motion.div>
            );
          })}
        </motion.div>
      </section>

      <div className="grid gap-8 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section aria-labelledby="my-subs" className="min-w-0">
          <SectionTitle
            id="my-subs"
            title="My subscriptions"
            subtitle="Assets you're registered on: you hear about their changes first."
            actions={
              <Link to="/me" className="text-ui-sm font-semibold text-primary hover:underline">
                Manage
              </Link>
            }
          />
          {d.my_subscriptions.length === 0 ? (
            <EmptyState
              icon={<BellRing size={20} aria-hidden />}
              title="You're not subscribed to anything yet"
              description="Subscribe to the agents and MCP servers you use, so breaking changes never surprise you."
              action={
                <Link to="/catalog" className="inline-flex h-9 items-center rounded-lg bg-primary px-3.5 text-ui-base font-semibold text-primary-foreground hover:brightness-110">
                  Browse the catalog
                </Link>
              }
            />
          ) : (
            <motion.div variants={stagger} initial="hidden" animate="show" className="grid gap-4 md:grid-cols-2 2xl:grid-cols-2">
              {d.my_subscriptions.slice(0, 6).map((c) => (
                <AssetCard key={c.asset_id} card={c} onSubscribe={subscribe} onRequestAccess={requestAccess} />
              ))}
            </motion.div>
          )}
        </section>

        <section aria-labelledby="recent-changes" className="min-w-0">
          <SectionTitle
            id="recent-changes"
            title="Recent changes"
            subtitle="Breaking changes first."
            actions={
              <Link to="/changes" className="text-ui-sm font-semibold text-primary hover:underline">
                All changes
              </Link>
            }
          />
          {changes.length === 0 ? (
            <EmptyState icon={<FileClock size={20} aria-hidden />} title="No recent changes" description="Published versions, deprecations and policy changes appear here." className="!py-8" />
          ) : (
            <motion.ul variants={stagger} initial="hidden" animate="show" className="space-y-2">
              {changes.slice(0, 6).map((c) => (
                <motion.li key={c.change_id} variants={staggerItem}>
                  <ChangeEntry c={c} showAsset />
                </motion.li>
              ))}
            </motion.ul>
          )}
        </section>
      </div>

      <section aria-labelledby="trending">
        <SectionTitle
          id="trending"
          title="Trending"
          subtitle="The most-used assets over the last 30 days."
          actions={
            <Link to="/catalog?sort=requests" className="text-ui-sm font-semibold text-primary hover:underline">
              See all
            </Link>
          }
        />
        {d.trending.length === 0 ? (
          <EmptyState title="No traffic yet" description="Assets appear here once usage is recorded." className="!py-8" />
        ) : (
          <motion.div variants={stagger} initial="hidden" animate="show" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {d.trending.slice(0, 8).map((c) => (
              <AssetCard key={c.asset_id} card={c} onSubscribe={subscribe} onRequestAccess={requestAccess} />
            ))}
          </motion.div>
        )}
      </section>
      {dialogs}
    </div>
  );
}

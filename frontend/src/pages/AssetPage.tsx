// Entity page: /assets/:assetId/:tab? (assetId is a URL-encoded URN). GET /api/assets/{id} → AssetDetail; the
// tabs shown come from detail.tabs, are URL-driven, lazy, and each sits in its own ErrorBoundary so one failing
// tab never blanks the page. Hosts the request / subscribe / use / runtime / review dialogs for every tab.
import { Compass } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ComponentType, type LazyExoticComponent } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import ErrorBoundary from "../components/ErrorBoundary";
import { AssetContext, endpointOf, type AssetCtx } from "../components/asset/AssetContext";
import AssetHeader from "../components/asset/AssetHeader";
import GovernanceDialog from "../components/asset/GovernanceDialog";
import { takePrefetched } from "../components/asset/prefetch";
import { ErrorCard, SectionSkeleton } from "../components/asset/primitives";
import RequestAccessDialog from "../components/asset/RequestAccessDialog";
import RuntimeActionDialog, { type RuntimeAction } from "../components/asset/RuntimeActionDialog";
import SubscribeDialog, { postSubscription, type SubscribeBody } from "../components/asset/SubscribeDialog";
import { applyRequest, useSessionEmail } from "../components/asset/useCardActions";
import UseAssetDialog, { type UseOperation } from "../components/asset/UseAssetDialog";
import { Card, EmptyState, Skeleton, Tabs, useToast, type TabItem } from "../components/ui";
import { ApiError, api, type DataSource } from "../lib/api";
import { assetApi, assetHref } from "../lib/assets";
import { useSession } from "../lib/session";
import type { AssetDetail, AssetType, Subscription } from "../lib/types";

type TabId = "overview" | "tools" | "access" | "usage" | "traces" | "evals" | "policies" | "lineage" | "changes" | "subscribers" | "audit";

export const TAB_ORDER: TabId[] = ["overview", "tools", "access", "usage", "traces", "evals", "policies", "lineage", "changes", "subscribers", "audit"];

const TAB_COMPONENTS: Record<TabId, LazyExoticComponent<ComponentType>> = {
  overview: lazy(() => import("./asset/OverviewTab")),
  tools: lazy(() => import("./asset/ToolsTab")),
  access: lazy(() => import("./asset/AccessTab")),
  usage: lazy(() => import("./asset/UsageTab")),
  traces: lazy(() => import("./asset/TracesTab")),
  evals: lazy(() => import("./asset/EvalsTab")),
  policies: lazy(() => import("./asset/PoliciesTab")),
  lineage: lazy(() => import("./asset/LineageTab")),
  changes: lazy(() => import("./asset/ChangesTab")),
  subscribers: lazy(() => import("./asset/SubscribersTab")),
  audit: lazy(() => import("./asset/AuditTab")),
};

export function tabLabel(tab: TabId, type: AssetType): string {
  if (tab === "tools") return { agent: "Tools & skills used", mcp_server: "Tools exposed", tool: "Schema", skill: "Capabilities" }[type];
  return { overview: "Overview", access: "Access", usage: "Usage & Cost", traces: "Traces", evals: "Evals", policies: "Policies", lineage: "Lineage", changes: "Changes", subscribers: "Subscribers", audit: "Audit" }[tab as Exclude<TabId, "tools">];
}

export function visibleTabs(tabs: string[]): TabId[] {
  const set = new Set(tabs);
  const shown = TAB_ORDER.filter((t) => set.has(t));
  return shown.length ? shown : ["overview"];
}

function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

interface DetailState {
  path: string;
  data: AssetDetail | null;
  source: DataSource | null;
  degradedReason: string | null;
  asOf: string | null;
  loading: boolean;
  error: Error | null;
}

/** GET /api/assets/{id}, taking a fresh hover-prefetch when one exists; keeps data visible on silent reloads. */
function useAssetDetail(path: string) {
  const [state, setState] = useState<DetailState>({ path, data: null, source: null, degradedReason: null, asOf: null, loading: true, error: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState((s) => (s.path === path ? { ...s, loading: true, error: null } : { path, data: null, source: null, degradedReason: null, asOf: null, loading: true, error: null }));
    const pre = nonce === 0 ? takePrefetched(path) : null;
    (pre ?? api.get<AssetDetail>(path, { signal: controller.signal })).then(
      (env) => {
        if (controller.signal.aborted) return;
        setState({ path, data: env.data, source: env.source, degradedReason: env.degraded_reason, asOf: env.as_of, loading: false, error: null });
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        setState((s) => ({ ...s, path, loading: false, error: err instanceof Error ? err : new Error(String(err)) }));
      },
    );
    return () => {
      controller.abort();
    };
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const patch = useCallback((fn: (d: AssetDetail) => AssetDetail) => {
    setState((s) => (s.data ? { ...s, data: fn(s.data) } : s));
  }, []);
  const current = state.path === path ? state : { ...state, data: null, loading: true };
  return { ...current, reload, patch };
}

function HeaderSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading asset" className="mb-5 space-y-4">
      <Skeleton className="h-4 w-56" />
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-xl" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-72" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
      </div>
      <div className="flex gap-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-5 w-24 rounded-full" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Card key={i} className="space-y-2 !p-4">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-6 w-20" />
          </Card>
        ))}
      </div>
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

export default function AssetPage() {
  const { assetId: raw = "", tab } = useParams();
  const assetId = safeDecode(raw);
  const base = assetApi(assetId);
  const state = useAssetDetail(base);
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const session = useSession();
  const email = useSessionEmail();
  const toast = useToast();

  const [refreshKey, setRefreshKey] = useState(0);
  const [pendingSubs, setPendingSubs] = useState<Subscription[]>([]);
  const [requestOpen, setRequestOpen] = useState(false);
  const [subscribeOpen, setSubscribeOpen] = useState(false);
  const [usageDialog, setUsageDialog] = useState<{ open: boolean; operation: UseOperation; endpoint: string | null }>({ open: false, operation: "registered_use", endpoint: null });
  const [runtime, setRuntime] = useState<{ open: boolean; action: RuntimeAction }>({ open: false, action: "pause" });
  const [governanceOpen, setGovernanceOpen] = useState(false);

  const detail = state.data;
  const tabs = useMemo(() => (detail ? visibleTabs(detail.tabs) : []), [detail]);
  const active: TabId | null = detail ? (tab && (tabs as string[]).includes(tab) ? (tab as TabId) : tabs[0]) : null;
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Deep links from the command palette / other pages: ?request=1, ?subscribe=1, ?use=1 open the dialog in place.
  useEffect(() => {
    if (!detail) return;
    const flags = ["request", "subscribe", "use"].filter((k) => search.get(k) === "1");
    if (!flags.length) return;
    if (flags.includes("request")) setRequestOpen(true);
    if (flags.includes("subscribe")) setSubscribeOpen(true);
    if (flags.includes("use")) setUsageDialog({ open: true, operation: "registered_use", endpoint: endpointOf(detail) });
    const next = new URLSearchParams(search);
    flags.forEach((k) => next.delete(k));
    setSearch(next, { replace: true });
  }, [detail, search, setSearch]);

  const goTab = useCallback(
    (next: string, query?: Record<string, string>) => {
      const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
      navigate(`${assetHref(assetId, next)}${qs}`, { replace: !query });
    },
    [assetId, navigate],
  );

  const subscribe = async (body: SubscribeBody) => {
    if (!detail) return;
    const before = detail.asset;
    const temp: Subscription = {
      subscription_id: -Date.now(),
      asset_id: assetId,
      asset_display_name: before.display_name,
      asset_type: before.asset_type,
      subscriber_email: body.subscriber_email,
      notify_emails: body.notify_emails ?? [],
      subscriber_kind: body.subscriber_kind ?? "user",
      relationship: body.relationship ?? "direct_use",
      downstream_asset_id: body.downstream_asset_id ?? null,
      downstream_name: body.downstream_name ?? null,
      use_case: body.use_case ?? null,
      environment: body.environment ?? "prod",
      notify_pref: body.notify_pref ?? "breaking_only",
      status: "active",
      created_by: email,
      created_at: new Date().toISOString(),
      last_ack_at: null,
      has_access: before.my.has_access,
    };
    const mine = body.subscriber_email.toLowerCase() === email.toLowerCase();
    setPendingSubs((xs) => [temp, ...xs]);
    state.patch((d) => ({ ...d, asset: { ...d.asset, subscribers: d.asset.subscribers + 1, my: { ...d.asset.my, subscribed: d.asset.my.subscribed || mine } } }));
    try {
      await postSubscription(assetId, body);
      toast.success(`Subscribed to ${before.display_name}`, `Notifications go to ${body.subscriber_email}.`);
      setPendingSubs((xs) => xs.filter((s) => s.subscription_id !== temp.subscription_id));
      bump();
    } catch (err) {
      setPendingSubs((xs) => xs.filter((s) => s.subscription_id !== temp.subscription_id));
      state.patch((d) => ({ ...d, asset: { ...d.asset, subscribers: before.subscribers, my: { ...d.asset.my, subscribed: before.my.subscribed } } }));
      throw err;
    }
  };

  if (state.error && !detail) {
    const notFound = state.error instanceof ApiError && state.error.status === 404;
    return notFound ? (
      <EmptyState
        className="mt-10"
        icon={<Compass size={22} aria-hidden />}
        title="Asset not found"
        description={
          <>
            Nothing is registered as <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-ui-xs">{assetId}</code>. It may have been retired or renamed.
          </>
        }
        action={
          <Link to="/catalog" className="inline-flex h-9 items-center rounded-lg bg-primary px-3.5 text-ui-base font-semibold text-primary-foreground hover:brightness-110">
            Browse the catalog
          </Link>
        }
      />
    ) : (
      <ErrorCard className="mt-6" error={state.error} onRetry={state.reload} title="Couldn't load this asset" />
    );
  }

  if (!detail || !active) {
    return (
      <>
        <HeaderSkeleton />
        <SectionSkeleton />
      </>
    );
  }

  if (tab && tab !== active) return <Navigate to={assetHref(assetId, active)} replace />;

  const ctx: AssetCtx = {
    assetId,
    base,
    detail,
    email,
    isAuditor: !!session.me?.is_auditor,
    reload: state.reload,
    patchDetail: state.patch,
    openRequest: () => setRequestOpen(true),
    openSubscribe: () => setSubscribeOpen(true),
    openUse: (operation = "registered_use", endpoint = null) => setUsageDialog({ open: true, operation, endpoint: endpoint ?? endpointOf(detail) }),
    openRuntime: (action) => setRuntime({ open: true, action }),
    openGovernance: () => setGovernanceOpen(true),
    goTab,
    refreshKey,
    pendingSubscriptions: pendingSubs,
  };

  const items: TabItem[] = tabs.map((t) => ({ id: t, label: tabLabel(t, detail.asset.asset_type) }));
  const Active = TAB_COMPONENTS[active];
  const activeLabel = tabLabel(active, detail.asset.asset_type);

  return (
    <AssetContext.Provider value={ctx}>
      <AssetHeader source={state.source} degradedReason={state.degradedReason} asOf={state.asOf} />
      <Tabs tabs={items} value={active} syncHash={false} onChange={(id) => goTab(id)}>
        {() => (
          <ErrorBoundary name={`${activeLabel} tab`} resetKey={`${assetId}:${active}`}>
            <Suspense fallback={<SectionSkeleton />}>
              <Active key={assetId} />
            </Suspense>
          </ErrorBoundary>
        )}
      </Tabs>

      <RequestAccessDialog
        open={requestOpen}
        onClose={() => setRequestOpen(false)}
        asset={detail.asset}
        settings={detail.access_settings}
        defaultEmail={email}
        onSubmitted={(req) => {
          state.patch((d) => ({ ...d, asset: { ...d.asset, ...applyRequest(d.asset, req) } }));
          bump();
        }}
      />
      <SubscribeDialog open={subscribeOpen} onClose={() => setSubscribeOpen(false)} asset={detail.asset} defaultEmail={email} onSubmit={subscribe} />
      <UseAssetDialog
        open={usageDialog.open}
        onClose={() => setUsageDialog((s) => ({ ...s, open: false }))}
        asset={detail.asset}
        operation={usageDialog.operation}
        endpoint={usageDialog.endpoint}
        defaultEmail={email}
        onRecorded={bump}
      />
      <RuntimeActionDialog
        open={runtime.open}
        onClose={() => setRuntime((s) => ({ ...s, open: false }))}
        asset={detail.asset}
        action={runtime.action}
        onDone={() => {
          state.reload();
          bump();
        }}
      />
      <GovernanceDialog
        open={governanceOpen}
        onClose={() => setGovernanceOpen(false)}
        asset={detail.asset}
        onSaved={(card) => {
          state.patch((d) => ({ ...d, asset: { ...d.asset, ...card } }));
          bump();
        }}
      />
    </AssetContext.Provider>
  );
}

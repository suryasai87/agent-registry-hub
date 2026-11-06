// Access requests: the review queue (requests I can decide) and, for stewards/admins/auditors, every request.
// Same model as Unity Catalog's Review queue / All requests (benchmark §3.2, flow 5.1).
import { motion } from "framer-motion";
import { Inbox } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import SourcePill from "../components/SourcePill";
import { Badge, EmptyState, PageHeader, Select, Tabs } from "../components/ui";
import { AsyncBlock, CardsSkeleton } from "../components/workspace/feedback";
import RequestCard from "../components/workspace/RequestCard";
import { useApi } from "../lib/api";
import { stagger } from "../lib/motion";
import { useSession } from "../lib/session";
import type { AccessRequest } from "../lib/types";

type Filter = "open" | "pending" | "provision_failed" | "decided" | "all";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "pending", label: "Pending" },
  { value: "provision_failed", label: "Provisioning failed" },
  { value: "decided", label: "Decided" },
  { value: "all", label: "All statuses" },
];

const OPEN = new Set(["pending", "provisioning", "provision_failed"]);
const SLA_RANK = { overdue: 0, due_soon: 1, on_track: 2, closed: 3 } as const;

export function filterRequests(rows: AccessRequest[], filter: Filter, alwaysShow: ReadonlySet<number> = new Set()): AccessRequest[] {
  const keep = (r: AccessRequest) =>
    alwaysShow.has(r.request_id) ? true : filter === "all" ? true : filter === "open" ? OPEN.has(r.status) : filter === "decided" ? !OPEN.has(r.status) : r.status === filter;
  return rows
    .filter(keep)
    .sort((a, b) => (SLA_RANK[a.sla_state] ?? 9) - (SLA_RANK[b.sla_state] ?? 9) || a.sla_due_at.localeCompare(b.sla_due_at) || b.created_at.localeCompare(a.created_at));
}

function RequestList({ scope, filter }: { scope: "review" | "all"; filter: Filter }) {
  const q = useApi<AccessRequest[]>(`/api/requests?scope=${scope}`);
  const provisioning = q.data?.some((r) => r.status === "provisioning") ?? false;
  const [polls, setPolls] = useState(0);
  const reload = q.reload;
  useEffect(() => {
    if (!provisioning || polls >= 10) return;
    const t = setTimeout(() => {
      setPolls((n) => n + 1);
      reload();
    }, 4000);
    return () => {
      clearTimeout(t);
    };
  }, [provisioning, polls, reload]);
  // Requests decided in this session stay visible (with their provisioning result) until the next visit.
  const [touched, setTouched] = useState<Set<number>>(() => new Set());
  const rows = useMemo(() => filterRequests(q.data ?? [], filter, touched), [q.data, filter, touched]);
  const replace = (next: AccessRequest) => {
    setTouched((t) => new Set(t).add(next.request_id));
    q.mutate((prev) => (prev ?? []).map((r) => (r.request_id === next.request_id ? next : r)));
  };
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <SourcePill source={q.source} degradedReason={q.degradedReason} asOf={q.asOf} />
      </div>
      <AsyncBlock
        state={q}
        skeleton={<CardsSkeleton count={4} className="!grid-cols-1 xl:!grid-cols-2" />}
        isEmpty={() => rows.length === 0}
        empty={
          <EmptyState
            icon={<Inbox size={22} aria-hidden />}
            title={filter === "open" ? (scope === "review" ? "Nothing waiting for your decision" : "No open requests") : "No requests match this filter"}
            description={scope === "review" ? "Requests for assets you own or approve land here, with their SLA clock. You'll also get a notification." : "Change the status filter to see decided requests."}
          />
        }
      >
        {() => (
          <motion.ul variants={stagger} initial="hidden" animate="show" className="grid gap-4 xl:grid-cols-2" aria-label="Access requests">
            {rows.map((r) => (
              <RequestCard key={r.request_id} request={r} onChange={replace} />
            ))}
          </motion.ul>
        )}
      </AsyncBlock>
    </div>
  );
}

export default function RequestsPage() {
  const { hasRole, me } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const canSeeAll = hasRole("steward", "admin", "auditor");
  const tab = canSeeAll && location.hash === "#all" ? "all" : "review";
  const [filter, setFilter] = useState<Filter>("open");
  const pending = me?.counts.pending_approvals ?? 0;
  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Inbox size={20} aria-hidden />}
        title="Access requests"
        subtitle="Decide who can use the agents, MCP servers, tools and skills you're responsible for. Approving provisions the real platform grant; a failure shows the error and the exact statement."
        actions={<Select aria-label="Status filter" value={filter} onValueChange={(v) => setFilter(v as Filter)} options={FILTERS} wrapperClassName="w-56" />}
      />
      <Tabs
        syncHash={false}
        value={tab}
        onChange={(id) => navigate({ hash: id === "all" ? "all" : "" }, { replace: true })}
        tabs={[
          { id: "review", label: "Review queue", badge: pending ? <Badge variant="primary">{pending}</Badge> : undefined },
          ...(canSeeAll ? [{ id: "all", label: "All requests" }] : []),
        ]}
      >
        {(active) => <RequestList key={active} scope={active === "all" ? "all" : "review"} filter={filter} />}
      </Tabs>
    </div>
  );
}

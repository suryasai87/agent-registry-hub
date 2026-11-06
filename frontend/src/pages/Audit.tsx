// Audit (/audit): the tamper-evident trail of every grant, request, edit, override, publish and role change,
// filterable (entity type, actor, action, days), paginated, expandable to before/after, chain-verifiable, and
// exportable as CSV/JSON with the same filters.
import { BookOpen, ChevronDown, ChevronLeft, ChevronRight, Download, FileJson, Filter } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import AuditVerify from "../components/governance/AuditVerify";
import SourcePill from "../components/SourcePill";
import { Badge, Button, Card, EmptyState, Input, PageHeader, Select } from "../components/ui";
import { AsyncBlock, RowsSkeleton } from "../components/workspace/feedback";
import { fmtDateTime, fmtRelative, toJson } from "../components/workspace/format";
import { useApi } from "../lib/api";
import { assetHref } from "../lib/assets";
import { cx } from "../lib/cx";
import type { AuditRow } from "../lib/types";

const PAGE_SIZE = 50;
const DAYS = [
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last year" },
];
const ENTITY_TYPES = [
  { value: "", label: "All entity types" },
  { value: "asset", label: "Asset" },
  { value: "change", label: "Change" },
  { value: "role", label: "Role" },
];
const ACTIONS = [
  "access.request", "access.approve", "access.deny", "access.revoke", "access.cancel", "access.settings", "asset.register", "asset.governance",
  "budget.set", "change.publish", "change.ack", "change.detected", "curation.approve", "curation.reject", "field.revert", "field.keep_override",
  "policy.active", "policy.proposed", "policy.unbind", "role.grant", "role.revoke", "subscription.create", "subscription.update", "subscription.cancel",
];

export interface AuditFilters {
  entity_type?: string;
  entity_id?: string;
  actor?: string;
  action?: string;
  days: string;
}

export function auditQuery(f: AuditFilters, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams();
  for (const k of ["entity_type", "entity_id", "actor", "action"] as const) {
    const v = f[k]?.trim();
    if (v) q.set(k, v);
  }
  q.set("days", f.days);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return q.toString();
}

function actionTone(action: string): "destructive" | "success" | "warning" | "info" | "neutral" {
  if (/(revoke|deny|reject|unbind|cancel|expire)/.test(action)) return "destructive";
  if (/(approve|grant|register|publish|create)/.test(action)) return "success";
  if (/(override|governance|settings|budget|policy)/.test(action)) return "warning";
  if (/(ack|update|detected)/.test(action)) return "info";
  return "neutral";
}

export default function AuditPage() {
  const [params, setParams] = useSearchParams();
  const filters: AuditFilters = {
    entity_type: params.get("entity_type") ?? "",
    entity_id: params.get("entity_id") ?? "",
    actor: params.get("actor") ?? "",
    action: params.get("action") ?? "",
    days: params.get("days") ?? "30",
  };
  const page = Math.max(1, Number(params.get("page")) || 1);
  const [draft, setDraft] = useState({ actor: filters.actor ?? "", action: filters.action ?? "", entity_id: filters.entity_id ?? "" });
  const [open, setOpen] = useState<number | null>(null);
  const qs = auditQuery(filters);
  const q = useApi<{ rows: AuditRow[]; total: number }>(`/api/audit?${qs}&page=${page}&page_size=${PAGE_SIZE}`);

  useEffect(() => {
    setDraft({ actor: params.get("actor") ?? "", action: params.get("action") ?? "", entity_id: params.get("entity_id") ?? "" });
  }, [params]);

  const set = (patch: Record<string, string>) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      if (!("page" in patch)) next.delete("page");
      return next;
    });

  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(total, (page - 1) * PAGE_SIZE + (q.data?.rows.length ?? 0));

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<BookOpen size={20} aria-hidden />}
        title="Audit"
        subtitle="Every grant, request, edit, override, publish and role change, with who, when, before/after and why. Rows are hash-chained so tampering is detectable."
        source={<SourcePill source={q.source} degradedReason={q.degradedReason} asOf={q.asOf} />}
        actions={
          <>
            <a href={`/api/audit/export?${auditQuery(filters, { format: "csv" })}`} download className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-secondary px-3.5 text-ui-base font-semibold hover:border-primary/40">
              <Download size={14} aria-hidden /> Export CSV
            </a>
            <a href={`/api/audit/export?${auditQuery(filters, { format: "json" })}`} download className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-secondary px-3.5 text-ui-base font-semibold hover:border-primary/40">
              <FileJson size={14} aria-hidden /> Export JSON
            </a>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="!p-3">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              set({ actor: draft.actor.trim(), action: draft.action.trim(), entity_id: draft.entity_id.trim() });
            }}
          >
            <Select label="Entity type" value={filters.entity_type ?? ""} onValueChange={(v) => set({ entity_type: v })} options={ENTITY_TYPES} wrapperClassName="w-44" />
            <Input label="Actor" value={draft.actor} onChange={(e) => setDraft((d) => ({ ...d, actor: e.target.value }))} placeholder="email" wrapperClassName="w-52" />
            <Input label="Action" list="audit-actions" value={draft.action} onChange={(e) => setDraft((d) => ({ ...d, action: e.target.value }))} placeholder="e.g. access.approve" wrapperClassName="w-48" />
            <datalist id="audit-actions">{ACTIONS.map((a) => <option key={a} value={a} />)}</datalist>
            <Input label="Entity id" value={draft.entity_id} onChange={(e) => setDraft((d) => ({ ...d, entity_id: e.target.value }))} placeholder="asset URN, change id…" wrapperClassName="w-56" />
            <Select label="Window" value={filters.days} onValueChange={(v) => set({ days: v })} options={DAYS} wrapperClassName="w-40" />
            <Button type="submit" variant="secondary" icon={<Filter size={14} aria-hidden />}>Apply</Button>
          </form>
        </Card>
        <Card className="!p-3">
          <div className="mb-2 text-ui-sm font-semibold">Integrity</div>
          <AuditVerify />
        </Card>
      </div>

      <AsyncBlock
        state={q}
        skeleton={<RowsSkeleton rows={8} />}
        isEmpty={(d) => d.rows.length === 0}
        empty={<EmptyState icon={<BookOpen size={22} aria-hidden />} title="No audit events match" description="Widen the window or clear a filter." />}
      >
        {(d) => (
          <Card className="!p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-ui-sm">
                <caption className="sr-only">Audit events</caption>
                <thead className="bg-muted/60 text-left text-ui-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="w-8 px-3 py-2"><span className="sr-only">Expand</span></th>
                    {["When", "Actor", "Action", "Entity", "Reason", "Source"].map((h) => <th key={h} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => {
                    const expanded = open === r.audit_id;
                    const assetLike = r.entity_type === "asset" && r.entity_id;
                    return (
                      <Fragment key={r.audit_id}>
                        <tr className={cx("border-t border-border/70 align-top", expanded && "bg-muted/30")}>
                          <td className="px-3 py-2">
                            <button type="button" aria-expanded={expanded} aria-label={`${expanded ? "Hide" : "Show"} before and after for event ${r.audit_id}`} onClick={() => setOpen(expanded ? null : r.audit_id)} className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                              <ChevronDown size={14} aria-hidden className={cx("transition-transform", expanded && "rotate-180")} />
                            </button>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2" title={fmtDateTime(r.at)}>{fmtRelative(r.at)}<div className="text-ui-xs text-muted-foreground">{fmtDateTime(r.at)}</div></td>
                          <td className="px-3 py-2"><button type="button" onClick={() => set({ actor: r.actor })} className="hover:text-primary hover:underline" title="Filter by this actor">{r.actor}</button></td>
                          <td className="px-3 py-2"><Badge variant={actionTone(r.action)}>{r.action}</Badge></td>
                          <td className="px-3 py-2">
                            <span className="text-ui-xs text-muted-foreground">{r.entity_type}</span>
                            {r.entity_id && (
                              <div className="max-w-[260px] truncate font-mono text-ui-xs" title={r.entity_id}>
                                {assetLike ? <Link to={assetHref(r.entity_id!)} className="hover:text-primary hover:underline">{r.entity_id}</Link> : r.entity_type === "change" ? <Link to={`/changes/${r.entity_id}`} className="hover:text-primary hover:underline">{r.entity_id}</Link> : r.entity_id}
                              </div>
                            )}
                          </td>
                          <td className="max-w-xs px-3 py-2">{r.reason ?? <span className="text-muted-foreground">–</span>}</td>
                          <td className="px-3 py-2 text-ui-xs text-muted-foreground">{r.source}</td>
                        </tr>
                        {expanded && (
                          <tr className="bg-muted/30">
                            <td />
                            <td colSpan={6} className="px-3 pb-3">
                              <div className="grid gap-3 md:grid-cols-2">
                                {(["before", "after"] as const).map((k) => (
                                  <div key={k}>
                                    <div className="mb-1 text-ui-xs font-semibold uppercase tracking-wider text-muted-foreground">{k}</div>
                                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background/70 px-2.5 py-2 font-mono text-ui-xs">{r[k] === null || r[k] === undefined ? "—" : toJson(r[k])}</pre>
                                  </div>
                                ))}
                              </div>
                              <div className="mt-2 flex flex-wrap gap-x-4 text-ui-xs text-muted-foreground">
                                <span>Event #{r.audit_id}</span>
                                <span className="break-all">Row hash <span className="font-mono">{r.row_hash}</span></span>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <nav aria-label="Audit pages" className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-ui-sm">
              <span className="text-muted-foreground">{from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()} events</span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" icon={<ChevronLeft size={13} aria-hidden />} disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>Previous</Button>
                <span className="tabular-nums">Page {page} of {pages}</span>
                <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>
                  Next <ChevronRight size={13} aria-hidden />
                </Button>
              </div>
            </nav>
          </Card>
        )}
      </AsyncBlock>
    </div>
  );
}

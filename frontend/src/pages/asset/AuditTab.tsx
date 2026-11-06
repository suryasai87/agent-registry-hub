// Audit: the immutable, hash-chained event list for this asset (who / what / when / before → after / reason /
// source), with the row hash truncated, an action filter, pagination and evidence export.
import { ChevronDown, Download, ScrollText } from "lucide-react";
import { Fragment, useState } from "react";
import { useAsset } from "../../components/asset/AssetContext";
import { evidenceHref } from "../../components/asset/AssetHeader";
import { fmtDateTime, shortHash } from "../../components/asset/format";
import { humanize } from "../../components/asset/meta";
import { CopyButton, DataTable, ErrorCard, JsonViewer, TableSkeleton, Td, Th } from "../../components/asset/primitives";
import { previewValue } from "../../components/asset/ProvenanceChip";
import SourcePill from "../../components/SourcePill";
import { Avatar, Badge, Button, EmptyState, IconButton, SectionTitle, Select } from "../../components/ui";
import { useApi } from "../../lib/api";
import { cx } from "../../lib/cx";
import type { AuditRow } from "../../lib/types";

const PAGE_SIZE = 50;

export default function AuditTab() {
  const { assetId, refreshKey, detail, isAuditor } = useAsset();
  const [page, setPage] = useState(1);
  const [days, setDays] = useState("90");
  const [action, setAction] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const params = new URLSearchParams({ entity_type: "asset", entity_id: assetId, days, page: String(page) });
  if (action) params.set("action", action);
  const audit = useApi<{ rows: AuditRow[]; total: number }>(`/api/audit?${params.toString()}`, [refreshKey]);
  const rows = audit.data?.rows ?? [];
  const total = audit.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const actions = [...new Set(rows.map((r) => r.action))].sort();
  const canExport = isAuditor || detail.permissions.can_view_all_usage;

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Audit trail"
        subtitle="Append-only and hash-chained: every grant, request, edit, override, status change and publish for this asset."
        actions={
          <>
            <SourcePill source={audit.source} degradedReason={audit.degradedReason} asOf={audit.asOf} />
            <Select
              aria-label="Time window"
              value={days}
              onValueChange={(v) => {
                setDays(v);
                setPage(1);
              }}
              options={[
                { value: "7", label: "Last 7 days" },
                { value: "30", label: "Last 30 days" },
                { value: "90", label: "Last 90 days" },
                { value: "365", label: "Last year" },
              ]}
              wrapperClassName="w-40"
            />
            <Select
              aria-label="Filter by action"
              value={action}
              onValueChange={(v) => {
                setAction(v);
                setPage(1);
              }}
              options={[{ value: "", label: "All actions" }, ...[...new Set([...actions, ...(action ? [action] : [])])].map((a) => ({ value: a, label: humanize(a.replace(/\./g, "_")) }))]}
              wrapperClassName="w-48"
            />
            {canExport && (
              <a href={evidenceHref(assetId)} target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-ui-sm font-semibold hover:bg-accent">
                <Download size={13} aria-hidden /> Export evidence
              </a>
            )}
          </>
        }
      />
      {audit.error && !audit.data ? (
        <ErrorCard error={audit.error} onRetry={audit.reload} />
      ) : !audit.data ? (
        <TableSkeleton rows={6} cols={6} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<ScrollText size={20} aria-hidden />} title="No events in this window" description="Edits, requests, grants, subscriptions and status changes for this asset are recorded here." />
      ) : (
        <>
          <DataTable label="Audit events">
            <thead>
              <tr>
                <Th>
                  <span className="sr-only">Expand</span>
                </Th>
                <Th>When</Th>
                <Th>Who</Th>
                <Th>Action</Th>
                <Th>Change</Th>
                <Th>Reason</Th>
                <Th>Source</Th>
                <Th>Row hash</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const expanded = open === r.audit_id;
                return (
                  <Fragment key={r.audit_id}>
                    <tr className="hover:bg-accent/40">
                      <Td className="w-10">
                        <IconButton
                          size="sm"
                          label={expanded ? "Hide before/after" : "Show before/after"}
                          aria-expanded={expanded}
                          icon={<ChevronDown size={14} aria-hidden className={cx("transition-transform", !expanded && "-rotate-90")} />}
                          onClick={() => setOpen(expanded ? null : r.audit_id)}
                        />
                      </Td>
                      <Td className="whitespace-nowrap">{fmtDateTime(r.at)}</Td>
                      <Td>
                        <span className="inline-flex items-center gap-1.5">
                          <Avatar email={r.actor} size={20} />
                          <span className="max-w-[200px] truncate">{r.actor}</span>
                        </span>
                      </Td>
                      <Td>
                        <Badge variant={r.action.includes("revoke") || r.action.includes("deny") ? "destructive" : r.action.includes("override") ? "primary" : "neutral"}>{r.action}</Badge>
                      </Td>
                      <Td className="max-w-[320px] text-ui-xs">
                        <span className="text-muted-foreground line-through decoration-destructive/40">{previewValue(r.before, 60)}</span>
                        <span aria-hidden> → </span>
                        <span className="sr-only"> changed to </span>
                        <span>{previewValue(r.after, 60)}</span>
                      </Td>
                      <Td className="max-w-[220px] truncate text-muted-foreground">{r.reason ?? "–"}</Td>
                      <Td className="text-muted-foreground">{r.source}</Td>
                      <Td>
                        <span className="inline-flex items-center gap-0.5">
                          <code title={r.row_hash} className="font-mono text-ui-xs text-muted-foreground">
                            {shortHash(r.row_hash)}…
                          </code>
                          <CopyButton value={r.row_hash} label="Copy row hash" />
                        </span>
                      </Td>
                    </tr>
                    {expanded && (
                      <tr>
                        <Td colSpan={8} className="bg-muted/20">
                          <div className="grid gap-2 py-1 md:grid-cols-2">
                            <JsonViewer value={r.before} label="Before" defaultOpen />
                            <JsonViewer value={r.after} label="After" defaultOpen />
                          </div>
                        </Td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </DataTable>
          <div className="flex items-center justify-between text-ui-sm text-muted-foreground">
            <span>
              {total.toLocaleString()} event{total === 1 ? "" : "s"} · page {page} of {pages}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

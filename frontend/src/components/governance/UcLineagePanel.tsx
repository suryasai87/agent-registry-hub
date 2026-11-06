// Governance › Unity Catalog lineage: publish the hub's agent → tool → table lineage as Unity Catalog external metadata
// and external lineage, so Catalog Explorer shows it. Plan first: GET /api/lineage/uc-publish computes the create /
// update / delete diff (with the exact requests and a digest) without writing anything; an admin publishes exactly that
// plan (POST with the digest; a changed plan answers 409). The hub only changes UC objects it created. The optional
// sync-job step (hourly) stays off until an admin turns it on. Stewards and auditors read. The Readiness checklist
// (UcReadiness.tsx) shows which grant each publishing identity still needs; while it says blocked, Publish is disabled.
import { motion } from "framer-motion";
import { CircleCheck, CloudUpload, Database, GitBranch, Info, TriangleAlert } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { api, useApi } from "../../lib/api";
import { stagger, staggerItem } from "../../lib/motion";
import type { UcLineageOp, UcLineagePlan, UcLineageStatus, UcOpCounts, UcPublishResult, UcReadiness } from "../../lib/types";
import { Banner, JsonViewer } from "../asset/primitives";
import SourcePill from "../SourcePill";
import { Badge, Button, Card, EmptyState, Modal, SectionTitle, Toggle, type BadgeVariant } from "../ui";
import { AsyncBlock, RowsSkeleton, useWrite } from "../workspace/feedback";
import { fmtDateTime, fmtRelative, humanize } from "../workspace/format";
import { RunBadge } from "./GovernancePanels";
import { publishBlockedReason, READINESS, READINESS_PATH, UcReadinessChecklist } from "./UcReadiness";

const OP: Record<UcLineageOp["op"], { variant: BadgeVariant; label: string }> = {
  create: { variant: "success", label: "Create" },
  update: { variant: "info", label: "Update" },
  delete: { variant: "destructive", label: "Delete" },
  forget: { variant: "neutral", label: "Forget record" },
};
const SHOWN = 40;

function Counts({ title, icon, counts }: { title: string; icon: ReactNode; counts: UcOpCounts }) {
  const cells: [keyof UcOpCounts, string, string][] = [
    ["create", "Create", "text-success"], ["update", "Update", "text-info"], ["delete", "Delete", "text-destructive"], ["unchanged", "Unchanged", "text-muted-foreground"],
  ];
  return (
    <Card className="space-y-2 !p-4" aria-label={title}>
      <div className="flex items-center gap-2 text-ui-sm font-semibold text-muted-foreground">{icon}{title}</div>
      <div className="grid grid-cols-4 gap-2">
        {cells.map(([k, label, tone]) => (
          <div key={k}>
            <div className={`text-ui-xl font-bold tabular-nums ${tone}`} data-count={`${title}:${k}`}>{counts[k]}</div>
            <div className="text-ui-xs text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function OpsTable({ plan }: { plan: UcLineagePlan }) {
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const ops = all ? plan.ops : plan.ops.slice(0, SHOWN);
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-ui-sm">
          <caption className="sr-only">Planned Unity Catalog operations</caption>
          <thead className="bg-muted/60 text-left text-ui-xs text-muted-foreground">
            <tr>{["Operation", "Object", "Name", "Why", ""].map((h, i) => <th key={i} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}</tr>
          </thead>
          <tbody>
            {ops.map((o) => {
              const id = `${o.kind}:${o.key}`;
              return (
                <Fragment key={id}>
                  <tr className="border-t border-border/70 align-top">
                    <td className="px-3 py-2"><Badge variant={OP[o.op].variant}>{OP[o.op].label}</Badge></td>
                    <td className="whitespace-nowrap px-3 py-2">{o.kind === "external_metadata" ? "External metadata" : "Lineage relationship"}</td>
                    <td className="max-w-md px-3 py-2">
                      <div className="font-semibold">{o.label}</div>
                      {o.label !== o.key && <div className="break-all font-mono text-ui-xs text-muted-foreground">{o.key}</div>}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{o.detail}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {o.request && (
                        <Button size="sm" variant="ghost" aria-expanded={open === id} onClick={() => setOpen(open === id ? null : id)}>
                          {open === id ? "Hide request" : "Request"}
                        </Button>
                      )}
                    </td>
                  </tr>
                  {open === id && o.request && (
                    <tr className="bg-muted/30">
                      <td colSpan={5} className="px-3 py-2"><JsonViewer value={o.request} label={`${o.request.method} ${o.request.path}`} defaultOpen /></td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {plan.ops.length > SHOWN && (
        <Button size="sm" variant="secondary" onClick={() => setAll((v) => !v)}>{all ? `Show the first ${SHOWN}` : `Show all ${plan.ops.length}${plan.truncated ? ` (of ${plan.total_ops})` : ""}`}</Button>
      )}
    </div>
  );
}

export function UcLineagePanel({ canPublish }: { canPublish: boolean }) {
  const q = useApi<UcLineageStatus>("/api/lineage/uc-publish");
  const { run, pending } = useWrite();
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<UcPublishResult | null>(null);
  const [recheck, setRecheck] = useState(0);
  const readiness = useApi<UcReadiness>(recheck ? `${READINESS_PATH}?refresh=true&n=${recheck}` : READINESS_PATH);
  const blocked = publishBlockedReason(readiness.data);
  const syncPath = readiness.data?.paths.find((p) => p.path === "sync");
  const reload = q.reload;

  const publish = async (plan: UcLineagePlan) => {
    const res = await run("publish", "Couldn't publish to Unity Catalog", () => api.post<UcPublishResult>("/api/lineage/uc-publish", { digest: plan.digest }),
      (r) => (r.status === "succeeded" || r.status === "nothing_to_do" ? `Published run #${r.run_id}` : null));
    setConfirm(false);
    if (res) {
      setResult(res);
      reload();
    }
  };
  const setSync = async (on: boolean) => {
    const res = await run("sync", "Couldn't change the setting", () => api.put("/api/lineage/uc-publish/settings", { publish_in_sync: on }),
      on ? "The hourly sync now publishes lineage to Unity Catalog" : "The hourly sync no longer publishes lineage");
    if (res) reload();
  };

  return (
    <section aria-label="Publish to Unity Catalog">
      <SectionTitle
        title="Publish to Unity Catalog"
        subtitle="The hub's lineage (agents, MCP servers, tools and skills, and the UC tables they read and write) as Unity Catalog external metadata and external lineage, so Catalog Explorer shows it. Preview the plan, then publish. The hub only ever changes objects it created."
        actions={
          <>
            <SourcePill source={q.source} degradedReason={q.degradedReason} asOf={q.asOf} />
            {q.data?.plan && <Badge variant={q.data.plan.mode === "platform" ? "info" : "warning"}>{q.data.plan.mode === "platform" ? "Platform mode" : "Record only: nothing is sent"}</Badge>}
            {canPublish && q.data?.plan && (
              <Button icon={<CloudUpload size={14} aria-hidden />} loading={pending === "publish"} disabled={q.data.plan.total_ops === 0 || blocked !== null}
                title={blocked ? `Publishing is blocked: ${blocked}` : undefined} onClick={() => setConfirm(true)}>
                {q.data.plan.total_ops === 0 ? "Up to date" : `Publish ${q.data.plan.total_ops} change${q.data.plan.total_ops === 1 ? "" : "s"}`}
              </Button>
            )}
          </>
        }
      />
      <AsyncBlock state={q} skeleton={<RowsSkeleton rows={5} />}>
        {(d) =>
          !d.available || !d.plan ? (
            <EmptyState icon={<GitBranch size={20} aria-hidden />} title="Publishing is not available yet" description={d.note ?? "The registry tables for this feature are missing."} />
          ) : (
            <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-4">
              {blocked && canPublish && d.plan.total_ops > 0 && (
                <motion.div variants={staggerItem}>
                  <Banner tone="danger" role="alert" icon={<TriangleAlert size={16} aria-hidden />} title="Publish is disabled until the missing privilege is granted">
                    {blocked} The Readiness checklist below has the exact grant SQL and who runs it; then Re-check.
                  </Banner>
                </motion.div>
              )}
              {result && (
                <motion.div variants={staggerItem} role="status" className="space-y-2 rounded-xl border border-success/40 bg-success/10 px-4 py-3 text-ui-sm">
                  <div className="flex flex-wrap items-center gap-2 font-semibold">
                    <CircleCheck size={15} aria-hidden className="text-success" />
                    Run #{result.run_id}: <RunBadge status={result.status === "nothing_to_do" ? "succeeded" : result.status} />
                    <span className="font-normal text-muted-foreground">{result.mode === "platform" ? `as ${result.acting_as}` : `${result.requests.length} request(s) recorded, none sent`}</span>
                    <button type="button" onClick={() => setResult(null)} className="ml-auto text-ui-xs font-semibold text-muted-foreground hover:text-foreground">Dismiss</button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(result.counts.outcomes ?? {}).map(([k, n]) => <Badge key={k} variant={k === "failed" ? "destructive" : "neutral"}>{humanize(k)}: {n}</Badge>)}
                  </div>
                  {result.errors.length > 0 && (
                    <ul className="space-y-0.5 text-destructive">{result.errors.slice(0, 8).map((e) => <li key={`${e.kind}:${e.key}`}><span className="font-mono text-ui-xs">{e.key}</span>: {e.error}</li>)}</ul>
                  )}
                  {result.requests.length > 0 && <JsonViewer value={result.requests} label={result.mode === "platform" ? "Failed requests" : "Recorded requests"} />}
                </motion.div>
              )}
              <motion.div variants={staggerItem} className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <Counts title="External metadata objects" icon={<Database size={14} aria-hidden />} counts={d.plan.objects} />
                <Counts title="Lineage relationships" icon={<GitBranch size={14} aria-hidden />} counts={d.plan.relationships} />
                <Card className="space-y-2 !p-4">
                  <div className="flex items-center gap-2 text-ui-sm font-semibold text-muted-foreground"><Info size={14} aria-hidden />Needs</div>
                  <ul className="list-disc space-y-0.5 pl-4 text-ui-sm">{d.plan.requirements.map((r) => <li key={r}>{r}</li>)}</ul>
                  <div className="text-ui-xs text-muted-foreground">Plan <span className="font-mono">{d.plan.digest}</span></div>
                </Card>
              </motion.div>
              <motion.div variants={staggerItem}>
                <UcReadinessChecklist q={readiness} onRecheck={() => setRecheck((n) => n + 1)} />
              </motion.div>
              <motion.div variants={staggerItem}>
                <Card className="flex flex-wrap items-center justify-between gap-3 !py-3">
                  <Toggle
                    checked={d.settings.publish_in_sync}
                    disabled={!canPublish || pending === "sync"}
                    onChange={(on) => void setSync(on)}
                    label="Publish during the hourly sync"
                    description="Off by default. When on, the sync job applies this plan after the collectors, as the job's identity."
                  />
                  {!canPublish && <span className="text-ui-xs text-muted-foreground">Only an admin publishes or changes this setting.</span>}
                  {syncPath && (
                    <span className="flex basis-full flex-wrap items-center gap-1.5 text-ui-xs text-muted-foreground" data-sync-readiness>
                      Hourly step identity <span className="font-mono">{syncPath.principal ?? "unknown"}</span>:
                      <Badge variant={(READINESS[syncPath.status] ?? READINESS.unknown).variant}>{(READINESS[syncPath.status] ?? READINESS.unknown).label}</Badge>
                      {(syncPath.status === "blocked" || syncPath.status === "unknown") && "the step skips (and records why) until this is ready."}
                    </span>
                  )}
                </Card>
              </motion.div>
              <motion.div variants={staggerItem} className="space-y-2">
                <h3 className="text-ui-md font-bold">Plan</h3>
                {d.plan.ops.length === 0 ? (
                  <p className="text-ui-sm text-muted-foreground">Unity Catalog already matches the hub: {d.plan.desired.objects} objects and {d.plan.desired.relationships} relationships.</p>
                ) : (
                  <OpsTable plan={d.plan} />
                )}
              </motion.div>
              {d.plan.skipped.length > 0 && (
                <motion.div variants={staggerItem}>
                 <details className="rounded-xl border border-border px-4 py-3">
                  <summary className="cursor-pointer text-ui-sm font-semibold">Not published ({d.plan.skipped.reduce((n, s) => n + s.count, 0)} edges)</summary>
                  <ul className="mt-2 space-y-1 text-ui-sm">
                    {d.plan.skipped.map((s) => (
                      <li key={s.reason}><Badge>{s.count}</Badge> {s.reason}<span className="block break-all font-mono text-ui-xs text-muted-foreground">{s.sample.slice(0, 2).join(" · ")}</span></li>
                    ))}
                  </ul>
                 </details>
                </motion.div>
              )}
              {d.runs.length > 0 && (
                <motion.div variants={staggerItem} className="space-y-2">
                  <h3 className="text-ui-md font-bold">Runs</h3>
                  <ul className="space-y-1 text-ui-sm">
                    {d.runs.map((r) => (
                      <li key={r.run_id} className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-ui-xs">#{r.run_id}</span>
                        <RunBadge status={r.status === "nothing_to_do" ? "succeeded" : r.status} />
                        <span title={fmtDateTime(r.started_at)}>{fmtRelative(r.started_at)}</span>
                        <span className="text-muted-foreground">by {r.triggered_by} · {r.mode === "platform" ? r.acting_as ?? "platform" : "record only"}</span>
                        {Object.entries(r.counts.outcomes ?? {}).map(([k, n]) => <Badge key={k} variant={k === "failed" ? "destructive" : "neutral"}>{humanize(k)} {n}</Badge>)}
                      </li>
                    ))}
                  </ul>
                </motion.div>
              )}
            </motion.div>
          )
        }
      </AsyncBlock>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Publish to Unity Catalog"
        description={q.data?.plan?.mode === "platform"
          ? "Applies exactly the plan you previewed, as you (with an on-behalf-of token) or the app's service principal. One audit row records the run."
          : "Record-only mode: the requests are stored with the run and nothing is sent to the workspace."}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button loading={pending === "publish"} icon={<CloudUpload size={14} aria-hidden />} onClick={() => q.data?.plan && void publish(q.data.plan)}>Publish</Button>
          </>
        }
      >
        {q.data?.plan && (
          <div className="space-y-2 text-ui-sm">
            <p>{q.data.plan.objects.create} objects to create, {q.data.plan.objects.update} to update, {q.data.plan.objects.delete} to delete; {q.data.plan.relationships.create + q.data.plan.relationships.update + q.data.plan.relationships.delete} relationship changes.</p>
            {readiness.data?.enforced && (readiness.data.status === "partial" || readiness.data.status === "unknown") && (
              <p className="flex items-start gap-1.5 text-warning"><TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />
                {readiness.data.status === "partial" ? "Some tables lack MODIFY: their relationships fail and are retried by the next plan." : "Readiness couldn't be confirmed: the run reports any operation Unity Catalog refuses."}
              </p>
            )}
            {q.data.plan.objects.delete + q.data.plan.relationships.delete > 0 && (
              <p className="flex items-start gap-1.5 text-warning"><TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />Deletes only remove objects the hub created; each one is re-read and checked first.</p>
            )}
          </div>
        )}
      </Modal>
    </section>
  );
}

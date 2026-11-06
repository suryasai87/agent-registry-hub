// Governance › Unity Catalog lineage › Knowledge graph (Delta): the registry as RDF triples, exported as Unity Catalog
// Delta objects in the OntoBricks layout so Genie agents and OntoBricks can query the graph. Preview first:
// GET /api/kg/preview builds the triples and the exact SQL without writing; an admin exports exactly that digest
// (POST /api/kg/export; a changed graph answers 409). The hub only replaces objects it created. Stewards and auditors
// read. Every field is optional on purpose: a failing or partial endpoint degrades to a message, never a crash.
import { motion } from "framer-motion";
import { CircleCheck, Database, Download, ExternalLink, Network, Share2, TriangleAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, useApi } from "../../lib/api";
import { stagger, staggerItem } from "../../lib/motion";
import type { KgExportResult, KgPreview, KgStatus, KgTerm } from "../../lib/types";
import SourcePill from "../SourcePill";
import { Badge, Button, Card, EmptyState, Input, Modal, SectionTitle, Toggle } from "../ui";
import { AsyncBlock, RowsSkeleton, useWrite } from "../workspace/feedback";
import { fmtDateTime, fmtRelative, humanize } from "../workspace/format";
import { RunBadge } from "./GovernancePanels";

const TOP = 8;
const fmt = (n: number | null | undefined) => (typeof n === "number" ? n.toLocaleString("en-US") : "–");

function Terms({ title, terms }: { title: string; terms: KgTerm[] }) {
  const top = [...terms].sort((a, b) => b.count - a.count).slice(0, TOP);
  return (
    <Card className="space-y-2 !p-4" aria-label={title}>
      <div className="text-ui-sm font-semibold text-muted-foreground">{title} ({terms.length})</div>
      {top.length === 0 ? (
        <p className="text-ui-sm text-muted-foreground">None yet.</p>
      ) : (
        <ul className="space-y-0.5 text-ui-sm">
          {top.map((t) => (
            <li key={t.iri} className="flex justify-between gap-2" title={t.iri}>
              <span className="truncate">{t.label}</span>
              <span className="tabular-nums text-muted-foreground" data-term={`${title}:${t.name}`}>{fmt(t.count)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function TargetForm({ catalog, schema, onSave, pending }: { catalog: string; schema: string; pending: boolean; onSave: (c: string, s: string) => void }) {
  const [c, setC] = useState(catalog);
  const [s, setS] = useState(schema);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave(c.trim(), s.trim());
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2" aria-label="Knowledge graph target">
      <Input label="Catalog" value={c} onChange={(e) => setC(e.target.value)} wrapperClassName="w-44" />
      <Input label="Schema" value={s} onChange={(e) => setS(e.target.value)} wrapperClassName="w-52" />
      <Button type="submit" variant="secondary" loading={pending} disabled={!c.trim() || !s.trim()}>Save target</Button>
    </form>
  );
}

export function KnowledgeGraphCard({ canExport }: { canExport: boolean }) {
  const q = useApi<KgPreview>("/api/kg/preview");
  const st = useApi<KgStatus>("/api/kg/status");
  const { run, pending } = useWrite();
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<KgExportResult | null>(null);
  const reload = () => {
    q.reload();
    st.reload();
  };

  const exportNow = async (digest: string) => {
    const res = await run("export", "Couldn't export the knowledge graph", () => api.post<KgExportResult>("/api/kg/export", { digest }),
      (r) => (r.status === "succeeded" ? `Exported run #${r.run_id}` : r.status === "unchanged" ? "Already up to date: nothing was written" : null));
    setConfirm(false);
    if (res) {
      setResult(res);
      reload();
    }
  };
  const saveTarget = async (catalog: string, schema: string) => {
    const res = await run("target", "Couldn't save the target", () => api.put("/api/kg/settings", { catalog, schema }), "Target saved");
    if (res) reload();
  };
  const setSync = async (on: boolean) => {
    const res = await run("sync", "Couldn't change the setting", () => api.put("/api/kg/settings", { export_in_sync: on }),
      on ? "The hourly sync now exports the knowledge graph" : "The hourly sync no longer exports the knowledge graph");
    if (res) reload();
  };

  const settings = st.data?.settings;
  const lastRun = st.data?.runs?.[0] ?? null;
  const p = q.data;
  const exportable = canExport && !!p?.can_export && !!p?.digest;

  return (
    <section aria-label="Knowledge graph (Delta)" className="space-y-3">
      <SectionTitle
        title="Knowledge graph (Delta)"
        subtitle="The registry as RDF triples (agents, MCP servers, tools, skills, tables, policies and their Microsoft Agent 365 records), written to Unity Catalog in the OntoBricks layout so Genie agents and OntoBricks can query it. No subscriber, requester or usage identities: only counts."
        actions={
          <>
            <SourcePill source={q.source} degradedReason={q.degradedReason} asOf={q.asOf} />
            {p?.mode && <Badge variant={p.mode === "platform" ? "info" : "warning"}>{p.mode === "platform" ? "Platform mode" : "Record only: nothing is sent"}</Badge>}
            {canExport && p && (
              <Button icon={<Share2 size={14} aria-hidden />} loading={pending === "export"} disabled={!exportable} onClick={() => setConfirm(true)}>
                {p.unchanged_since_last_run ? "Export (up to date)" : "Export"}
              </Button>
            )}
          </>
        }
      />
      <AsyncBlock state={q} skeleton={<RowsSkeleton rows={3} />} errorTitle="Couldn't load the knowledge graph preview">
        {(d) =>
          !d.available ? (
            <EmptyState icon={<Network size={20} aria-hidden />} title="The knowledge graph export is not available yet" description={d.note ?? "The registry tables for this feature are missing."} />
          ) : (
            <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-3">
              {result && (
                <motion.div variants={staggerItem} role="status"
                  className={`space-y-1.5 rounded-xl border px-4 py-3 text-ui-sm ${result.status === "succeeded" || result.status === "unchanged" ? "border-success/40 bg-success/10" : "border-destructive/40 bg-destructive/10"}`}>
                  <div className="flex flex-wrap items-center gap-2 font-semibold">
                    {result.status === "succeeded" || result.status === "unchanged" ? <CircleCheck size={15} aria-hidden className="text-success" /> : <TriangleAlert size={15} aria-hidden className="text-destructive" />}
                    Run #{result.run_id}: <RunBadge status={result.status} />
                    <span className="font-normal text-muted-foreground">
                      {result.status === "unchanged" ? "every object already carries this digest" : result.mode === "platform" ? `as ${result.acting_as ?? "the app"}` : `${result.statements?.length ?? 0} statement(s) recorded, none sent`}
                    </span>
                    <button type="button" onClick={() => setResult(null)} className="ml-auto text-ui-xs font-semibold text-muted-foreground hover:text-foreground">Dismiss</button>
                  </div>
                  {(result.conflicts ?? []).length > 0 && (
                    <ul className="space-y-0.5 text-destructive">
                      {result.conflicts.map((c) => <li key={c.name}><span className="font-mono text-ui-xs">{c.name}</span>: {c.reason}</li>)}
                    </ul>
                  )}
                  {result.error && <p className="text-destructive">{result.error}</p>}
                </motion.div>
              )}
              <motion.div variants={staggerItem} className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <Card className="space-y-2 !p-4" aria-label="Target">
                  <div className="flex items-center gap-2 text-ui-sm font-semibold text-muted-foreground"><Database size={14} aria-hidden />Target</div>
                  {d.target ? (
                    <>
                      <div className="break-all font-mono text-ui-sm">{d.target.data_table}</div>
                      <div className="text-ui-xs text-muted-foreground">from {d.target.source === "bundle" ? "the bundle variable kg_target" : "Governance settings"} · OntoBricks domain version {d.target.version}</div>
                      {d.explorer_url && (
                        <a href={d.explorer_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-ui-sm font-semibold text-primary hover:underline">
                          Open in Catalog Explorer <ExternalLink size={12} aria-hidden />
                        </a>
                      )}
                    </>
                  ) : (
                    <p className="text-ui-sm text-muted-foreground">{d.note ?? "No target yet."}</p>
                  )}
                </Card>
                <Card className="space-y-1 !p-4" aria-label="Triples">
                  <div className="text-ui-sm font-semibold text-muted-foreground">Triples</div>
                  <div className="text-ui-xl font-bold tabular-nums" data-count="triples">{fmt(d.triples)}</div>
                  <div className="text-ui-xs text-muted-foreground">
                    {d.load ? `${d.load.batches} insert batch(es) · ${(d.objects ?? []).length} objects` : "Set a target to see the load plan"}
                  </div>
                  {d.digest && <div className="text-ui-xs text-muted-foreground">Digest <span className="font-mono" data-digest>{d.digest}</span></div>}
                </Card>
                <Terms title="Classes" terms={d.classes ?? []} />
                <Terms title="Predicates" terms={(d.predicates ?? []).filter((x) => x.kind !== "rdf")} />
              </motion.div>
              <motion.div variants={staggerItem}>
                <Card className="flex flex-wrap items-center justify-between gap-3 !py-3" aria-label="Last run">
                  <div className="flex flex-wrap items-center gap-2 text-ui-sm">
                    <span className="font-semibold">Last run</span>
                    {lastRun ? (
                      <>
                        <span className="font-mono text-ui-xs">#{lastRun.run_id}</span>
                        <RunBadge status={lastRun.status} />
                        <span title={fmtDateTime(lastRun.started_at)}>{fmtRelative(lastRun.started_at)}</span>
                        <span className="text-muted-foreground">by {lastRun.triggered_by} · {lastRun.mode === "platform" ? lastRun.acting_as ?? "platform" : "record only"}</span>
                      </>
                    ) : st.error ? (
                      <span className="text-muted-foreground">Run history is unavailable right now.</span>
                    ) : (
                      <RunBadge status={null} />
                    )}
                    {d.unchanged_since_last_run && <Badge variant="success">Up to date</Badge>}
                  </div>
                  <a href="/api/kg/ontology.ttl" className="inline-flex items-center gap-1 text-ui-sm font-semibold text-primary hover:underline">
                    <Download size={13} aria-hidden /> Ontology (.ttl) for OntoBricks
                  </a>
                </Card>
              </motion.div>
              {canExport && settings && (
                <motion.div variants={staggerItem}>
                  <Card className="flex flex-wrap items-end justify-between gap-3 !py-3">
                    <TargetForm catalog={settings.catalog || d.target?.catalog || ""} schema={settings.schema || d.target?.schema || ""}
                      pending={pending === "target"} onSave={(c, s) => void saveTarget(c, s)} />
                    <Toggle checked={settings.export_in_sync} disabled={pending === "sync"} onChange={(on) => void setSync(on)}
                      label="Export during the hourly sync" description="Off by default. When on, the sync job exports after the collectors when the graph changed." />
                  </Card>
                </motion.div>
              )}
              {(d.skipped ?? []).length > 0 && (
                <motion.div variants={staggerItem}>
                  <details className="rounded-xl border border-border px-4 py-3">
                    <summary className="cursor-pointer text-ui-sm font-semibold">Left out ({d.skipped.reduce((n, s) => n + s.count, 0)})</summary>
                    <ul className="mt-2 space-y-1 text-ui-sm">{d.skipped.map((s) => <li key={s.reason}><Badge>{s.count}</Badge> {s.reason}</li>)}</ul>
                  </details>
                </motion.div>
              )}
              {(d.statements ?? []).length > 0 && (
                <motion.div variants={staggerItem}>
                  <details className="rounded-xl border border-border px-4 py-3">
                    <summary className="cursor-pointer text-ui-sm font-semibold">SQL the export runs ({d.statements.length} steps)</summary>
                    <ol className="mt-2 space-y-2 text-ui-xs">
                      {d.statements.map((s, i) => (
                        <li key={`${s.step}:${i}`}>
                          <Badge>{humanize(s.step)}</Badge>{s.detail && <span className="ml-2 text-muted-foreground">{s.detail}</span>}
                          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/50 p-2 font-mono">{s.sql}</pre>
                        </li>
                      ))}
                    </ol>
                  </details>
                </motion.div>
              )}
            </motion.div>
          )
        }
      </AsyncBlock>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Export the knowledge graph"
        description={p?.mode === "platform"
          ? "Writes exactly the previewed graph to Unity Catalog on the SQL warehouse, as you (with an on-behalf-of token) or the app's service principal. One audit row records the run."
          : "Record-only mode: the statements are stored with the run and nothing is sent to the workspace."}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button loading={pending === "export"} icon={<Share2 size={14} aria-hidden />} onClick={() => p?.digest && void exportNow(p.digest)}>Export</Button>
          </>
        }
      >
        {p && (
          <div className="space-y-2 text-ui-sm">
            <p>{fmt(p.triples)} triples into <span className="font-mono">{p.target?.data_table ?? "–"}</span> and {(p.objects ?? []).length - 1} companion objects. Digest <span className="font-mono">{p.digest}</span>.</p>
            <p className="flex items-start gap-1.5 text-warning"><TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />Only objects the hub created are replaced; a name taken by anything else stops the run before it writes.</p>
          </div>
        )}
      </Modal>
    </section>
  );
}

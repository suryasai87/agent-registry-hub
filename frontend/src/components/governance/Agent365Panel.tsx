// Governance › Agent 365: Microsoft Agent 365 Connected platforms lists Databricks Genie agents in the Microsoft 365
// agent registry; matching those records here fills each agent's "Also registered in". Two inputs: Microsoft Graph via
// an admin-configured UC HTTP connection (the optional agent365 collector), or an export file an admin uploads (Agents >
// All agents > Export). Matched records link automatically; suggestions and unmatched Databricks records wait here for
// a steward (link / dismiss / reopen, each with a reason). Nothing here creates registry assets.
import { motion } from "framer-motion";
import { CircleCheck, FileUp, Link2, RefreshCw, RotateCcw, Unplug, X } from "lucide-react";
import { useRef, useState } from "react";
import { api, useApi } from "../../lib/api";
import { stagger, staggerItem } from "../../lib/motion";
import type { Agent365ImportResult, Agent365Overview, ExternalRegistration } from "../../lib/types";
import AssetPicker, { type PickedAsset } from "../asset/AssetPicker";
import SourcePill from "../SourcePill";
import { Badge, Button, Card, EmptyState, Modal, SectionTitle, TextArea, type BadgeVariant } from "../ui";
import { AssetLink } from "../workspace/chips";
import { AsyncBlock, RowsSkeleton, useWrite } from "../workspace/feedback";
import { fmtDateTime, fmtRelative, humanize } from "../workspace/format";
import { RunBadge } from "./GovernancePanels";

const STATUS: Record<ExternalRegistration["status"], { variant: BadgeVariant; label: string }> = {
  matched: { variant: "success", label: "Matched" },
  linked: { variant: "success", label: "Linked by steward" },
  suggested: { variant: "warning", label: "Suggested" },
  unmatched: { variant: "neutral", label: "Unmatched" },
  dismissed: { variant: "neutral", label: "Dismissed" },
};

const pct = (c: number | null) => (c == null ? "" : `${Math.round(c * 100)}%`);

type Decision = { reg: ExternalRegistration; action: "link" | "dismiss" | "reopen" };

function DecisionDialog({ decision, onClose, onDone }: { decision: Decision; onClose: () => void; onDone: () => void }) {
  const { reg, action } = decision;
  const [reason, setReason] = useState("");
  const [asset, setAsset] = useState<PickedAsset | null>(
    reg.matched_asset_id ? { asset_id: reg.matched_asset_id, display_name: reg.asset_display_name ?? reg.matched_asset_id, asset_type: "agent" } : null,
  );
  const { run, pending } = useWrite();
  const title = { link: `Link “${reg.display_name}”`, dismiss: `Dismiss “${reg.display_name}”`, reopen: `Reopen “${reg.display_name}”` }[action];
  const submit = async () => {
    const res = await run("decide", "Couldn't save the decision", () => api.post("/api/agent365/review", {
      external_id: reg.external_id, action, asset_id: action === "link" ? asset?.asset_id : undefined, reason: reason.trim(),
    }), action === "link" ? `Linked to ${asset?.display_name}` : action === "dismiss" ? "Dismissed" : "Back in the review queue");
    if (res) {
      onDone();
      onClose();
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size="lg"
      description={action === "link" ? "The Microsoft ID appears on the agent's Overview under “Also registered in”. Later imports keep your decision." :
        action === "dismiss" ? "The record leaves the queue and is never linked automatically. Later imports keep your decision." : "The record goes back to the review queue."}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant={action === "dismiss" ? "danger" : "primary"} loading={pending === "decide"} disabled={!reason.trim() || (action === "link" && !asset)} onClick={() => void submit()}>
            {action === "link" ? "Link" : action === "dismiss" ? "Dismiss" : "Reopen"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-ui-sm text-muted-foreground">
          <span className="font-mono">{reg.external_id}</span>{reg.platform ? ` · ${reg.platform}` : ""}{reg.hints.note ? ` · ${reg.hints.note}` : ""}
        </p>
        {action === "link" && <AssetPicker value={asset} onChange={setAsset} label="Registry agent" types={["agent"]} />}
        <TextArea data-autofocus label="Reason (required, audited)" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Modal>
  );
}

function Rows({ rows, canReview, onDecide, linked = false }: { rows: ExternalRegistration[]; canReview: boolean; onDecide: (d: Decision) => void; linked?: boolean }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-ui-sm">
        <caption className="sr-only">{linked ? "Linked registrations" : "Registrations waiting for review"}</caption>
        <thead className="bg-muted/60 text-left text-ui-xs text-muted-foreground">
          <tr>{["Microsoft 365 agent", "Status", linked ? "Registry agent" : "Best match", "Evidence", ""].map((h, i) => <th key={i} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.external_id} className="border-t border-border/70 align-top">
              <td className="px-3 py-2">
                <div className="font-semibold">{r.display_name ?? "(no name)"}</div>
                <div className="font-mono text-ui-xs text-muted-foreground">{r.external_id}</div>
                {r.platform && <div className="text-ui-xs text-muted-foreground">{r.platform}</div>}
              </td>
              <td className="px-3 py-2"><Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge></td>
              <td className="px-3 py-2">
                {r.matched_asset_id ? (
                  <span className="flex flex-col">
                    <AssetLink assetId={r.matched_asset_id} name={r.asset_display_name} type="agent" />
                    <span className="text-ui-xs text-muted-foreground">{humanize(r.match_method ?? "")} {pct(r.confidence)}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">–</span>
                )}
              </td>
              <td className="max-w-xs px-3 py-2 text-ui-xs text-muted-foreground">
                {[...(r.hints.genie_space_ids ?? []).map((s) => `space ${s}`), ...(r.hints.workspace_hosts ?? [])].join(" · ") || r.hints.note || "name only"}
                {r.review_note && <div className="mt-0.5 italic">“{r.review_note}” ({r.reviewed_by})</div>}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right">
                {canReview && (linked || r.status === "dismissed" ? (
                  <Button size="sm" variant="ghost" icon={<RotateCcw size={12} aria-hidden />} onClick={() => onDecide({ reg: r, action: "reopen" })}>Reopen</Button>
                ) : (
                  <>
                    <Button size="sm" variant="secondary" icon={<Link2 size={12} aria-hidden />} onClick={() => onDecide({ reg: r, action: "link" })}>Link</Button>
                    <Button size="sm" variant="ghost" icon={<X size={12} aria-hidden />} onClick={() => onDecide({ reg: r, action: "dismiss" })}>Dismiss</Button>
                  </>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Agent365Panel() {
  const q = useApi<Agent365Overview>("/api/agent365");
  const { run, pending } = useWrite();
  const fileRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<Agent365ImportResult | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const reload = q.reload;

  const importFile = async (file: File) => {
    const content = await file.text();
    const res = await run("import", "Couldn't import the export", () => api.post<Agent365ImportResult>("/api/agent365/import", {
      filename: file.name, content, format: file.name.toLowerCase().endsWith(".json") ? "json" : "csv",
    }));
    if (fileRef.current) fileRef.current.value = "";
    if (res) {
      setResult(res);
      reload();
    }
  };
  const syncGraph = async () => {
    const res = await run("graph", "Couldn't start the Graph sync", () => api.post("/api/governance/sync", { collectors: ["agent365"] }), "Graph sync started");
    if (res) setTimeout(reload, 4000);
  };

  return (
    <section aria-label="Microsoft Agent 365">
      <SectionTitle
        title="Microsoft Agent 365"
        subtitle="Agent 365 Connected platforms lists Databricks Genie agents in the Microsoft 365 agent registry. Matching those records fills each agent's “Also registered in” with its Microsoft ID; nothing here creates assets."
        actions={<SourcePill source={q.source} degradedReason={q.degradedReason} asOf={q.asOf} />}
      />
      <AsyncBlock state={q} skeleton={<RowsSkeleton rows={5} />}>
        {(d) => (
          <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-4">
            <motion.div variants={staggerItem} className="grid gap-3 lg:grid-cols-2">
              <Card className="space-y-2">
                <div className="flex items-center gap-2 text-ui-md font-bold">{d.graph.configured ? <CircleCheck size={16} aria-hidden className="text-success" /> : <Unplug size={16} aria-hidden className="text-muted-foreground" />}Microsoft Graph</div>
                {d.graph.configured ? (
                  <>
                    <p className="text-ui-sm text-muted-foreground">Through the UC HTTP connection <span className="font-mono">{d.graph.connection}</span>: <span className="font-mono text-ui-xs">{d.graph.endpoint}</span>. The credential stays in the connection.</p>
                    {d.can_review && <Button size="sm" variant="secondary" icon={<RefreshCw size={13} aria-hidden />} loading={pending === "graph"} onClick={() => void syncGraph()}>Sync from Graph now</Button>}
                  </>
                ) : (
                  <p className="text-ui-sm text-muted-foreground">Not configured. An admin sets the bundle variable <span className="font-mono">agent365_connection</span> to a UC HTTP connection for graph.microsoft.com (an Entra app with CopilotPackages.Read.All). Until then, import an export file.</p>
                )}
              </Card>
              <Card className="space-y-2">
                <div className="flex items-center gap-2 text-ui-md font-bold"><FileUp size={16} aria-hidden className="text-muted-foreground" />Import an export</div>
                <p className="text-ui-sm text-muted-foreground">Microsoft 365 admin center › Agents › All agents › Export (CSV), or a JSON export / Graph page. Non-Databricks agents are ignored.</p>
                {d.can_import ? (
                  <>
                    <input ref={fileRef} type="file" accept=".csv,.json,text/csv,application/json" aria-label="Agent 365 export file" className="block text-ui-sm"
                           onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); }} />
                    {pending === "import" && <p className="text-ui-sm text-muted-foreground" role="status">Matching records…</p>}
                  </>
                ) : (
                  <p className="text-ui-xs text-muted-foreground">Only an admin imports files.</p>
                )}
              </Card>
            </motion.div>
            {result && (
              <motion.div variants={staggerItem} role="status" className="flex flex-wrap items-center gap-2 rounded-xl border border-success/40 bg-success/10 px-4 py-3 text-ui-sm">
                <CircleCheck size={15} aria-hidden className="text-success" />
                <span className="font-semibold">Imported {result.records} records:</span>
                <Badge variant="success">{result.matched} matched</Badge>
                <Badge variant="warning">{result.suggested} suggested</Badge>
                <Badge>{result.unmatched} unmatched</Badge>
                <Badge>{result.ignored_not_databricks} not Databricks</Badge>
                {result.kept_steward_decision > 0 && <Badge>{result.kept_steward_decision} steward decisions kept</Badge>}
                <span className="text-muted-foreground">{result.assets_linked} agent(s) updated</span>
                <button type="button" onClick={() => setResult(null)} className="ml-auto text-ui-xs font-semibold text-muted-foreground hover:text-foreground">Dismiss</button>
              </motion.div>
            )}
            <motion.div variants={staggerItem} className="flex flex-wrap items-center gap-2 text-ui-sm">
              {(Object.keys(STATUS) as ExternalRegistration["status"][]).map((s) => (
                <Badge key={s} variant={(d.counts[s] ?? 0) > 0 ? STATUS[s].variant : "neutral"}>{STATUS[s].label}: {d.counts[s] ?? 0}</Badge>
              ))}
              {d.runs[0] && (
                <span className="text-muted-foreground">
                  Last run <RunBadge status={d.runs[0].status} /> <span title={fmtDateTime(d.runs[0].started_at)}>{fmtRelative(d.runs[0].started_at)}</span> by {d.runs[0].triggered_by}
                </span>
              )}
            </motion.div>
            <motion.div variants={staggerItem} className="space-y-2">
              <h3 className="text-ui-md font-bold">Steward review ({d.review.length})</h3>
              {d.review.length === 0 ? (
                <EmptyState title="Nothing to review" description="Suggested and unmatched Databricks records from Agent 365 appear here." />
              ) : (
                <Rows rows={d.review} canReview={d.can_review} onDecide={setDecision} />
              )}
            </motion.div>
            {d.linked.length > 0 && (
              <motion.div variants={staggerItem} className="space-y-2">
                <h3 className="text-ui-md font-bold">Linked and dismissed ({d.linked.length})</h3>
                <Rows rows={d.linked} canReview={d.can_review} onDecide={setDecision} linked />
              </motion.div>
            )}
          </motion.div>
        )}
      </AsyncBlock>
      {decision && <DecisionDialog decision={decision} onClose={() => setDecision(null)} onDone={reload} />}
    </section>
  );
}

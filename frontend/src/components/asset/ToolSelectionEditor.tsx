// Tool selection for a Unity Catalog MCP service (config.include_tool_selectors), on the "Tools exposed" tab.
// Read view: the current selectors, how many known tools they expose and the last request. Owners and stewards edit:
// selectors (one per line, exact names or prefix*), validated and previewed live against the known tools → "Preview
// impact" (POST …/tool-selection/preview: hidden tools, affected subscribers / downstream agents / observed callers, the
// email) → Apply (PUT …/tool-selection: the PATCH as the approver or the app SP, or recorded only). Hiding a tool is a
// breaking change and needs a reason; Apply needs a fresh preview of the exact draft.
import { AnimatePresence, motion } from "framer-motion";
import { CircleCheck, CircleX, Eye, Mail, Pencil, ShieldCheck, SlidersHorizontal, TriangleAlert, Users, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, useApi } from "../../lib/api";
import { cx } from "../../lib/cx";
import type { ToolSelectionPreview, ToolSelectionResult, ToolSelectionState } from "../../lib/types";
import SourcePill from "../SourcePill";
import { Badge, Button, Card, SectionTitle, TextArea, useToast } from "../ui";
import { useAsset } from "./AssetContext";
import { SideEffectBadge } from "./badges";
import { writeErrorMessage } from "./errors";
import { fmtDateTime } from "./format";
import { Banner, JsonViewer } from "./primitives";
import { ImpactList } from "./PublishChangeFlow";
import { diffSelection, parseSelectors, validateSelectors } from "./toolSelection";

const STATUS = {
  applied: { variant: "success" as const, label: "Applied in Unity Catalog" },
  recorded: { variant: "warning" as const, label: "Recorded only (not sent)" },
  failed: { variant: "destructive" as const, label: "Failed" },
};

function SelectorChips({ selectors }: { selectors: string[] }) {
  if (!selectors.length) return <Badge variant="info">Every tool (no selection)</Badge>;
  return (
    <span className="flex flex-wrap gap-1">
      {selectors.map((s) => (
        <code key={s} className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-ui-xs">{s}</code>
      ))}
    </span>
  );
}

export default function ToolSelectionEditor() {
  const { base, refreshKey, reload } = useAsset();
  const q = useApi<ToolSelectionState>(`${base}/tool-selection`, [refreshKey]);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<{ key: string; data: ToolSelectionPreview } | null>(null);
  const [result, setResult] = useState<ToolSelectionResult | null>(null);
  const [busy, setBusy] = useState<false | "preview" | "apply">(false);
  const [error, setError] = useState<string | null>(null);

  const state = q.data;
  const check = useMemo(() => validateSelectors(parseSelectors(text), state?.limits), [text, state?.limits]);
  const live = useMemo(() => diffSelection(state?.tools ?? [], state?.current ?? [], check.selectors), [state, check.selectors]);
  const key = JSON.stringify(check.selectors);
  const fresh = preview?.key === key ? preview.data : null;
  const needsReason = live.breaking && reason.trim().length < 10;

  if (!state) {
    return q.error ? <Banner tone="danger" title="Couldn't load the tool selection">{writeErrorMessage(q.error)}</Banner> : null;
  }
  if (!state.editable) return null;

  const start = () => {
    setText(state.current.join("\n"));
    setReason("");
    setPreview(null);
    setResult(null);
    setError(null);
    setEditing(true);
  };
  const toggleTool = (name: string) => {
    const list = check.selectors.includes(name) ? check.selectors.filter((s) => s !== name) : [...check.selectors, name];
    setText(list.join("\n"));
  };

  const runPreview = async () => {
    setBusy("preview");
    setError(null);
    try {
      const data = await api.post<ToolSelectionPreview>(`${base}/tool-selection/preview`, { selectors: check.selectors, reason: reason.trim() || null });
      setPreview({ key, data });
    } catch (err) {
      setError(writeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!fresh) return;
    setBusy("apply");
    setError(null);
    try {
      const res = await api.put<ToolSelectionResult>(`${base}/tool-selection`, { selectors: check.selectors, etag: state.etag, reason: reason.trim() || null });
      setResult(res);
      if (res.status === "failed") {
        toast.error("Unity Catalog refused the change", res.error ?? undefined);
      } else {
        toast.success(res.status === "applied" ? "Tool selection applied" : "Tool selection recorded", res.change ? `Change #${res.change.change.change_id} published to consumers.` : undefined);
        setEditing(false);
        q.reload();
        reload();
      }
    } catch (err) {
      setError(writeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const exposed = state.tools.filter((t) => t.exposed_now).length;
  const last = state.history[0];

  return (
    <section aria-label="Tool selection" className="space-y-3">
      <SectionTitle
        title="Tool selection"
        subtitle="Unity Catalog include_tool_selectors: which of this service's tools agents can list and call. Exact names or a prefix ending in *; an empty selection exposes every tool."
        actions={
          <>
            <SourcePill source={q.source} degradedReason={q.degradedReason} asOf={q.asOf} />
            {state.mode === "record_only" && <Badge variant="warning" title="PROVISIONING_MODE=record_only: requests are stored and shown, never sent">Record only</Badge>}
            {state.can_edit && !editing && (
              <Button size="sm" icon={<Pencil size={13} aria-hidden />} onClick={start}>
                Edit selection
              </Button>
            )}
          </>
        }
      />

      {!editing && (
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <SlidersHorizontal size={16} aria-hidden className="text-muted-foreground" />
            <SelectorChips selectors={state.current} />
            <span className="text-ui-sm text-muted-foreground">
              {exposed} of {state.tools.length} known tool{state.tools.length === 1 ? "" : "s"} exposed
            </span>
            {!state.can_edit && <span className="text-ui-xs text-muted-foreground">Only the service's owners and stewards can change it.</span>}
          </div>
          {(result ?? last) && (
            <div className="space-y-2 border-t border-border pt-3 text-ui-sm">
              {result ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={STATUS[result.status].variant}>{STATUS[result.status].label}</Badge>
                  {result.as && <span className="text-muted-foreground">as {result.as}</span>}
                  {result.change && (
                    <Link className="font-semibold text-primary hover:underline" to={`/changes/${result.change.change.change_id}`}>
                      Change #{result.change.change.change_id}: {result.change.impact.filter((i) => i.email).length} people notified
                    </Link>
                  )}
                  {result.note && <span className="text-muted-foreground">{result.note}</span>}
                </div>
              ) : last ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">Last request</span>
                  <Badge variant={STATUS[last.status].variant}>{STATUS[last.status].label}</Badge>
                  <span className="text-muted-foreground">by {last.requested_by} · {fmtDateTime(last.created_at)}</span>
                  {last.change_id && <Link className="font-semibold text-primary hover:underline" to={`/changes/${last.change_id}`}>Change #{last.change_id}</Link>}
                  {last.error && <span className="text-destructive">{last.error}</span>}
                </div>
              ) : null}
              <JsonViewer value={(result ?? last)!.request} label="Exact request" />
            </div>
          )}
        </Card>
      )}

      <AnimatePresence>
        {editing && (
          <motion.div key="editor" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.4, ease: "easeOut" }}>
            <Card className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="space-y-3">
                  <TextArea
                    label="Selectors (one per line)"
                    hint={`Exact tool names or a prefix ending in * (lookup_*). Up to ${state.limits.max_selectors.toLocaleString("en-US")}, no ! exclusions. Leave empty to expose every tool.`}
                    rows={7}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    className="font-mono text-ui-sm"
                    error={check.errors.length ? `${check.errors.length} problem${check.errors.length === 1 ? "" : "s"}` : undefined}
                  />
                  {check.errors.length > 0 && (
                    <ul role="alert" aria-label="Selector problems" className="space-y-1 text-ui-sm text-destructive">
                      {check.errors.map((e) => (
                        <li key={e} className="flex items-start gap-1.5"><CircleX size={13} aria-hidden className="mt-0.5 shrink-0" />{e}</li>
                      ))}
                    </ul>
                  )}
                  {(check.warnings.length > 0 || live.unmatched.length > 0 || live.narrowsAll) && (
                    <ul aria-label="Selector warnings" className="space-y-1 text-ui-sm text-warning">
                      {check.warnings.map((w) => <li key={w}>{w}</li>)}
                      {live.unmatched.length > 0 && <li>{live.unmatched.join(", ")}: match no tool the registry has seen yet (they still apply to tools/list)</li>}
                      {live.narrowsAll && <li>Today every tool is exposed: a selection also hides tools the registry has not observed yet</li>}
                    </ul>
                  )}
                  <TextArea
                    label={live.breaking ? "Reason and what consumers should do (required: this hides tools)" : "Reason (optional, shown in the change notice)"}
                    rows={3}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    error={live.breaking && reason.trim().length > 0 && reason.trim().length < 10 ? "At least 10 characters" : undefined}
                  />
                </div>
                <section aria-label="Live preview" className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2 text-ui-base font-semibold">
                    Live preview
                    <Badge variant="success">{live.rows.filter((r) => r.exposed_after).length} exposed</Badge>
                    <Badge>{live.rows.filter((r) => !r.exposed_after).length} hidden</Badge>
                    {live.breaking && <Badge variant="destructive" icon={<TriangleAlert size={11} aria-hidden />}>Breaking</Badge>}
                  </div>
                  <ul className="max-h-72 space-y-1 overflow-y-auto rounded-xl border border-border p-2">
                    {live.rows.map((r) => {
                      const change = r.exposed_now && !r.exposed_after ? "hide" : !r.exposed_now && r.exposed_after ? "expose" : null;
                      return (
                        <li key={r.asset_id} data-tool={r.name} data-state={r.exposed_after ? "exposed" : "hidden"}
                            className={cx("flex items-center gap-2 rounded-lg px-2 py-1 text-ui-sm", change === "hide" && "bg-destructive/10", change === "expose" && "bg-success/10")}>
                          <input type="checkbox" aria-label={`Select ${r.name} exactly`} checked={check.selectors.includes(r.name)} onChange={() => toggleTool(r.name)} />
                          <code className="min-w-0 flex-1 truncate font-mono text-ui-xs">{r.name}</code>
                          <SideEffectBadge effect={r.side_effect ?? "unknown"} />
                          {change === "hide" ? <Badge variant="destructive">Will be hidden</Badge> : change === "expose" ? <Badge variant="success">Will be exposed</Badge> :
                            <span className={cx("text-ui-xs", r.exposed_after ? "text-success" : "text-muted-foreground")}>{r.exposed_after ? "Exposed" : "Hidden"}</span>}
                        </li>
                      );
                    })}
                    {live.rows.length === 0 && <li className="px-2 py-1 text-ui-sm text-muted-foreground">No tools observed yet: the selection still applies to tools/list.</li>}
                  </ul>
                </section>
              </div>

              {error && <Banner tone="danger" role="alert" title="Couldn't save">{error}</Banner>}
              {result?.status === "failed" && (
                <Banner tone="danger" role="alert" title="Unity Catalog refused the change: nothing was changed or announced">
                  <div>{result.error}</div>
                  <div className="mt-2"><JsonViewer value={result.request} label="The request that failed" /></div>
                </Banner>
              )}

              {fresh && (
                <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: "easeOut" }} className="space-y-3" aria-label="Impact preview">
                  <div className="flex flex-wrap items-center gap-2 text-ui-base font-semibold">
                    <ShieldCheck size={16} aria-hidden className="text-primary" />
                    Impact preview
                    {fresh.breaking ? <Badge variant="destructive">Breaking: {fresh.removed.length ? `${fresh.removed.length} tool${fresh.removed.length === 1 ? "" : "s"} hidden` : "selection narrowed"}</Badge> : <Badge variant="success">Non-breaking</Badge>}
                    {fresh.impact && <Badge variant="primary">{fresh.impact.total_people} people notified</Badge>}
                  </div>
                  {fresh.impact && (
                    <div className="grid gap-3 lg:grid-cols-3">
                      <ImpactList title="Subscribers & owners" icon={<Users size={15} aria-hidden />} items={fresh.impact.subscribers} empty="No subscribers." />
                      <ImpactList title="Downstream agents" icon={<SlidersHorizontal size={15} aria-hidden />} items={fresh.impact.downstream} empty="No downstream assets in lineage." />
                      <ImpactList title="Observed callers (not subscribed)" icon={<Eye size={15} aria-hidden />} items={fresh.impact.observed} empty="No unregistered callers in 30 days." />
                    </div>
                  )}
                  {fresh.impact && (
                    <p className="flex items-center gap-1.5 text-ui-sm text-muted-foreground"><Mail size={13} aria-hidden /> {fresh.impact.email_preview.subject}</p>
                  )}
                  <JsonViewer value={fresh.request} label={fresh.mode === "platform" ? "Request Apply sends" : "Request Apply records (record_only)"} defaultOpen />
                </motion.div>
              )}

              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
                {!live.changed && <span className="mr-auto text-ui-sm text-muted-foreground">This is the current selection.</span>}
                {preview && !fresh && <span className="mr-auto text-ui-sm text-warning">The selection changed since the preview: preview again.</span>}
                <Button variant="ghost" icon={<X size={14} aria-hidden />} onClick={() => setEditing(false)}>Cancel</Button>
                <Button variant={fresh ? "secondary" : "primary"} icon={<Eye size={14} aria-hidden />} loading={busy === "preview"}
                        disabled={!live.changed || check.errors.length > 0} onClick={() => void runPreview()}>
                  {preview && !fresh ? "Refresh preview" : "Preview impact"}
                </Button>
                <Button icon={<CircleCheck size={14} aria-hidden />} loading={busy === "apply"} disabled={!fresh || check.errors.length > 0 || needsReason}
                        variant={fresh?.breaking ? "danger" : "primary"} onClick={() => void apply()}>
                  {state.mode === "platform" ? "Apply to Unity Catalog" : "Record change"}
                </Button>
              </div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

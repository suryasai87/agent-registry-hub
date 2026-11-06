// Publish a change (benchmark §5.5), as a full panel: describe the change → Preview impact (POST …/changes/preview:
// affected subscribers, downstream assets + owners, observed unregistered consumers, the rendered email, pass/fail
// checks) → Publish (POST …/changes) → the impact report. Publishing needs a fresh preview of the exact draft.
import { AnimatePresence, motion } from "framer-motion";
import { CircleCheck, CircleX, Eye, Mail, Rocket, TriangleAlert, Users, X } from "lucide-react";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { assetApi } from "../../lib/assets";
import { cx } from "../../lib/cx";
import type { AssetCard, ChangeDetail, ImpactItem, ImpactPreview } from "../../lib/types";
import { Badge, Button, Card, IconButton, Input, TextArea, Toggle, useToast } from "../ui";
import { writeErrorMessage } from "./errors";
import { endOfLocalDayIso, isoDateFromToday, plural, suggestVersion } from "./format";

export const CHANGE_KINDS: { value: string; label: string }[] = [
  { value: "description", label: "Description" },
  { value: "tools_added", label: "Tools added" },
  { value: "tools_removed", label: "Tools removed" },
  { value: "schema", label: "Schema" },
  { value: "model", label: "Model" },
  { value: "prompt", label: "Prompt / instructions" },
  { value: "policy", label: "Policy" },
  { value: "owner", label: "Owner" },
  { value: "deprecation", label: "Deprecation" },
];

/** Kinds that are breaking by nature: picking one switches the Breaking toggle on. */
const BREAKING_KINDS = new Set(["tools_removed", "schema", "deprecation"]);
export const BREAKING_NOTICE_DAYS = 14;

export interface ChangeBody {
  to_version: string;
  change_kinds: string[];
  breaking: boolean;
  title: string;
  summary?: string | null;
  release_notes?: string | null;
  effective_at?: string | null;
}

export function ImpactList({ title, icon, items, empty }: { title: string; icon: ReactNode; items: ImpactItem[]; empty: string }) {
  return (
    <section aria-label={title} className="rounded-xl border border-border bg-card p-3">
      <div className="mb-2 flex items-center gap-2 text-ui-base font-semibold">
        {icon}
        {title}
        <Badge variant={items.length ? "primary" : "neutral"}>{items.length}</Badge>
      </div>
      {items.length === 0 ? (
        <p className="text-ui-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="max-h-48 space-y-1 overflow-y-auto">
          {items.map((it) => (
            <li key={`${it.impact_type}-${it.impacted_key}`} className="flex items-start gap-2 text-ui-sm">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium" title={it.label}>
                  {it.label}
                </span>
                {it.email && it.email !== it.label && (
                  <span className="block truncate text-ui-xs text-muted-foreground" title={it.email}>
                    {it.email}
                  </span>
                )}
              </span>
              {it.hops > 1 && <Badge className="shrink-0">{it.hops} hops</Badge>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function PublishChangeFlow({ asset, onCancel, onPublished }: { asset: AssetCard & { published_version?: string | null; latest_version?: string | null }; onCancel: () => void; onPublished?: (detail: ChangeDetail) => void }) {
  const current = asset.published_version ?? asset.latest_version ?? null;
  const [kinds, setKinds] = useState<string[]>([]);
  const [breaking, setBreaking] = useState(false);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [notes, setNotes] = useState("");
  const [version, setVersion] = useState(() => suggestVersion(current, false));
  const [versionTouched, setVersionTouched] = useState(false);
  const [effective, setEffective] = useState(() => isoDateFromToday(0));
  const [effectiveTouched, setEffectiveTouched] = useState(false);
  const [tried, setTried] = useState(false);
  const [preview, setPreview] = useState<{ key: string; data: ImpactPreview } | null>(null);
  const [busy, setBusy] = useState<false | "preview" | "publish">(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptFailing, setAcceptFailing] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();
  const base = assetApi(asset.asset_id);

  const setBreakingAndDefaults = (next: boolean) => {
    setBreaking(next);
    if (!versionTouched) setVersion(suggestVersion(current, next));
    if (!effectiveTouched) setEffective(isoDateFromToday(next ? BREAKING_NOTICE_DAYS : 0));
  };

  const toggleKind = (k: string, on: boolean) => {
    const next = on ? [...kinds, k] : kinds.filter((x) => x !== k);
    setKinds(next);
    if (on && BREAKING_KINDS.has(k) && !breaking) setBreakingAndDefaults(true);
  };

  const body: ChangeBody = useMemo(
    () => ({
      to_version: version.trim(),
      change_kinds: kinds,
      breaking,
      title: title.trim(),
      summary: summary.trim() || null,
      release_notes: notes.trim() || null,
      effective_at: effective ? endOfLocalDayIso(effective) : null,
    }),
    [version, kinds, breaking, title, summary, notes, effective],
  );
  const key = JSON.stringify(body);
  const fresh = preview?.key === key ? preview.data : null;
  const failing = fresh?.checks.filter((c) => !c.passed) ?? [];

  const errors = {
    kinds: kinds.length === 0 ? "Pick at least one kind of change." : null,
    title: !title.trim() ? "Give the change a title." : null,
    version: !version.trim() ? "Enter the new version." : null,
    notes: breaking && !notes.trim() ? "Release notes are required for a breaking change (what breaks and how to migrate)." : null,
    effective: !effective ? "Pick an effective date." : null,
  };
  const valid = Object.values(errors).every((e) => !e);

  const runPreview = async (e?: FormEvent) => {
    e?.preventDefault();
    setTried(true);
    if (!valid) return;
    setBusy("preview");
    setError(null);
    setAcceptFailing(false);
    try {
      const data = await api.post<ImpactPreview>(`${base}/changes/preview`, body);
      setPreview({ key, data });
    } catch (err) {
      const msg = writeErrorMessage(err);
      setError(msg);
      toast.error("Preview failed", msg);
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!fresh || (failing.length > 0 && !acceptFailing)) return;
    setBusy("publish");
    setError(null);
    try {
      const detail = await api.post<ChangeDetail>(`${base}/changes`, body);
      toast.success("Change published", `${plural(detail.impact.length, "impact row")} recorded; notifications are queued.`);
      onPublished?.(detail);
      navigate(`/changes/${detail.change.change_id}`);
    } catch (err) {
      const msg = writeErrorMessage(err);
      setError(msg);
      toast.error("Not published", msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.section aria-labelledby="publish-title" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: "easeOut" }} className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="publish-title" className="text-ui-xl font-extrabold tracking-tight">
            Publish a change to {asset.display_name}
          </h2>
          <p className="text-ui-sm text-muted-foreground">
            Subscribers, downstream owners and observed consumers are notified{breaking ? ` at least ${BREAKING_NOTICE_DAYS} days before a breaking change takes effect` : ""}. Preview the impact before you publish.
          </p>
        </div>
        <IconButton label="Close publish flow" icon={<X size={16} aria-hidden />} onClick={onCancel} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <Card className="space-y-4">
          <form id="publish-form" noValidate onSubmit={runPreview} className="space-y-4">
            <fieldset>
              <legend className="mb-2 text-ui-sm font-semibold">What changed?</legend>
              <div className="flex flex-wrap gap-2">
                {CHANGE_KINDS.map((k) => {
                  const on = kinds.includes(k.value);
                  return (
                    <label key={k.value} className={cx("inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-ui-sm", on ? "border-primary bg-primary/12 text-primary" : "border-border hover:border-primary/40")}>
                      <input type="checkbox" className="accent-primary" checked={on} onChange={(e) => toggleKind(k.value, e.target.checked)} />
                      {k.label}
                    </label>
                  );
                })}
              </div>
              {tried && errors.kinds && <p role="alert" className="mt-1 text-ui-xs font-medium text-destructive">{errors.kinds}</p>}
            </fieldset>
            <Toggle
              checked={breaking}
              onChange={setBreakingAndDefaults}
              label="Breaking change"
              description={`Consumers must act. Defaults the effective date to ${BREAKING_NOTICE_DAYS} days from today and suggests a major version.`}
            />
            <Input label="Title" placeholder="e.g. Remove the legacy search_mail tool" value={title} onChange={(e) => setTitle(e.target.value)} error={tried ? errors.title : null} />
            <TextArea label="Summary" rows={2} placeholder="One or two sentences for the notification" value={summary} onChange={(e) => setSummary(e.target.value)} />
            <TextArea
              label={breaking ? "Release notes (required for breaking changes)" : "Release notes"}
              rows={4}
              placeholder="What changes, why, and the migration steps"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              error={tried ? errors.notes : null}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="New version"
                value={version}
                onChange={(e) => {
                  setVersion(e.target.value);
                  setVersionTouched(true);
                }}
                hint={current ? `Current: ${current}` : "No published version yet"}
                error={tried ? errors.version : null}
              />
              <Input
                type="date"
                label="Effective date"
                value={effective}
                min={isoDateFromToday(0)}
                onChange={(e) => {
                  setEffective(e.target.value);
                  setEffectiveTouched(true);
                }}
                error={tried ? errors.effective : null}
                hint={breaking ? `Recommended notice: ${BREAKING_NOTICE_DAYS} days` : undefined}
              />
            </div>
          </form>
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            <Button type="submit" form="publish-form" variant={fresh ? "secondary" : "primary"} loading={busy === "preview"} icon={<Eye size={15} aria-hidden />}>
              {preview && !fresh ? "Refresh preview" : "Preview impact"}
            </Button>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </Card>

        <div className="space-y-3" aria-live="polite">
          <AnimatePresence mode="wait">
            {!preview ? (
              <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="grid h-full min-h-[280px] place-items-center rounded-xl border border-dashed border-border p-6 text-center">
                <div>
                  <Users size={22} aria-hidden className="mx-auto mb-2 text-muted-foreground" />
                  <p className="text-ui-md font-bold">Preview who this reaches</p>
                  <p className="mx-auto mt-1 max-w-sm text-ui-sm text-muted-foreground">Describe the change, then Preview impact: you'll see every subscriber, downstream asset and observed consumer, the exact email, and the pre-publish checks.</p>
                </div>
              </motion.div>
            ) : (
              <motion.div key="preview" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.4, ease: "easeOut" }} className={cx("space-y-3", !fresh && "opacity-60")}>
                {!fresh && (
                  <p role="status" className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-sm">
                    The draft changed since this preview. Refresh the preview before publishing.
                  </p>
                )}
                <Card className="!p-4">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-ui-2xl font-extrabold tabular-nums">{preview.data.total_people}</span>
                    <span className="text-ui-base text-muted-foreground">people will be notified</span>
                  </div>
                </Card>
                <div className="grid gap-3 md:grid-cols-3">
                  <ImpactList title="Subscribers" icon={<Users size={14} aria-hidden />} items={preview.data.subscribers} empty="No subscribers yet." />
                  <ImpactList title="Downstream assets & owners" icon={<Rocket size={14} aria-hidden />} items={preview.data.downstream} empty="Nothing downstream in lineage." />
                  <ImpactList title="Observed consumers" icon={<TriangleAlert size={14} aria-hidden />} items={preview.data.observed} empty="No unregistered consumers seen in 30 days." />
                </div>
                <section aria-label="Email preview" className="overflow-hidden rounded-xl border border-border bg-card">
                  <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-ui-sm">
                    <Mail size={14} aria-hidden className="text-primary" />
                    <span className="text-muted-foreground">Subject:</span>
                    <span className="min-w-0 truncate font-semibold">{preview.data.email_preview.subject}</span>
                  </div>
                  <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap px-3 py-2 font-sans text-ui-sm leading-relaxed">{preview.data.email_preview.body}</pre>
                </section>
                <section aria-label="Pre-publish checks" className="rounded-xl border border-border bg-card p-3">
                  <div className="mb-2 text-ui-base font-semibold">Pre-publish checks</div>
                  <ul className="space-y-1.5">
                    {preview.data.checks.map((c) => (
                      <li key={c.name} data-check={c.passed ? "pass" : "fail"} className={cx("flex items-start gap-2 rounded-lg px-2 py-1.5 text-ui-sm", !c.passed && "bg-destructive/8")}>
                        {c.passed ? <CircleCheck size={15} className="mt-0.5 shrink-0 text-success" aria-hidden /> : <CircleX size={15} className="mt-0.5 shrink-0 text-destructive" aria-hidden />}
                        <span className="min-w-0 flex-1">
                          <span className="font-semibold">{c.name}</span>
                          <span className="sr-only">{c.passed ? " passed" : " failed"}</span>
                          <span className="block text-ui-xs text-muted-foreground">{c.detail}</span>
                        </span>
                        <Badge variant={c.passed ? "success" : "destructive"}>{c.passed ? "Pass" : "Fail"}</Badge>
                      </li>
                    ))}
                  </ul>
                </section>
                {fresh && failing.length > 0 && (
                  <label className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-sm">
                    <input type="checkbox" className="mt-0.5 accent-primary" checked={acceptFailing} onChange={(e) => setAcceptFailing(e.target.checked)} />
                    Publish anyway: I accept {plural(failing.length, "failing check")}. This is recorded in the audit log.
                  </label>
                )}
                {error && (
                  <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
                    {error}
                  </p>
                )}
                <div className="flex justify-end">
                  <Button size="lg" icon={<Rocket size={16} aria-hidden />} loading={busy === "publish"} disabled={!fresh || (failing.length > 0 && !acceptFailing)} onClick={() => void publish()}>
                    Publish {body.to_version ? `v${body.to_version.replace(/^v/i, "")}` : "change"}
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          {error && !preview && (
            <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      </div>
    </motion.section>
  );
}

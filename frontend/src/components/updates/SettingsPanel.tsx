// Settings tab: the auto-upgrade policy (radio cards), relevance threshold, default delay and how long a failed
// branch is kept. Admins edit (each setting saves on its own, the server's value is what shows); everyone else
// reads. Below, the branch-regression pipeline as a small animated flow.
import { useReducedMotion } from "framer-motion";
import {
  Bell, CircleCheck, FlaskConical, GitBranch, Hand, Lock, Rocket, Rss, Save, ShieldCheck, UserCheck, Zap, type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { api } from "../../lib/api";
import { cx } from "../../lib/cx";
import FlowDiagram, { type FlowEdge, type FlowNode } from "../FlowDiagram";
import { Badge, Button, Card, Input, SectionTitle } from "../ui";
import { useWrite } from "../workspace/feedback";
import { NUMBER_SETTINGS, POLICY_COPY, type AutoUpgrade, type SettingKey, type WatchSettings } from "./model";

export const settingPath = (key: SettingKey) => `/api/platform-watch/settings/${key}`;

const POLICY_ICON: Record<AutoUpgrade, LucideIcon> = { never: Hand, non_breaking: ShieldCheck, all: Zap };
const POLICY_ORDER: AutoUpgrade[] = ["never", "non_breaking", "all"];

type Saved = (key: SettingKey, value: unknown) => void;

function PolicyCard({ current, canEdit, onSaved }: { current: AutoUpgrade; canEdit: boolean; onSaved: Saved }) {
  const [draft, setDraft] = useState<AutoUpgrade>(current);
  const { run, pending } = useWrite();
  const name = useId();
  useEffect(() => {
    setDraft(current);
  }, [current]);
  const save = async () => {
    const res = await run("auto_upgrade", "Couldn't save the auto-upgrade policy", () => api.put<{ key: string; value: unknown }>(settingPath("auto_upgrade"), { value: draft }), (r) => `Auto-upgrade policy: ${POLICY_COPY[r.value as AutoUpgrade]?.label ?? String(r.value)}`);
    if (res) onSaved("auto_upgrade", res.value);
  };
  return (
    <Card className="space-y-3">
      <SectionTitle className="!mb-1" title="Auto-upgrade policy" subtitle="What happens to an update whose branch regression passes. Advisories always wait for an admin." />
      <fieldset disabled={!canEdit} className="relative grid gap-2.5 lg:grid-cols-3">
        <legend className="sr-only">Auto-upgrade policy</legend>
        {POLICY_ORDER.map((p) => {
          const Icon = POLICY_ICON[p];
          const copy = POLICY_COPY[p];
          const checked = draft === p;
          return (
            <label
              key={p}
              className={cx(
                "relative flex cursor-pointer flex-col gap-2 rounded-xl border p-3.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:disabled]:cursor-default",
                checked ? "border-primary/60 bg-primary/8" : "border-border hover:border-primary/30",
              )}
            >
              <span className="flex items-center gap-2">
                <input type="radio" name={name} value={p} checked={checked} onChange={() => setDraft(p)} className="accent-[hsl(var(--primary))]" />
                <span className={cx("grid h-7 w-7 place-items-center rounded-lg", checked ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}>
                  <Icon size={15} aria-hidden />
                </span>
                <span className="text-ui-md font-bold">{copy.label}</span>
                {current === p && <Badge variant="success" icon={<CircleCheck size={11} aria-hidden />} className="ml-auto">Current</Badge>}
              </span>
              <span className="text-ui-sm font-semibold">{copy.short}</span>
              <span className="text-ui-sm text-muted-foreground">{copy.detail}</span>
            </label>
          );
        })}
      </fieldset>
      {canEdit && (
        <div className="flex items-center justify-end gap-3">
          {draft !== current && <span className="text-ui-xs text-muted-foreground">Not saved yet</span>}
          <Button icon={<Save size={14} aria-hidden />} loading={pending === "auto_upgrade"} disabled={draft === current} onClick={() => void save()}>
            Save policy
          </Button>
        </div>
      )}
    </Card>
  );
}

function NumberSetting({ spec, current, canEdit, onSaved }: { spec: (typeof NUMBER_SETTINGS)[number]; current: number; canEdit: boolean; onSaved: Saved }) {
  const [draft, setDraft] = useState(String(current));
  const { run, pending } = useWrite();
  useEffect(() => {
    setDraft(String(current));
  }, [current]);
  const n = Number(draft);
  const invalid = draft.trim() === "" || !Number.isInteger(n) || n < spec.min || n > spec.max;
  const dirty = !invalid && n !== current;
  const save = async () => {
    const res = await run(spec.key, `Couldn't save ${spec.label.toLowerCase()}`, () => api.put<{ key: string; value: unknown }>(settingPath(spec.key), { value: n }), (r) => `${spec.label}: ${String(r.value)} ${spec.unit}`);
    if (res) onSaved(spec.key, res.value);
  };
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/80 bg-muted/20 p-3.5">
      <Input
        type="number"
        inputMode="numeric"
        label={`${spec.label} (${spec.unit})`}
        min={spec.min}
        max={spec.max}
        step={1}
        value={draft}
        disabled={!canEdit}
        onChange={(e) => setDraft(e.target.value)}
        hint={spec.hint}
        error={invalid ? `A whole number from ${spec.min} to ${spec.max}` : undefined}
        className="max-w-[10rem] font-mono tabular-nums"
      />
      {canEdit && (
        <div className="mt-auto flex justify-end">
          <Button size="sm" variant="secondary" icon={<Save size={13} aria-hidden />} loading={pending === spec.key} disabled={!dirty} onClick={() => void save()} aria-label={`Save ${spec.label.toLowerCase()}`}>
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ how it works
const INFO = "hsl(var(--info))";
const PRIMARY = "hsl(var(--primary))";
const TEAL = "hsl(var(--db-teal))";
const ORANGE = "hsl(var(--db-orange))";
const SUCCESS = "hsl(var(--success))";
const IC = { size: 15, "aria-hidden": true } as const;
const NODE_W = 152;
const NODE_H = 96;
const GAP = 34;
const x = (i: number) => 8 + i * (NODE_W + GAP);

const NODES: FlowNode[] = [
  { id: "feeds", x: x(0), y: 20, w: NODE_W, h: NODE_H, step: 1, title: "Feeds & probes", subtitle: "RSS · Atom · API probes", icon: <Rss {...IC} />, accent: INFO },
  { id: "candidate", x: x(1), y: 20, w: NODE_W, h: NODE_H, step: 2, title: "Candidate", subtitle: "release · capability · advisory", icon: <Bell {...IC} />, accent: PRIMARY },
  { id: "branch", x: x(2), y: 20, w: NODE_W, h: NODE_H, step: 3, title: "Lakebase branch", subtitle: "copy-on-write of prod", icon: <GitBranch {...IC} />, accent: TEAL },
  { id: "regression", x: x(3), y: 20, w: NODE_W, h: NODE_H, step: 4, title: "Regression", subtitle: "migrate · smoke · pytest", icon: <FlaskConical {...IC} />, accent: TEAL },
  { id: "decision", x: x(4), y: 20, w: NODE_W, h: NODE_H, step: 5, title: "Admin decision", subtitle: "accept · delay · reject", icon: <UserCheck {...IC} />, accent: ORANGE },
  { id: "apply", x: x(5), y: 20, w: NODE_W, h: NODE_H, step: 6, title: "Apply", subtitle: "migrate · enable · deploy", icon: <Rocket {...IC} />, accent: SUCCESS },
];

function flowEdges(dots: (n: number) => number): FlowEdge[] {
  return [
    { from: "feeds", to: "candidate", color: INFO, dots: dots(2) },
    { from: "candidate", to: "branch", color: PRIMARY, dots: dots(2) },
    { from: "branch", to: "regression", color: TEAL, dots: dots(3) },
    { from: "regression", to: "decision", color: TEAL, dots: dots(2) },
    { from: "decision", to: "apply", color: ORANGE, dots: dots(2) },
  ];
}

const FLOW_W = x(5) + NODE_W + 8;

export function HowItWorksFlow({ keepHours }: { keepHours: number }) {
  const reduce = useReducedMotion();
  const steps: { title: string; body: string }[] = [
    { title: "Feeds & probes", body: "Platform Watch reads the Databricks release notes, MLflow, SDK and CLI feeds, scores every item against the APIs the registry uses, and probes each API in this workspace." },
    { title: "Candidate", body: "A newer staged app version, a newly available API or a relevant announcement becomes a candidate. Pending migrations are analysed for breaking changes." },
    { title: "Lakebase branch", body: "A throwaway copy-on-write branch of the production database is created: today's live data, isolated from production." },
    { title: "Regression", body: `Row-count snapshot, migrations, data preservation, collector compatibility, read-path smoke checks and the pytest suite run on the branch. It is deleted on success and kept ${keepHours} h on failure.` },
    { title: "Admin decision", body: "An admin accepts, delays or rejects it (advisories are acknowledged). Breaking changes need a note. The auto-upgrade policy may skip this step for passing updates." },
    { title: "Apply", body: "The apply job migrates production, enables the adapter or deploys the staged app, and records every step in the apply report and the audit trail." },
  ];
  return (
    <Card className="space-y-4" aria-labelledby="pu-how">
      <SectionTitle id="pu-how" className="!mb-0" title="How it works" subtitle="Nothing reaches production before it has passed on a copy of production." />
      <div className="rounded-xl border border-border/70 bg-background/40 py-2">
        <FlowDiagram nodes={NODES} edges={flowEdges((n) => (reduce ? 0 : n))} width={FLOW_W} height={140} />
      </div>
      <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.title} className="flex gap-2.5">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary text-[10px] font-extrabold text-primary-foreground">{i + 1}</span>
            <span className="text-ui-sm">
              <span className="font-semibold">{s.title}. </span>
              <span className="text-muted-foreground">{s.body}</span>
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export default function SettingsPanel({ settings, canEdit, onSaved }: { settings: WatchSettings; canEdit: boolean; onSaved: Saved }) {
  return (
    <section aria-label="Platform Watch settings" className="space-y-5">
      {!canEdit && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-ui-sm text-muted-foreground">
          <Lock size={14} aria-hidden /> Read-only: only admins change Platform Watch settings.
        </div>
      )}
      <PolicyCard current={settings.auto_upgrade} canEdit={canEdit} onSaved={onSaved} />
      <Card className="space-y-3">
        <SectionTitle className="!mb-1" title="Thresholds" subtitle="How sensitive the feed is, how long a delay lasts by default, and how long a failed branch is kept for debugging." />
        <div className="grid gap-3 lg:grid-cols-3">
          {NUMBER_SETTINGS.map((spec) => (
            <NumberSetting key={spec.key} spec={spec} current={settings[spec.key]} canEdit={canEdit} onSaved={onSaved} />
          ))}
        </div>
      </Card>
      <HowItWorksFlow keepHours={settings.keep_failed_branch_hours} />
    </section>
  );
}

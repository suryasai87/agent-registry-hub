// Traces (Databricks-built agents): MLflow-style table (time, duration, state, tokens, user, assessment chips),
// a row drawer with the details + "Open in MLflow", and the daily trend. Consumers only see their own traces.
import { CircleCheck, CircleX, ExternalLink, FlaskConical, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { useAsset } from "../../components/asset/AssetContext";
import { fmtDateTime, fmtDay, fmtMs } from "../../components/asset/format";
import { Banner, ChartFrame, CopyButton, DataTable, DefinitionList, ErrorCard, SectionSkeleton, Td, Th } from "../../components/asset/primitives";
import SourcePill from "../../components/SourcePill";
import { Badge, Drawer, EmptyState, SectionTitle } from "../../components/ui";
import { useApi } from "../../lib/api";
import { cx } from "../../lib/cx";
import type { AssetTraces, TraceRow } from "../../lib/types";

const AXIS = { fill: "hsl(var(--muted-foreground))" };
const TIP_STYLE = { background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 10, color: "hsl(var(--popover-foreground))" };

function StateBadge({ state }: { state: string }) {
  if (state === "OK") return <Badge variant="success" icon={<CircleCheck size={11} aria-hidden />}>OK</Badge>;
  if (state === "ERROR") return <Badge variant="destructive" icon={<CircleX size={11} aria-hidden />}>Error</Badge>;
  if (state === "IN_PROGRESS") return <Badge variant="info" icon={<LoaderCircle size={11} aria-hidden />}>In progress</Badge>;
  return <Badge>{state}</Badge>;
}

function AssessmentChip({ a }: { a: TraceRow["assessments"][number] }) {
  const v = a.value;
  const good = v === true || v === "yes" || v === "pass" || (typeof v === "number" && v >= 0.7);
  const bad = v === false || v === "no" || v === "fail" || (typeof v === "number" && v < 0.5);
  const text = v === null ? "–" : typeof v === "number" ? (v <= 1 ? v.toFixed(2) : String(v)) : String(v);
  return (
    <span title={`${a.name}: ${text} (${a.source_type})`} className={cx("inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-ui-xs font-medium", good ? "border-success/35 text-success" : bad ? "border-destructive/35 text-destructive" : "border-border text-muted-foreground")}>
      {good ? <CircleCheck size={10} aria-hidden /> : bad ? <CircleX size={10} aria-hidden /> : null}
      {a.name}: {text}
    </span>
  );
}

export default function TracesTab() {
  const { base, refreshKey, detail } = useAsset();
  const traces = useApi<AssetTraces>(`${base}/traces?limit=50`, [refreshKey]);
  const [open, setOpen] = useState<TraceRow | null>(null);

  if (traces.error && !traces.data) return <ErrorCard error={traces.error} onRetry={traces.reload} />;
  if (!traces.data) return <SectionSkeleton blocks={2} />;
  const t = traces.data;
  const scoped = !detail.permissions.can_view_traces;

  if (!t.experiment_id && t.traces.length === 0) {
    return (
      <EmptyState
        icon={<FlaskConical size={22} aria-hidden />}
        title="No MLflow experiment is linked"
        description={
          t.note ??
          "Traces appear once this agent logs to an MLflow experiment: set the serving endpoint's MONITOR_EXPERIMENT_ID tag (or use the Agent Bricks experiment) and enable tracing with mlflow.tracing. The next sync links it here."
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      <SectionTitle
        title="Traces"
        subtitle={scoped ? "Only your own traces are shown." : `The latest ${t.traces.length} traces from the linked MLflow experiment.`}
        actions={
          <>
            <SourcePill source={traces.source} degradedReason={traces.degradedReason} asOf={traces.asOf} />
            {t.deep_link && (
              <a href={t.deep_link} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-ui-sm font-semibold hover:bg-accent">
                Open in MLflow <ExternalLink size={12} aria-hidden />
              </a>
            )}
          </>
        }
      />
      {t.note && <Banner tone="info" title="Note">{t.note}</Banner>}

      {t.daily.length > 0 && (
        <ChartFrame
          title="Daily traces"
          height={180}
          summary={`${t.daily.reduce((s, d) => s + d.traces, 0).toLocaleString()} traces and ${t.daily.reduce((s, d) => s + d.errors, 0).toLocaleString()} errors over ${t.daily.length} days.`}
          table={
            <DataTable label="Daily traces" dense>
              <thead>
                <tr>
                  <Th>Day</Th>
                  <Th align="right">Traces</Th>
                  <Th align="right">Errors</Th>
                  <Th align="right">p95</Th>
                </tr>
              </thead>
              <tbody>
                {t.daily.map((d) => (
                  <tr key={d.day}>
                    <Td>{fmtDay(d.day)}</Td>
                    <Td align="right">{d.traces}</Td>
                    <Td align="right">{d.errors}</Td>
                    <Td align="right">{fmtMs(d.p95_ms)}</Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          }
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={t.daily.map((d) => ({ ...d, label: fmtDay(d.day), ok: Math.max(0, d.traces - d.errors) }))} margin={{ top: 6, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis tick={AXIS} tickLine={false} axisLine={false} width={40} />
              <RTooltip contentStyle={TIP_STYLE} />
              <Bar dataKey="ok" name="OK" stackId="t" fill="hsl(var(--success))" />
              <Bar dataKey="errors" name="Errors" stackId="t" fill="hsl(var(--destructive))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartFrame>
      )}

      {t.traces.length === 0 ? (
        <EmptyState title="No traces in the window" description="The experiment is linked, but no traces were logged recently." />
      ) : (
        <DataTable label="Traces">
          <thead>
            <tr>
              <Th>Time</Th>
              <Th>Name</Th>
              <Th align="right">Duration</Th>
              <Th>State</Th>
              <Th align="right">Tokens in / out</Th>
              <Th>User</Th>
              <Th>Assessments</Th>
            </tr>
          </thead>
          <tbody>
            {t.traces.map((row) => (
              <tr
                key={row.trace_id}
                tabIndex={0}
                aria-label={`Trace ${row.trace_id}, ${row.state}, open details`}
                onClick={() => setOpen(row)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setOpen(row);
                  }
                }}
                className="cursor-pointer hover:bg-accent/40 focus-visible:bg-accent/50"
              >
                <Td className="whitespace-nowrap">{fmtDateTime(row.request_time)}</Td>
                <Td className="max-w-[220px] truncate font-mono text-ui-xs">{row.trace_name ?? row.trace_id}</Td>
                <Td align="right">{fmtMs(row.duration_ms)}</Td>
                <Td>
                  <StateBadge state={row.state} />
                </Td>
                <Td align="right">
                  {row.input_tokens?.toLocaleString() ?? "–"} / {row.output_tokens?.toLocaleString() ?? "–"}
                </Td>
                <Td className="max-w-[200px] truncate">{row.user ?? "–"}</Td>
                <Td>
                  <span className="flex flex-wrap gap-1">
                    {row.assessments.slice(0, 3).map((a) => (
                      <AssessmentChip key={a.name} a={a} />
                    ))}
                    {row.assessments.length > 3 && <span className="text-ui-xs text-muted-foreground">+{row.assessments.length - 3}</span>}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      <Drawer open={!!open} onClose={() => setOpen(null)} title="Trace" description={open?.trace_name ?? undefined} width={520}>
        {open && (
          <div className="space-y-4">
            <DefinitionList
              items={[
                {
                  label: "Trace ID",
                  value: (
                    <span className="flex items-center gap-1">
                      <code className="break-all font-mono text-ui-xs">{open.trace_id}</code>
                      <CopyButton value={open.trace_id} label="Copy trace ID" />
                    </span>
                  ),
                },
                { label: "Time", value: fmtDateTime(open.request_time) },
                { label: "Duration", value: fmtMs(open.duration_ms) },
                { label: "State", value: <StateBadge state={open.state} /> },
                { label: "Tokens", value: `${open.input_tokens?.toLocaleString() ?? "–"} in · ${open.output_tokens?.toLocaleString() ?? "–"} out` },
                { label: "User", value: open.user ?? "–" },
              ]}
            />
            <div>
              <h3 className="mb-2 text-ui-base font-semibold">Assessments</h3>
              {open.assessments.length === 0 ? (
                <p className="text-ui-sm text-muted-foreground">No assessments on this trace.</p>
              ) : (
                <ul className="space-y-1">
                  {open.assessments.map((a) => (
                    <li key={a.name} className="flex items-center gap-2 text-ui-sm">
                      <AssessmentChip a={a} />
                      <span className="text-ui-xs text-muted-foreground">{a.source_type}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {t.deep_link && (
              <a href={t.deep_link} target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-ui-base font-semibold text-primary-foreground hover:brightness-110">
                Open in MLflow <ExternalLink size={13} aria-hidden />
              </a>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}

// Evals: a scorer scoreboard (mean, pass rate, n, trend sparkline) split into production monitoring and offline
// evaluation runs, plus the runs table with one column per scorer.
import { ExternalLink, FlaskConical } from "lucide-react";
import { useAsset } from "../../components/asset/AssetContext";
import { fmtDateTime } from "../../components/asset/format";
import { Banner, DataTable, ErrorCard, SectionSkeleton, Td, Th } from "../../components/asset/primitives";
import Sparkline from "../../components/asset/Sparkline";
import SourcePill from "../../components/SourcePill";
import { Card, EmptyState, SectionTitle } from "../../components/ui";
import { useApi } from "../../lib/api";
import { fmtPct } from "../../lib/assets";
import { cx } from "../../lib/cx";
import type { AssetEvals, ScorerSummary } from "../../lib/types";

function ScorerCard({ s }: { s: ScorerSummary }) {
  const tone = s.pass_rate == null ? "" : s.pass_rate >= 0.9 ? "text-success" : s.pass_rate >= 0.7 ? "text-warning" : "text-destructive";
  return (
    <Card className="space-y-2 !p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="truncate text-ui-base font-semibold">{s.name}</h4>
        <Sparkline values={s.trend.map((t) => t.value)} label={`${s.name} trend`} width={80} />
      </div>
      <div className="flex items-end gap-4">
        <div>
          <div className="text-ui-xs text-muted-foreground">Mean</div>
          <div className="text-ui-xl font-extrabold tabular-nums">{s.mean == null ? "–" : s.mean.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-ui-xs text-muted-foreground">Pass rate</div>
          <div className={cx("text-ui-xl font-extrabold tabular-nums", tone)}>{fmtPct(s.pass_rate, 0)}</div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-ui-xs text-muted-foreground">Samples</div>
          <div className="text-ui-md font-bold tabular-nums">{s.n.toLocaleString()}</div>
        </div>
      </div>
    </Card>
  );
}

export default function EvalsTab() {
  const { base, refreshKey } = useAsset();
  const evals = useApi<AssetEvals>(`${base}/evals`, [refreshKey]);
  if (evals.error && !evals.data) return <ErrorCard error={evals.error} onRetry={evals.reload} />;
  if (!evals.data) return <SectionSkeleton blocks={2} />;
  const e = evals.data;
  const monitoring = e.scorers.filter((s) => s.kind === "monitoring");
  const offline = e.scorers.filter((s) => s.kind === "offline");
  const scorerNames = [...new Set(e.runs.flatMap((r) => Object.keys(r.scorers)))];

  if (e.scorers.length === 0 && e.runs.length === 0)
    return (
      <EmptyState
        icon={<FlaskConical size={22} aria-hidden />}
        title="No evaluation results yet"
        description={e.note ?? "Run mlflow.genai.evaluate() against an evaluation dataset, or enable production monitoring scorers on the agent's experiment. Results appear after the next sync."}
      />
    );

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Evaluations"
        subtitle="Scorer results from MLflow: production monitoring on live traffic, and offline runs on evaluation datasets."
        actions={
          <>
            <SourcePill source={evals.source} degradedReason={evals.degradedReason} asOf={evals.asOf} />
            {e.deep_link && (
              <a href={e.deep_link} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-ui-sm font-semibold hover:bg-accent">
                Open in MLflow <ExternalLink size={12} aria-hidden />
              </a>
            )}
          </>
        }
      />
      {e.note && <Banner tone="info" title="Note">{e.note}</Banner>}
      {[
        { title: "Production monitoring", items: monitoring, empty: "No monitoring scorers are enabled on live traffic." },
        { title: "Offline evaluation", items: offline, empty: "No offline evaluation runs yet." },
      ].map((g) => (
        <section key={g.title} className="space-y-2" aria-label={g.title}>
          <h3 className="text-ui-md font-bold">{g.title}</h3>
          {g.items.length === 0 ? (
            <p className="text-ui-sm text-muted-foreground">{g.empty}</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {g.items.map((s) => (
                <ScorerCard key={`${s.kind}-${s.name}`} s={s} />
              ))}
            </div>
          )}
        </section>
      ))}
      {e.runs.length > 0 && (
        <section className="space-y-2" aria-label="Evaluation runs">
          <h3 className="text-ui-md font-bold">Runs</h3>
          <DataTable label="Evaluation runs">
            <thead>
              <tr>
                <Th>Run</Th>
                <Th>Version</Th>
                <Th>When</Th>
                {scorerNames.map((n) => (
                  <Th key={n} align="right">
                    {n}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {e.runs.map((r) => (
                <tr key={r.run_id}>
                  <Td className="font-mono text-ui-xs">{r.run_id.slice(0, 12)}</Td>
                  <Td>{r.version ?? "–"}</Td>
                  <Td className="whitespace-nowrap text-muted-foreground">{fmtDateTime(r.run_at)}</Td>
                  {scorerNames.map((n) => (
                    <Td key={n} align="right">
                      {r.scorers[n] == null ? "–" : r.scorers[n].toFixed(2)}
                    </Td>
                  ))}
                </tr>
              ))}
            </tbody>
          </DataTable>
        </section>
      )}
    </div>
  );
}

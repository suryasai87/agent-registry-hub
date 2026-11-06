// A chart inside a card with an accessible summary and a one-click "View as table" alternative (benchmark §8).
import { ChartColumn, Table } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { cx } from "../../lib/cx";
import { Button, Card, SectionTitle } from "../ui";

export interface TableColumn {
  key: string;
  label: string;
  align?: "left" | "right";
  format?: (value: unknown, row: Record<string, unknown>) => ReactNode;
}

export interface TableSpec {
  columns: TableColumn[];
  rows: Record<string, unknown>[];
}

export function DataTable({ spec, caption, className }: { spec: TableSpec; caption?: string; className?: string }) {
  return (
    <div className={cx("max-h-80 overflow-auto rounded-lg border border-border", className)}>
      <table className="w-full text-ui-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="sticky top-0 bg-muted/90 backdrop-blur">
          <tr>
            {spec.columns.map((c) => (
              <th key={c.key} scope="col" className={cx("px-3 py-2 font-semibold text-muted-foreground", c.align === "right" ? "text-right" : "text-left")}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.rows.map((row, i) => (
            <tr key={i} className="border-t border-border/70">
              {spec.columns.map((c) => (
                <td key={c.key} className={cx("px-3 py-1.5 tabular-nums", c.align === "right" ? "text-right" : "text-left")}>
                  {c.format ? c.format(row[c.key], row) : String(row[c.key] ?? "–")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ChartCard({
  title,
  subtitle,
  summary,
  table,
  actions,
  children,
  className,
  footer,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** One sentence for screen readers, e.g. "Requests rose 34% over the last 30 days". */
  summary: string;
  table?: TableSpec;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  footer?: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  const captionId = useId();
  const toggle = table ? (
    <Button
      size="sm"
      variant="ghost"
      aria-pressed={asTable}
      icon={asTable ? <ChartColumn size={13} aria-hidden /> : <Table size={13} aria-hidden />}
      onClick={() => setAsTable((v) => !v)}
    >
      {asTable ? "View as chart" : "View as table"}
    </Button>
  ) : null;
  return (
    <Card className={cx("flex flex-col", className)}>
      <SectionTitle title={title} subtitle={subtitle} actions={(actions || toggle) && <>{actions}{toggle}</>} />
      <figure aria-describedby={captionId} className="m-0 min-w-0 flex-1">
        <figcaption id={captionId} className="sr-only">{summary}</figcaption>
        {asTable && table ? <DataTable spec={table} caption={typeof title === "string" ? title : summary} /> : <div role="img" aria-label={summary}>{children}</div>}
      </figure>
      {footer && <div className="mt-3 text-ui-xs text-muted-foreground">{footer}</div>}
    </Card>
  );
}

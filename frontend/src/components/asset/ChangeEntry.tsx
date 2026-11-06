// One change in a timeline / feed: breaking flag, version, title, my acknowledgement, kinds, publisher, dates and
// acknowledgement progress; links to its impact report (/changes/<id>).
import { ArrowRight, TriangleAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { cx } from "../../lib/cx";
import type { AckStatus, ChangeSummary } from "../../lib/types";
import { Badge } from "../ui";
import { fmtDate, plural } from "./format";
import { humanize } from "./meta";

export const ACK_LABEL: Record<AckStatus, { label: string; variant: "neutral" | "success" | "warning" | "destructive" | "info" }> = {
  pending: { label: "Awaiting your acknowledgement", variant: "warning" },
  not_impacted: { label: "Not impacted", variant: "success" },
  impacted_will_migrate: { label: "Will migrate", variant: "info" },
  need_help: { label: "Needs help", variant: "destructive" },
  not_required: { label: "No action needed", variant: "neutral" },
};

export function ChangeEntry({ c, showAsset = false }: { c: ChangeSummary; showAsset?: boolean }) {
  return (
    <Link to={`/changes/${c.change_id}`} className={cx("group block rounded-xl border bg-card p-4 transition-colors hover:border-primary/40", c.breaking ? "border-destructive/35" : "border-border")}>
      <div className="flex flex-wrap items-center gap-2">
        {c.breaking && (
          <Badge variant="destructive" icon={<TriangleAlert size={11} aria-hidden />}>
            Breaking
          </Badge>
        )}
        {c.to_version && (
          <span className="font-mono text-ui-sm font-semibold">
            {c.from_version ? `${c.from_version} → ` : ""}
            {c.to_version}
          </span>
        )}
        <span className="text-ui-base font-semibold group-hover:text-primary">{c.title}</span>
        {c.my_ack && <Badge variant={ACK_LABEL[c.my_ack]?.variant ?? "neutral"}>{ACK_LABEL[c.my_ack]?.label ?? c.my_ack}</Badge>}
        <ArrowRight size={14} aria-hidden className="ml-auto text-muted-foreground group-hover:text-primary" />
      </div>
      {showAsset && <div className="mt-0.5 text-ui-sm text-muted-foreground">{c.asset_display_name}</div>}
      {c.summary && <p className="mt-1 line-clamp-2 text-ui-sm text-muted-foreground">{c.summary}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-xs text-muted-foreground">
        {c.change_kinds.map((k) => (
          <span key={k} className="rounded-full border border-border px-1.5 py-px">
            {humanize(k)}
          </span>
        ))}
        <span>{c.published_by ? `Published by ${c.published_by}` : `Detected by ${c.detected_by}`}</span>
        <span>{fmtDate(c.published_at ?? c.created_at)}</span>
        {c.effective_at && <span className={cx(c.breaking && "font-semibold text-foreground")}>Effective {fmtDate(c.effective_at)}</span>}
        <span>
          {c.acked}/{plural(c.impacted_people, "person", "people")} acknowledged
        </span>
      </div>
    </Link>
  );
}

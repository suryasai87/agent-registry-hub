// Notifications inbox (/notifications): change notices, access decisions, reminders and curation outcomes, with
// an unread filter, mark read / mark all read, and links to the change, request or asset each one is about.
import { motion } from "framer-motion";
import { ArrowRight, Bell, CheckCheck, Mail } from "lucide-react";
import { useSearchParams, Link } from "react-router-dom";
import SourcePill from "../components/SourcePill";
import { Badge, Button, Card, EmptyState, PageHeader } from "../components/ui";
import { AsyncBlock, RowsSkeleton, useWrite } from "../components/workspace/feedback";
import { fmtDateTime, fmtRelative } from "../components/workspace/format";
import { notificationHref, notificationIcon, notificationLabel } from "../components/workspace/notifications";
import { api, useApi } from "../lib/api";
import { cx } from "../lib/cx";
import { stagger, staggerItem } from "../lib/motion";
import { useSession } from "../lib/session";
import type { Notification } from "../lib/types";

export default function NotificationsPage() {
  const [params, setParams] = useSearchParams();
  const unreadOnly = params.get("unread") === "true";
  const session = useSession();
  const q = useApi<Notification[]>(`/api/notifications${unreadOnly ? "?unread=true" : ""}`);
  const { run, pending } = useWrite();
  // With an email dispatcher configured, each notice has an in-app row and an email row: show the email row only
  // when it has no in-app twin.
  const all = q.data ?? [];
  const inApp = new Set(all.filter((n) => n.channel === "in_app").map((n) => `${n.kind}|${n.ref_id}|${n.title}`));
  const rows = all.filter((n) => n.channel === "in_app" || !inApp.has(`${n.kind}|${n.ref_id}|${n.title}`)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const unread = rows.filter((n) => !n.read_at).length;

  const markRead = async (n: Notification) => {
    const ok = await run(`read:${n.notification_id}`, "Couldn't mark it read", () => api.post(`/api/notifications/${n.notification_id}/read`));
    if (ok !== undefined) {
      const now = new Date().toISOString();
      q.mutate((prev) => (unreadOnly ? (prev ?? []).filter((x) => x.notification_id !== n.notification_id) : (prev ?? []).map((x) => (x.notification_id === n.notification_id ? { ...x, read_at: now } : x))));
      session.refresh();
    }
  };
  const markAll = async () => {
    const ok = await run("all", "Couldn't mark everything read", () => api.post("/api/notifications/read-all"), "All caught up");
    if (ok !== undefined) {
      const now = new Date().toISOString();
      q.mutate((prev) => (unreadOnly ? [] : (prev ?? []).map((x) => ({ ...x, read_at: x.read_at ?? now }))));
      session.refresh();
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Bell size={20} aria-hidden />}
        title="Notifications"
        subtitle="Change notices for what you use, access decisions, reminders and curation outcomes. Email copies go to your inbox when the dispatcher is configured."
        source={<SourcePill source={q.source} degradedReason={q.degradedReason} asOf={q.asOf} />}
        actions={
          <Button variant="secondary" icon={<CheckCheck size={14} aria-hidden />} loading={pending === "all"} disabled={unread === 0} onClick={() => void markAll()}>
            Mark all read
          </Button>
        }
      />
      <div role="radiogroup" aria-label="Show" className="inline-flex rounded-lg border border-border bg-background/60 p-0.5">
        {[
          { id: false, label: "All" },
          { id: true, label: "Unread" },
        ].map((o) => (
          <button
            key={String(o.id)}
            type="button"
            role="radio"
            aria-checked={unreadOnly === o.id}
            onClick={() => setParams(o.id ? { unread: "true" } : {})}
            className={cx("rounded-md px-3 py-1 text-ui-sm font-semibold", unreadOnly === o.id ? "bg-secondary text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
            {o.label}{o.id && unread > 0 ? ` (${unread})` : ""}
          </button>
        ))}
      </div>
      <AsyncBlock
        state={q}
        skeleton={<RowsSkeleton rows={6} />}
        isEmpty={() => rows.length === 0}
        empty={<EmptyState icon={<Bell size={22} aria-hidden />} title={unreadOnly ? "No unread notifications" : "Your inbox is empty"} description="Subscribe to assets you depend on to hear about their changes; access decisions land here too." />}
      >
        {() => (
          <motion.ul variants={stagger} initial="hidden" animate="show" className="space-y-2" aria-label="Notifications">
            {rows.map((n) => {
              const Icon = notificationIcon(n.kind);
              const href = notificationHref(n);
              return (
                <motion.li key={n.notification_id} variants={staggerItem} layout="position">
                  <Card className={cx("flex items-start gap-3 !p-4", !n.read_at && "border-primary/40 bg-primary/[0.04]")}>
                    <span className={cx("grid h-9 w-9 shrink-0 place-items-center rounded-lg", n.read_at ? "bg-muted text-muted-foreground" : "bg-primary/15 text-primary")}>
                      <Icon size={17} aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={n.read_at ? "neutral" : "primary"}>{notificationLabel(n.kind)}</Badge>
                        {!n.read_at && <span className="text-ui-xs font-semibold text-primary">Unread</span>}
                        <span className="text-ui-xs text-muted-foreground" title={fmtDateTime(n.created_at)}>{fmtRelative(n.created_at)}</span>
                        {n.channel === "email" && <Badge icon={<Mail size={11} aria-hidden />}>email · {n.delivery_status}</Badge>}
                      </div>
                      <div className={cx("mt-1 text-ui-md", n.read_at ? "font-medium" : "font-bold")}>{n.title}</div>
                      {n.body && <p className="mt-0.5 whitespace-pre-wrap text-ui-sm text-muted-foreground">{n.body}</p>}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      {href && (
                        <Link to={href} onClick={() => { if (!n.read_at) void markRead(n); }} className="inline-flex items-center gap-1 text-ui-sm font-semibold text-primary hover:underline">
                          Open <ArrowRight size={13} aria-hidden />
                        </Link>
                      )}
                      {!n.read_at && (
                        <Button size="sm" variant="ghost" loading={pending === `read:${n.notification_id}`} onClick={() => void markRead(n)} aria-label={`Mark “${n.title}” read`}>
                          Mark read
                        </Button>
                      )}
                    </div>
                  </Card>
                </motion.li>
              );
            })}
          </motion.ul>
        )}
      </AsyncBlock>
    </div>
  );
}

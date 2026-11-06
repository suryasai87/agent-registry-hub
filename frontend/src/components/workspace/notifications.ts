// Notification kinds (app/registry/*: notify.queue) → icon and the page each one opens.
import {
  Bell, CircleCheck, FileClock, GitPullRequestArrow, Hourglass, Inbox, KeyRound, LifeBuoy, MailCheck, Megaphone, ShieldOff,
  TimerOff, UserCheck, type LucideIcon,
} from "lucide-react";
import { enc } from "../../lib/api";
import { assetHref } from "../../lib/assets";
import type { Notification } from "../../lib/types";

const ICONS: Record<string, LucideIcon> = {
  change_published: FileClock,
  unregistered_consumer: Megaphone,
  impact_help: LifeBuoy,
  subscription_confirmed: MailCheck,
  curation: UserCheck,
  access_request: Inbox,
  access_request_submitted: GitPullRequestArrow,
  access_request_reminder: Hourglass,
  access_request_expired: TimerOff,
  access_decision: CircleCheck,
  access_revoked: ShieldOff,
  grant_expired: KeyRound,
};

export function notificationIcon(kind: string): LucideIcon {
  return ICONS[kind] ?? Bell;
}

const LABELS: Record<string, string> = {
  change_published: "Change",
  unregistered_consumer: "You use this",
  impact_help: "Help requested",
  subscription_confirmed: "Subscription",
  curation: "Curation",
  access_request: "Access request",
  access_request_submitted: "Request submitted",
  access_request_reminder: "Reminder",
  access_request_expired: "Request expired",
  access_decision: "Access decision",
  access_revoked: "Access revoked",
  grant_expired: "Access expired",
};

export function notificationLabel(kind: string): string {
  return LABELS[kind] ?? kind.replace(/_/g, " ");
}

/** Where a notification leads: the change's impact report, the review queue, My workspace, or the asset. */
export function notificationHref(n: Pick<Notification, "kind" | "asset_id" | "ref_id">): string | null {
  const k = n.kind;
  if ((k === "change_published" || k === "unregistered_consumer" || k === "impact_help" || k.startsWith("change")) && n.ref_id) return `/changes/${enc(n.ref_id)}`;
  if (k === "access_request" || k === "access_request_reminder") return "/requests";
  if (k === "access_request_submitted" || k === "access_request_expired" || k === "access_decision") return "/me#requests";
  if (k === "access_revoked" || k === "grant_expired") return "/me#access";
  if (k === "subscription_confirmed") return n.asset_id ? assetHref(n.asset_id) : "/me#subscriptions";
  if (k === "curation") return n.asset_id ? assetHref(n.asset_id) : "/governance#curation";
  return n.asset_id ? assetHref(n.asset_id) : null;
}

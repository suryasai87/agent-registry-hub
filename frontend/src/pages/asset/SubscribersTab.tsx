// Subscribers (benchmark §4.2 + §5.2): who is registered for change notifications (email, team emails, kind,
// relationship, downstream, preference, since, last ack), my subscription (change preference / unsubscribe), and
// the "Unregistered consumers" panel with "Nudge to register". Subscribing is optimistic with rollback.
import { BellPlus, BellRing, Megaphone, TriangleAlert, UserRound } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useAsset } from "../../components/asset/AssetContext";
import { writeErrorMessage } from "../../components/asset/errors";
import { fmtDate, plural } from "../../components/asset/format";
import { humanize } from "../../components/asset/meta";
import { DataTable, ErrorCard, SectionSkeleton, Td, Th } from "../../components/asset/primitives";
import SourcePill from "../../components/SourcePill";
import { Badge, Button, Card, EmptyState, Modal, SectionTitle, Select, useToast } from "../../components/ui";
import { api, useApi } from "../../lib/api";
import { assetHref, fmtAgo } from "../../lib/assets";
import { cx } from "../../lib/cx";
import type { Subscription, UnregisteredConsumer } from "../../lib/types";

const PREF: Record<Subscription["notify_pref"], string> = { breaking_only: "Breaking only", all: "All changes", weekly_digest: "Weekly digest" };

interface SubscribersData {
  subscribers: Subscription[];
  unregistered: UnregisteredConsumer[];
}

export default function SubscribersTab() {
  const { detail, base, refreshKey, openSubscribe, email, pendingSubscriptions, patchDetail } = useAsset();
  const subs = useApi<SubscribersData>(`${base}/subscribers`, [refreshKey]);
  const [selected, setSelected] = useState<string[]>([]);
  const [nudging, setNudging] = useState(false);
  const [confirmUnsub, setConfirmUnsub] = useState<Subscription | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const p = detail.permissions;
  const isOwner = detail.asset.my.owner || p.can_publish || p.can_manage_access;

  if (subs.error && !subs.data) return <ErrorCard error={subs.error} onRetry={subs.reload} />;
  if (!subs.data) return <SectionSkeleton blocks={2} />;
  const pendingIds = new Set(pendingSubscriptions.map((s) => s.subscription_id));
  const rows = [...pendingSubscriptions, ...subs.data.subscribers.filter((s) => s.status === "active")];
  const mine = subs.data.subscribers.find((s) => s.status === "active" && s.subscriber_email.toLowerCase() === email.toLowerCase());
  const unregistered = subs.data.unregistered;

  const nudge = async (requesters: string[]) => {
    if (!requesters.length) return;
    setNudging(true);
    try {
      const res = await api.post<{ ok: boolean; notified: number }>(`${base}/nudge`, { requesters });
      toast.success("Nudge sent", `${plural(res.notified ?? requesters.length, "consumer")} asked to subscribe.`);
      setSelected([]);
    } catch (err) {
      toast.error("Nudge not sent", writeErrorMessage(err));
    } finally {
      setNudging(false);
    }
  };

  const changePref = async (sub: Subscription, notify_pref: Subscription["notify_pref"]) => {
    const before = sub.notify_pref;
    subs.mutate((d) => ({ ...(d as SubscribersData), subscribers: (d as SubscribersData).subscribers.map((s) => (s.subscription_id === sub.subscription_id ? { ...s, notify_pref } : s)) }));
    try {
      await api.patch<Subscription>(`/api/subscriptions/${sub.subscription_id}`, { notify_pref });
      toast.success("Notification preference saved", PREF[notify_pref]);
    } catch (err) {
      subs.mutate((d) => ({ ...(d as SubscribersData), subscribers: (d as SubscribersData).subscribers.map((s) => (s.subscription_id === sub.subscription_id ? { ...s, notify_pref: before } : s)) }));
      toast.error("Preference not saved", writeErrorMessage(err));
    }
  };

  const unsubscribe = async (sub: Subscription) => {
    setBusy(true);
    try {
      await subs.optimistic(
        (d) => ({ ...(d as SubscribersData), subscribers: (d as SubscribersData).subscribers.filter((s) => s.subscription_id !== sub.subscription_id) }),
        () => api.del(`/api/subscriptions/${sub.subscription_id}`),
      );
      patchDetail((d) => ({ ...d, asset: { ...d.asset, subscribers: Math.max(0, d.asset.subscribers - 1), my: { ...d.asset.my, subscribed: false } } }));
      toast.success(`Unsubscribed from ${detail.asset.display_name}`);
      setConfirmUnsub(null);
    } catch (err) {
      toast.error("Still subscribed", writeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Subscribers"
        subtitle="People, teams and agents registered (by email) for change notifications. They are the first to know about breaking changes."
        actions={
          <>
            <SourcePill source={subs.source} degradedReason={subs.degradedReason} asOf={subs.asOf} />
            {!mine && (
              <Button size="sm" icon={<BellPlus size={13} aria-hidden />} onClick={openSubscribe}>
                Subscribe
              </Button>
            )}
          </>
        }
      />

      {mine && (
        <Card className="flex flex-wrap items-center gap-3 !p-4">
          <BellRing size={18} className="text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-ui-base font-semibold">You're subscribed as {mine.subscriber_email}</div>
            <div className="text-ui-sm text-muted-foreground">
              Since {fmtDate(mine.created_at)} · {mine.relationship === "via_downstream" ? `via ${mine.downstream_name ?? mine.downstream_asset_id}` : "direct use"}
            </div>
          </div>
          <Select
            aria-label="My notification preference"
            value={mine.notify_pref}
            onValueChange={(v) => void changePref(mine, v as Subscription["notify_pref"])}
            options={Object.entries(PREF).map(([value, label]) => ({ value, label }))}
            wrapperClassName="w-48"
          />
          <Button size="sm" variant="ghost" onClick={() => setConfirmUnsub(mine)}>
            Unsubscribe
          </Button>
        </Card>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={<UserRound size={20} aria-hidden />}
          title="No subscribers yet"
          description="Nobody will be notified when this asset changes. Subscribe yourself, or nudge the consumers seen in usage below."
          action={
            <Button icon={<BellPlus size={15} aria-hidden />} onClick={openSubscribe}>
              Subscribe
            </Button>
          }
        />
      ) : (
        <DataTable label="Subscribers">
          <thead>
            <tr>
              <Th>Email</Th>
              <Th>Team emails</Th>
              <Th>Kind</Th>
              <Th>Relationship</Th>
              <Th>Downstream</Th>
              <Th>Notify</Th>
              <Th>Env</Th>
              <Th>Since</Th>
              <Th>Last ack</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const pending = pendingIds.has(s.subscription_id);
              return (
                <tr key={s.subscription_id} className={cx("hover:bg-accent/40", pending && "opacity-70")} aria-busy={pending || undefined}>
                  <Td className="font-medium">
                    {s.subscriber_email}
                    {pending && (
                      <Badge variant="info" className="ml-2">
                        Saving…
                      </Badge>
                    )}
                    {!s.has_access && !pending && (
                      <Badge variant="neutral" className="ml-2" title="Subscribed, but holds no current access: still hears about deprecations">
                        No current access
                      </Badge>
                    )}
                  </Td>
                  <Td className="max-w-[200px] truncate text-muted-foreground">{s.notify_emails.length ? s.notify_emails.join(", ") : "–"}</Td>
                  <Td>{humanize(s.subscriber_kind)}</Td>
                  <Td>{s.relationship === "via_downstream" ? "Via a downstream asset" : "Direct use"}</Td>
                  <Td>
                    {s.downstream_asset_id ? (
                      <Link to={assetHref(s.downstream_asset_id)} className="text-primary hover:underline">
                        {s.downstream_name ?? s.downstream_asset_id}
                      </Link>
                    ) : s.downstream_name ? (
                      <span>
                        {s.downstream_name} <Badge className="ml-1">not registered</Badge>
                      </span>
                    ) : (
                      "–"
                    )}
                  </Td>
                  <Td>{PREF[s.notify_pref] ?? s.notify_pref}</Td>
                  <Td>{s.environment}</Td>
                  <Td className="whitespace-nowrap text-muted-foreground">{fmtDate(s.created_at)}</Td>
                  <Td className="whitespace-nowrap text-muted-foreground">{s.last_ack_at ? fmtAgo(s.last_ack_at) : "Never"}</Td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}

      <section aria-label="Unregistered consumers">
        <Card className={cx("space-y-3", unregistered.length > 0 && "border-warning/40")}>
          <SectionTitle
            title={
              <span className="inline-flex items-center gap-2">
                {unregistered.length > 0 && <TriangleAlert size={16} className="text-warning" aria-hidden />}
                Unregistered consumers
              </span>
            }
            subtitle={unregistered.length ? `${plural(unregistered.length, "requester")} called this asset in the last 30 days without subscribing. They won't hear about breaking changes.` : "Everyone seen in usage logs is subscribed."}
            actions={
              isOwner && unregistered.length > 0 ? (
                <Button size="sm" variant="secondary" loading={nudging} icon={<Megaphone size={13} aria-hidden />} onClick={() => void nudge(selected.length ? selected : unregistered.map((u) => u.requester))}>
                  {selected.length ? `Nudge ${selected.length} to register` : "Nudge all to register"}
                </Button>
              ) : undefined
            }
          />
          {unregistered.length > 0 && (
            <DataTable label="Unregistered consumers" dense>
              <thead>
                <tr>
                  {isOwner && (
                    <Th>
                      <span className="sr-only">Select</span>
                    </Th>
                  )}
                  <Th>Requester</Th>
                  <Th>Kind</Th>
                  <Th align="right">Requests · 30 d</Th>
                  <Th>Last seen</Th>
                </tr>
              </thead>
              <tbody>
                {unregistered.map((u) => (
                  <tr key={u.requester}>
                    {isOwner && (
                      <Td>
                        <input
                          type="checkbox"
                          className="accent-primary"
                          aria-label={`Select ${u.requester}`}
                          checked={selected.includes(u.requester)}
                          onChange={(e) => setSelected((xs) => (e.target.checked ? [...xs, u.requester] : xs.filter((x) => x !== u.requester)))}
                        />
                      </Td>
                    )}
                    <Td className="font-medium">{u.requester}</Td>
                    <Td className="text-muted-foreground">{humanize(u.requester_kind)}</Td>
                    <Td align="right">{u.requests_30d.toLocaleString()}</Td>
                    <Td className="whitespace-nowrap text-muted-foreground">{fmtAgo(u.last_seen)}</Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Card>
      </section>

      <Modal
        open={!!confirmUnsub}
        onClose={() => setConfirmUnsub(null)}
        title="Unsubscribe?"
        description="You won't be notified about breaking changes or deprecations of this asset anymore."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmUnsub(null)}>
              Keep subscription
            </Button>
            <Button variant="danger" loading={busy} onClick={() => confirmUnsub && void unsubscribe(confirmUnsub)}>
              Unsubscribe
            </Button>
          </>
        }
      />
    </div>
  );
}

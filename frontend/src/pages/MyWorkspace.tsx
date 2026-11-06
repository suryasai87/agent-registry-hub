// My workspace (/me): subscriptions, access, requests, owned assets and the changes that impact me. The active
// tab lives in the URL hash (#subscriptions, #access, #requests, #owned, #impacts) so links can land on a tab.
import { Compass } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { Badge, PageHeader, Tabs, type TabItem } from "../components/ui";
import { AccessPanel, ImpactsPanel, MyRequestsPanel, OwnedPanel, SubscriptionsPanel } from "../components/workspace/WorkspacePanels";
import { useSession } from "../lib/session";

const count = (n: number | undefined, variant: "primary" | "warning" = "primary") => (n ? <Badge variant={variant}>{n}</Badge> : undefined);

export default function MyWorkspace() {
  const { me, hasRole } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const isOwner = hasRole("owner", "steward", "admin") || (me?.counts.owned ?? 0) > 0;
  const canReview = hasRole("owner", "steward", "admin");
  const tabs: TabItem[] = [
    { id: "impacts", label: "Impacts", badge: count(me?.counts.unacked_impacts, "warning") },
    { id: "subscriptions", label: "Subscriptions", badge: count(me?.counts.subscriptions) },
    { id: "access", label: "Access" },
    { id: "requests", label: "Requests", badge: count(me?.counts.my_open_requests) },
    ...(isOwner ? [{ id: "owned", label: "Owned", badge: count(me?.counts.owned) }] : []),
  ];
  const fromHash = decodeURIComponent(location.hash.slice(1));
  const active = tabs.some((t) => t.id === fromHash) ? fromHash : (me?.counts.unacked_impacts ?? 0) > 0 ? "impacts" : "subscriptions";

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Compass size={20} aria-hidden />}
        title="My workspace"
        subtitle={me ? `Everything that concerns ${me.display_name || me.email}: what you subscribe to and can use, what you've asked for, what you own, and the changes that affect you.` : "What you subscribe to and can use, what you've asked for, what you own, and the changes that affect you."}
      />
      <Tabs syncHash={false} value={active} onChange={(id) => navigate({ hash: id }, { replace: true })} tabs={tabs}>
        {(tab) =>
          tab === "subscriptions" ? <SubscriptionsPanel /> :
          tab === "access" ? <AccessPanel /> :
          tab === "requests" ? <MyRequestsPanel /> :
          tab === "owned" ? <OwnedPanel canReview={canReview} /> :
          <ImpactsPanel />
        }
      </Tabs>
    </div>
  );
}

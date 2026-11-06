// Governance (/governance): sources & sync, curation, overrides, roles, publishing lineage (and the knowledge graph) to Unity Catalog and the
// Microsoft Agent 365 registrations. Stewards and admins act; auditors see everything read-only. The tab lives in the
// URL hash (#sources, #curation, #overrides, #roles, #uc-lineage, #agent365).
import { ClipboardCheck, Eye } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { Agent365Panel } from "../components/governance/Agent365Panel";
import { CurationPanel, OverridesPanel, RolesPanel, SourcesPanel } from "../components/governance/GovernancePanels";
import { KnowledgeGraphCard } from "../components/governance/KnowledgeGraphCard";
import { UcLineagePanel } from "../components/governance/UcLineagePanel";
import ErrorBoundary from "../components/ErrorBoundary";
import { Badge, EmptyState, PageHeader, Tabs } from "../components/ui";
import { useSession } from "../lib/session";

const TABS = [
  { id: "sources", label: "Sources & sync" },
  { id: "curation", label: "Curation" },
  { id: "overrides", label: "Overrides" },
  { id: "roles", label: "Roles" },
  { id: "uc-lineage", label: "Unity Catalog lineage" },
  { id: "agent365", label: "Agent 365" },
];

export default function Governance() {
  const { hasRole, me, loading } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const steward = hasRole("steward", "admin");
  const admin = hasRole("admin");
  const auditor = hasRole("auditor");
  const fromHash = location.hash.slice(1);
  const active = TABS.some((t) => t.id === fromHash) ? fromHash : "sources";

  if (!loading && me && !steward && !auditor) {
    return (
      <div className="space-y-5">
        <PageHeader icon={<ClipboardCheck size={20} aria-hidden />} title="Governance" />
        <EmptyState title="Governance is for stewards, admins and auditors" description="Ask a registry admin if you need to curate assets, manage sources or review overrides." />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<ClipboardCheck size={20} aria-hidden />}
        title="Governance"
        subtitle="Keep the registry true: watch the collectors that sync it, curate what they discover, review every human override, and decide who governs."
        actions={!steward && auditor ? <Badge variant="info" icon={<Eye size={12} aria-hidden />}>Read-only (auditor)</Badge> : undefined}
      />
      <Tabs syncHash={false} value={active} onChange={(id) => navigate({ hash: id }, { replace: true })} tabs={TABS}>
        {(tab) =>
          tab === "curation" ? <CurationPanel canCurate={steward} /> :
          tab === "overrides" ? <OverridesPanel /> :
          tab === "roles" ? <RolesPanel canManage={admin} myEmail={me?.email ?? null} /> :
          tab === "uc-lineage" ? (
            <div className="space-y-8">
              <UcLineagePanel canPublish={admin} />
              <ErrorBoundary name="Knowledge graph (Delta)"><KnowledgeGraphCard canExport={admin} /></ErrorBoundary>
            </div>
          ) :
          tab === "agent365" ? <Agent365Panel /> :
          <SourcesPanel canSync={steward} />
        }
      </Tabs>
    </div>
  );
}

// Register an asset (/register): a custom agent or MCP server (#asset), or a skill from its SKILL.md (#skill).
// Auditors can't register (read-only role); everyone else can, and becomes the owner.
import { Eye, PlusCircle } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { AssetForm, SkillForm } from "../components/governance/RegisterForms";
import { EmptyState, PageHeader, Tabs } from "../components/ui";
import { useSession } from "../lib/session";

export default function Register() {
  const { hasRole } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const readOnly = hasRole("auditor") && !hasRole("steward", "admin", "owner", "consumer");
  const active = location.hash === "#skill" ? "skill" : "asset";
  return (
    <div className="space-y-5">
      <PageHeader
        icon={<PlusCircle size={20} aria-hidden />}
        title="Register an asset"
        subtitle="Add something the collectors can't discover on their own: a custom agent, an MCP server hosted elsewhere, or an Agent Skill from its SKILL.md. You become its owner; a steward approves it into the catalog."
      />
      {readOnly ? (
        <EmptyState icon={<Eye size={22} aria-hidden />} title="Auditors can't register assets" description="The auditor role reads everything and changes nothing. Exit the preview or ask an admin for another role." />
      ) : (
        <Tabs
          syncHash={false}
          value={active}
          onChange={(id) => navigate({ hash: id === "skill" ? "skill" : "" }, { replace: true })}
          tabs={[
            { id: "asset", label: "Agent or MCP server" },
            { id: "skill", label: "Skill (SKILL.md)" },
          ]}
        >
          {(tab) => (tab === "skill" ? <SkillForm /> : <AssetForm />)}
        </Tabs>
      )}
    </div>
  );
}

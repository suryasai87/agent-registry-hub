// Request access (benchmark §5.1): for me / a service principal / a group; privilege from the asset's settings;
// an optional tool subset for MCP servers; a justification (≥ 15 chars, with templates); a duration capped at
// the asset's maximum; the owner's terms; and "Subscribe me to change notifications" ON by default with the
// session email prefilled. Shows who approves and the SLA.
import { ExternalLink, KeyRound } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, useApi } from "../../lib/api";
import { assetApi } from "../../lib/assets";
import type { AccessRequest, AccessSettings, AssetAccess, AssetCard, AssetType } from "../../lib/types";
import { Avatar, Badge, Button, Input, Modal, Select, Skeleton, TextArea, Toggle, useToast } from "../ui";
import { SideEffectBadge } from "./badges";
import { writeErrorMessage } from "./errors";
import { isEmail, plural } from "./format";
import { humanize, sideEffectOf } from "./meta";
import { Banner, ErrorCard } from "./primitives";

export const MIN_JUSTIFICATION = 15;

export interface AccessRequestBody {
  principal?: string;
  principal_type?: "user" | "service_principal" | "group";
  privilege: string;
  tool_subset?: string[];
  justification: string;
  duration_days: number;
  terms_accepted: boolean;
  subscribe_email?: string | null;
}

const TEMPLATES = [
  "Building the <agent name> agent for <use case>; it calls this asset to <what it does>.",
  "Evaluating this asset in a development environment for <project> before a production rollout.",
  "Production use by <team> for <business process>; data handled: <sensitivity>.",
];

type ToolRow = AssetCard & { attributes?: Record<string, unknown> };

/** Settings as served: the contract's AccessSettings plus the backend's provisioning hints. */
export type AccessSettingsExt = AccessSettings & { default_privilege?: string | null; target_note?: string | null; provisioning_mode?: string | null };

export default function RequestAccessDialog({
  open,
  onClose,
  asset,
  settings: givenSettings,
  tools: givenTools,
  defaultEmail = "",
  onSubmitted,
}: {
  open: boolean;
  onClose: () => void;
  asset: { asset_id: string; display_name: string; asset_type: AssetType };
  /** The asset's access settings; fetched from GET …/access when not supplied (e.g. from a catalog card). */
  settings?: AccessSettings | null;
  /** The MCP server's tools for the subset picker; fetched from GET …/tools when not supplied. */
  tools?: ToolRow[] | null;
  defaultEmail?: string;
  onSubmitted?: (request: AccessRequest) => void;
}) {
  const base = assetApi(asset.asset_id);
  const fetched = useApi<AssetAccess>(open && !givenSettings ? `${base}/access` : null);
  const isMcp = asset.asset_type === "mcp_server";
  const fetchedTools = useApi<ToolRow[]>(open && isMcp && !givenTools ? `${base}/tools` : null);
  const settings = givenSettings ?? fetched.data?.settings ?? null;
  const tools = useMemo(() => (givenTools ?? fetchedTools.data ?? []).filter((t) => t.asset_type === "tool"), [givenTools, fetchedTools.data]);
  const toast = useToast();

  const [forWho, setForWho] = useState<"user" | "service_principal" | "group">("user");
  const [principal, setPrincipal] = useState("");
  const [privilege, setPrivilege] = useState("");
  const [allTools, setAllTools] = useState(true);
  const [subset, setSubset] = useState<string[]>([]);
  const [justification, setJustification] = useState("");
  const [duration, setDuration] = useState("");
  const [terms, setTerms] = useState(false);
  const [subscribe, setSubscribe] = useState(true);
  const [email, setEmail] = useState(defaultEmail);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForWho("user");
    setPrincipal("");
    setAllTools(true);
    setSubset([]);
    setJustification("");
    setTerms(false);
    setSubscribe(true);
    setEmail(defaultEmail);
    setTried(false);
    setServerError(null);
  }, [open, defaultEmail, asset.asset_id]);

  useEffect(() => {
    if (!settings) return;
    const preferred = (settings as AccessSettingsExt).default_privilege;
    setPrivilege((p) => (p && settings.privileges.includes(p) ? p : preferred && settings.privileges.includes(preferred) ? preferred : settings.privileges[0] ?? ""));
    setDuration(String(Math.min(settings.default_duration_days || 30, settings.max_duration_days || 365)));
  }, [settings]);

  const maxDays = settings?.max_duration_days ?? 365;
  const days = Number(duration);
  const errors = {
    principal: forWho !== "user" && !principal.trim() ? (forWho === "group" ? "Enter the group name." : "Enter the service principal's application ID.") : null,
    privilege: !privilege ? "Choose an access level." : null,
    justification:
      justification.trim().length < MIN_JUSTIFICATION
        ? `Explain why you need access (at least ${MIN_JUSTIFICATION} characters; ${justification.trim().length} so far).`
        : null,
    duration: !Number.isInteger(days) || days < 1 ? "Enter a whole number of days." : days > maxDays ? `The maximum for this asset is ${maxDays} days.` : null,
    terms: settings?.terms_text && !terms ? "Accept the terms to continue." : null,
    tools: isMcp && !allTools && subset.length === 0 ? "Pick at least one tool, or request all tools." : null,
    email: subscribe && !isEmail(email) ? "Enter a valid email for change notifications." : null,
  };
  const valid = Object.values(errors).every((e) => !e);
  const external = settings?.managed_externally_url ?? null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!valid || !settings) return;
    const body: AccessRequestBody = {
      privilege,
      justification: justification.trim(),
      duration_days: days,
      terms_accepted: !!settings.terms_text && terms,
      subscribe_email: subscribe ? email.trim() : null,
      principal_type: forWho,
      ...(forWho !== "user" ? { principal: principal.trim() } : {}),
      ...(isMcp && !allTools ? { tool_subset: subset } : {}),
    };
    setBusy(true);
    setServerError(null);
    try {
      const req = await api.post<AccessRequest>(`${base}/access-requests`, body);
      const granted = req.status === "provisioned" || req.status === "approved";
      toast.success(granted ? "Access granted" : "Access request submitted", granted ? `${asset.display_name}: ${req.privilege}` : `Approvers: ${req.approvers.join(", ") || "the asset owners"}. You'll be notified of the decision.`);
      onSubmitted?.(req);
      onClose();
    } catch (err) {
      const msg = writeErrorMessage(err);
      setServerError(msg);
      toast.error("Request not submitted", msg);
    } finally {
      setBusy(false);
    }
  };

  const formId = `request-${asset.asset_id}`;
  const loadingSettings = !settings && (fetched.loading || (!fetched.error && open));
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={`Request access to ${asset.display_name}`}
      description="Your request goes to the asset's approvers. Every step is audited."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={busy} disabled={!settings || !!external} icon={<KeyRound size={15} aria-hidden />}>
            Submit request
          </Button>
        </>
      }
    >
      {fetched.error && !settings ? (
        <ErrorCard error={fetched.error} onRetry={fetched.reload} title="Couldn't load this asset's access settings" />
      ) : loadingSettings ? (
        <div aria-busy="true" aria-label="Loading access settings" className="space-y-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-9 w-1/2" />
        </div>
      ) : settings ? (
        <form id={formId} noValidate onSubmit={submit} className="space-y-4">
          {external && (
            <Banner
              tone="info"
              title="Access is managed externally"
              actions={
                <a href={external} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-ui-sm font-semibold text-primary-foreground hover:brightness-110">
                  Open request page <ExternalLink size={13} aria-hidden />
                </a>
              }
            >
              The owner grants access for this asset in another system. Request it there.
            </Banner>
          )}

          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-muted/30 px-3 py-2.5 text-ui-sm">
            <span className="text-muted-foreground">{settings.approval_required ? `Approved by ${settings.approver_mode === "all" ? "all of" : "any of"}` : "Granted automatically: no approval required"}</span>
            {settings.approval_required && (
              <span className="flex flex-wrap items-center gap-1.5">
                {settings.approvers.length ? (
                  settings.approvers.map((a) => (
                    <span key={a} className="inline-flex items-center gap-1 rounded-full border border-border bg-card py-0.5 pl-0.5 pr-2">
                      <Avatar email={a} size={18} />
                      <span className="text-ui-xs font-medium">{a}</span>
                    </span>
                  ))
                ) : (
                  <span className="font-medium">the asset owners</span>
                )}
              </span>
            )}
            {settings.approval_required && <Badge variant="info">SLA {plural(settings.sla_hours, "hour")}</Badge>}
          </div>

          <fieldset className="space-y-2">
            <legend className="text-ui-sm font-semibold">Request access for</legend>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  { v: "user", label: "Me" },
                  { v: "service_principal", label: "A service principal" },
                  { v: "group", label: "A group" },
                ] as const
              ).map((o) => (
                <label key={o.v} className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-ui-base hover:border-primary/40">
                  <input type="radio" name={`${formId}-for`} className="accent-primary" checked={forWho === o.v} onChange={() => setForWho(o.v)} />
                  {o.label}
                </label>
              ))}
            </div>
            {forWho !== "user" && (
              <Input
                label={forWho === "group" ? "Group name" : "Service principal application ID"}
                placeholder={forWho === "group" ? "e.g. data-science-team" : "e.g. 6f1c…-…"}
                value={principal}
                onChange={(e) => setPrincipal(e.target.value)}
                error={tried ? errors.principal : null}
              />
            )}
          </fieldset>

          <Select
            label="Access level"
            value={privilege}
            onValueChange={setPrivilege}
            options={settings.privileges.map((p) => ({ value: p, label: /[a-z]/.test(p) ? humanize(p) : p }))}
            placeholder={settings.privileges.length ? undefined : "No privileges are requestable"}
            error={tried ? errors.privilege : null}
          />

          {isMcp && (
            <fieldset className="space-y-2">
              <legend className="text-ui-sm font-semibold">Tools</legend>
              <Toggle checked={allTools} onChange={setAllTools} label="All enabled tools" description="Turn off to request a subset; write and destructive tools are flagged." />
              {!allTools && (
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                  {fetchedTools.loading && <Skeleton className="h-6 w-full" />}
                  {tools.length === 0 && !fetchedTools.loading && <p className="text-ui-xs text-muted-foreground">This server has no registered tools yet.</p>}
                  {tools.map((t) => {
                    const checked = subset.includes(t.name);
                    return (
                      <label key={t.asset_id} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-ui-sm hover:bg-accent">
                        <input type="checkbox" className="accent-primary" checked={checked} onChange={(e) => setSubset((s) => (e.target.checked ? [...s, t.name] : s.filter((n) => n !== t.name)))} />
                        <span className="min-w-0 flex-1 truncate font-mono">{t.name}</span>
                        <SideEffectBadge effect={sideEffectOf(t.attributes)} />
                      </label>
                    );
                  })}
                </div>
              )}
              {tried && errors.tools && <p role="alert" className="text-ui-xs font-medium text-destructive">{errors.tools}</p>}
            </fieldset>
          )}

          <div className="space-y-1.5">
            <TextArea
              label="Justification"
              rows={3}
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              error={tried ? errors.justification : null}
              hint={`At least ${MIN_JUSTIFICATION} characters. Approvers see this.`}
            />
            <div className="flex flex-wrap gap-1.5" aria-label="Justification templates">
              {TEMPLATES.map((t, i) => (
                <button key={i} type="button" onClick={() => setJustification(t)} className="rounded-full border border-border px-2 py-0.5 text-ui-xs text-muted-foreground hover:border-primary/40 hover:text-foreground">
                  Template {i + 1}
                </button>
              ))}
            </div>
          </div>

          <div className="grid items-start gap-3 sm:grid-cols-[160px_1fr]">
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={maxDays}
              label="Duration (days)"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              error={tried ? errors.duration : null}
              hint={`Maximum ${maxDays}`}
            />
            <div className="flex flex-wrap gap-1.5 pt-7" aria-label="Duration presets">
              {[30, 90, 180]
                .filter((d) => d <= maxDays)
                .map((d) => (
                  <button key={d} type="button" aria-pressed={days === d} onClick={() => setDuration(String(d))} className="rounded-full border border-border px-2.5 py-0.5 text-ui-sm aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary">
                    {d} days
                  </button>
                ))}
            </div>
          </div>

          {settings.terms_text && (
            <div className="space-y-2 rounded-xl border border-border p-3">
              <div className="text-ui-sm font-semibold">Terms of use</div>
              <p className="max-h-28 overflow-y-auto whitespace-pre-wrap text-ui-sm text-muted-foreground">{settings.terms_text}</p>
              <label className="flex items-center gap-2 text-ui-sm">
                <input type="checkbox" className="accent-primary" checked={terms} onChange={(e) => setTerms(e.target.checked)} />I accept these terms
              </label>
              {tried && errors.terms && <p role="alert" className="text-ui-xs font-medium text-destructive">{errors.terms}</p>}
            </div>
          )}

          <div className="space-y-2 rounded-xl border border-primary/25 bg-primary/5 p-3">
            <Toggle checked={subscribe} onChange={setSubscribe} label="Subscribe me to change notifications" description="Recommended: you'll hear about breaking changes before they land." />
            {subscribe && (
              <Input type="email" label="Notification email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={tried ? errors.email : null} />
            )}
          </div>

          {serverError && (
            <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
              {serverError}
            </p>
          )}
        </form>
      ) : null}
    </Modal>
  );
}

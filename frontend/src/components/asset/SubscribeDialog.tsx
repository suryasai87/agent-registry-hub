// Subscribe with email (benchmark §5.2): an email is REQUIRED (prefilled from SSO, validated), optional team/DL
// emails, the subscriber kind, and how the asset is used: directly, or through a downstream agent/app (picked
// from the catalog or named as "not registered yet"), which becomes a declared lineage edge.
import { BellRing, CircleAlert } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { assetApi } from "../../lib/assets";
import type { AssetType, Subscription } from "../../lib/types";
import { Button, Input, Modal, Select } from "../ui";
import AssetPicker, { type PickedAsset } from "./AssetPicker";
import { writeErrorMessage } from "./errors";
import { isEmail, splitList } from "./format";

export interface SubscribeBody {
  subscriber_email: string;
  notify_emails?: string[];
  subscriber_kind?: Subscription["subscriber_kind"];
  relationship?: Subscription["relationship"];
  downstream_asset_id?: string | null;
  downstream_name?: string | null;
  use_case?: string | null;
  environment?: Subscription["environment"];
  notify_pref?: Subscription["notify_pref"];
}

export function postSubscription(assetId: string, body: SubscribeBody): Promise<Subscription> {
  return api.post<Subscription>(`${assetApi(assetId)}/subscriptions`, body);
}

const KINDS: { value: Subscription["subscriber_kind"]; label: string }[] = [
  { value: "user", label: "Me (a person)" },
  { value: "team", label: "A team / distribution list" },
  { value: "service_principal", label: "A service principal" },
  { value: "agent", label: "An agent" },
  { value: "app", label: "An app" },
];

const PREFS: { value: Subscription["notify_pref"]; label: string; hint: string }[] = [
  { value: "breaking_only", label: "Breaking changes only", hint: "Breaking changes and deprecations" },
  { value: "all", label: "All published changes", hint: "Every version, policy and owner change" },
  { value: "weekly_digest", label: "Weekly digest", hint: "One summary email a week (breaking changes still arrive immediately)" },
];

export default function SubscribeDialog({
  open,
  onClose,
  asset,
  defaultEmail = "",
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  asset: { asset_id: string; display_name: string; asset_type?: AssetType };
  defaultEmail?: string;
  /** Runs the subscribe (the caller applies the optimistic update and rolls back on rejection). */
  onSubmit: (body: SubscribeBody) => Promise<unknown>;
}) {
  const [email, setEmail] = useState(defaultEmail);
  const [teamEmails, setTeamEmails] = useState("");
  const [kind, setKind] = useState<Subscription["subscriber_kind"]>("user");
  const [relationship, setRelationship] = useState<Subscription["relationship"]>("direct_use");
  const [downstream, setDownstream] = useState<PickedAsset | null>(null);
  const [unregistered, setUnregistered] = useState(false);
  const [downstreamName, setDownstreamName] = useState("");
  const [useCase, setUseCase] = useState("");
  const [environment, setEnvironment] = useState<Subscription["environment"]>("prod");
  const [pref, setPref] = useState<Subscription["notify_pref"]>("breaking_only");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEmail(defaultEmail);
    setTeamEmails("");
    setKind("user");
    setRelationship("direct_use");
    setDownstream(null);
    setUnregistered(false);
    setDownstreamName("");
    setUseCase("");
    setEnvironment("prod");
    setPref("breaking_only");
    setTried(false);
    setServerError(null);
  }, [open, defaultEmail, asset.asset_id]);

  const teamList = splitList(teamEmails);
  const badTeam = teamList.filter((e) => !isEmail(e));
  const errors = {
    email: !email.trim() ? "An email is required: change notifications go here." : !isEmail(email) ? "Enter a valid email address." : null,
    team: badTeam.length ? `Not a valid email: ${badTeam.join(", ")}` : null,
    downstream:
      relationship === "via_downstream" && !(unregistered ? downstreamName.trim() : downstream)
        ? unregistered
          ? "Name the agent or app that uses this asset."
          : "Pick the agent or app that uses this asset, or choose “Not registered yet”."
        : null,
  };
  const valid = !errors.email && !errors.team && !errors.downstream;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!valid) return;
    const body: SubscribeBody = {
      subscriber_email: email.trim(),
      notify_emails: teamList,
      subscriber_kind: kind,
      relationship,
      downstream_asset_id: relationship === "via_downstream" && !unregistered ? downstream?.asset_id ?? null : null,
      downstream_name: relationship === "via_downstream" ? (unregistered ? downstreamName.trim() : downstream?.display_name ?? null) : null,
      use_case: useCase.trim() || null,
      environment,
      notify_pref: pref,
    };
    setBusy(true);
    setServerError(null);
    try {
      await onSubmit(body);
      onClose();
    } catch (err) {
      setServerError(writeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const formId = `subscribe-${asset.asset_id}`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={`Subscribe to ${asset.display_name}`}
      description="Get an email before changes that could affect you, and acknowledge them in one click."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={busy} icon={<BellRing size={15} aria-hidden />}>
            Subscribe
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="space-y-4">
        <Input
          data-autofocus
          type="email"
          label="Your email (required)"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={tried ? errors.email : null}
          hint="Prefilled from your sign-in. Change notifications and acknowledgement links go here."
        />
        <Input
          label="Team or distribution-list emails (optional)"
          placeholder="ml-platform@company.com, oncall@company.com"
          value={teamEmails}
          onChange={(e) => setTeamEmails(e.target.value)}
          error={tried ? errors.team : null}
          hint="Comma-separated. These addresses get the same notifications."
        />
        <Select label="Who is subscribing" value={kind} onValueChange={(v) => setKind(v as Subscription["subscriber_kind"])} options={KINDS} />

        <fieldset className="space-y-2">
          <legend className="text-ui-sm font-semibold">How is it used?</legend>
          {(
            [
              { v: "direct_use", label: "I use it directly", hint: "From a notebook, IDE, chat client or script" },
              { v: "via_downstream", label: "My agent / app uses it", hint: "Declares a lineage edge from your asset to this one" },
            ] as const
          ).map((o) => (
            <label key={o.v} className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2 hover:border-primary/40">
              <input type="radio" name={`${formId}-rel`} className="mt-1 accent-primary" checked={relationship === o.v} onChange={() => setRelationship(o.v)} />
              <span>
                <span className="block text-ui-base font-medium">{o.label}</span>
                <span className="block text-ui-xs text-muted-foreground">{o.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {relationship === "via_downstream" && (
          <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-3">
            {!unregistered && <AssetPicker value={downstream} onChange={setDownstream} excludeId={asset.asset_id} label="Which agent or app?" />}
            <label className="flex items-center gap-2 text-ui-sm">
              <input type="checkbox" className="accent-primary" checked={unregistered} onChange={(e) => setUnregistered(e.target.checked)} />
              Not registered yet: I'll name it
            </label>
            {unregistered && (
              <Input label="Agent or app name" placeholder="e.g. claims-triage-agent (staging)" value={downstreamName} onChange={(e) => setDownstreamName(e.target.value)} />
            )}
            {tried && errors.downstream && (
              <p role="alert" className="flex items-center gap-1.5 text-ui-xs font-medium text-destructive">
                <CircleAlert size={12} aria-hidden />
                {errors.downstream}
              </p>
            )}
          </div>
        )}

        <Input label="Use case (optional)" placeholder="What do you use it for?" value={useCase} onChange={(e) => setUseCase(e.target.value)} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="Environment"
            value={environment}
            onValueChange={(v) => setEnvironment(v as Subscription["environment"])}
            options={[
              { value: "prod", label: "Production" },
              { value: "staging", label: "Staging" },
              { value: "dev", label: "Development" },
            ]}
          />
          <Select label="Notify me about" value={pref} onValueChange={(v) => setPref(v as Subscription["notify_pref"])} options={PREFS} hint={PREFS.find((p) => p.value === pref)?.hint} />
        </div>
        {serverError && (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
            {serverError}
          </p>
        )}
      </form>
    </Modal>
  );
}

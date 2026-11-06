// Registration forms: (a) a custom agent or MCP server → POST /api/assets (lands as pending approval, you own it);
// (b) a skill from SKILL.md → POST /api/skills, with a live, spec-checked preview of the frontmatter.
import { CircleCheck, CircleX, FileUp, Send, TriangleAlert } from "lucide-react";
import { useId, useMemo, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { assetHref } from "../../lib/assets";
import { cx } from "../../lib/cx";
import type { AssetCard, Sensitivity } from "../../lib/types";
import { Badge, Button, Card, ENTITY_TYPES, Input, SectionTitle, Select, TextArea } from "../ui";
import { useWrite } from "../workspace/feedback";
import { COMPATIBILITY_MAX, DESCRIPTION_MAX, NAME_MAX, parseSkillMd, type Issue, type YamlValue } from "./skillmd";

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

export function parseTags(raw: string): string[] {
  return [...new Set(raw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 10);
}

const PLATFORMS: Record<"agent" | "mcp_server", { value: string; label: string }[]> = {
  agent: [
    { value: "model_serving", label: "Model Serving endpoint" },
    { value: "databricks_apps", label: "Databricks App" },
    { value: "agent_bricks", label: "Agent Bricks" },
    { value: "external", label: "External (outside Databricks)" },
    { value: "other", label: "Other…" },
  ],
  mcp_server: [
    { value: "databricks_apps", label: "Databricks App (custom MCP)" },
    { value: "uc_connection", label: "External, through a UC connection" },
    { value: "external", label: "External (hosted elsewhere)" },
    { value: "other", label: "Other…" },
  ],
};

const SENSITIVITY: { value: Sensitivity; label: string }[] = [
  { value: "public", label: "Public" },
  { value: "internal", label: "Internal" },
  { value: "confidential", label: "Confidential" },
  { value: "restricted", label: "Restricted" },
];

export interface AssetBody {
  asset_type: "agent" | "mcp_server";
  display_name: string;
  name: string;
  platform: string;
  publisher?: string;
  endpoint_url?: string;
  purpose: string;
  description?: string;
  tags?: string[];
  sensitivity?: Sensitivity;
}

export function AssetForm() {
  const navigate = useNavigate();
  const { run, pending } = useWrite();
  const group = useId();
  const [type, setType] = useState<"agent" | "mcp_server">("agent");
  const [display, setDisplay] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [platform, setPlatform] = useState("model_serving");
  const [otherPlatform, setOtherPlatform] = useState("");
  const [publisher, setPublisher] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [purpose, setPurpose] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [sensitivity, setSensitivity] = useState<Sensitivity>("internal");
  const [submitted, setSubmitted] = useState(false);

  const slug = nameTouched ? name : slugify(display);
  const urlOk = !endpoint.trim() || /^https?:\/\/\S+$/i.test(endpoint.trim());
  const errs = {
    display: display.trim().length < 3 ? "At least 3 characters" : undefined,
    name: !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) ? "Lowercase letters, digits and hyphens (max 64)" : undefined,
    purpose: !purpose.trim() ? "Required: one line on what it does" : purpose.length > 140 ? `${purpose.length}/140 characters` : undefined,
    endpoint: urlOk ? undefined : "Must be an http(s) URL",
    platform: platform === "other" && !otherPlatform.trim() ? "Name the platform" : undefined,
  };
  const invalid = Object.values(errs).some(Boolean);

  const submit = async () => {
    setSubmitted(true);
    if (invalid) return;
    const body: AssetBody = {
      asset_type: type, display_name: display.trim(), name: slug, platform: platform === "other" ? otherPlatform.trim() : platform, purpose: purpose.trim(), sensitivity,
    };
    if (publisher.trim()) body.publisher = publisher.trim();
    if (endpoint.trim()) body.endpoint_url = endpoint.trim();
    if (description.trim()) body.description = description.trim();
    const t = parseTags(tags);
    if (t.length) body.tags = t;
    const card = await run("asset", "Couldn't register it", () => api.post<AssetCard>("/api/assets", body), (c) => `Registered ${c.display_name}: pending steward approval`);
    if (card) navigate(assetHref(card.asset_id));
  };

  const show = (k: keyof typeof errs) => (submitted ? errs[k] : undefined);

  return (
    <form
      className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
    >
      <Card className="space-y-4">
        <fieldset>
          <legend className="mb-2 text-ui-sm font-semibold">What are you registering?</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(["agent", "mcp_server"] as const).map((t) => {
              const meta = ENTITY_TYPES[t === "agent" ? "agent" : "mcp"];
              const Icon = meta.icon;
              return (
                <label key={t} className={cx("flex cursor-pointer items-center gap-3 rounded-lg border p-3", type === t ? "border-primary/60 bg-primary/8" : "border-border hover:border-primary/30")}>
                  <input
                    type="radio"
                    name={group}
                    checked={type === t}
                    onChange={() => {
                      setType(t);
                      setPlatform(PLATFORMS[t][0].value);
                    }}
                    className="accent-[hsl(var(--primary))]"
                  />
                  <Icon size={18} aria-hidden className={t === "agent" ? "text-type-agent" : "text-type-mcp"} />
                  <span>
                    <span className="block text-ui-base font-semibold">{t === "agent" ? "Custom agent" : "MCP server"}</span>
                    <span className="block text-ui-xs text-muted-foreground">{t === "agent" ? "An LLM app that plans and calls tools" : "A server that exposes tools over MCP"}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Display name" required value={display} onChange={(e) => setDisplay(e.target.value)} error={show("display")} placeholder={type === "agent" ? "Claims Triage Agent" : "Jira MCP"} />
          <Input
            label="Name (id)"
            required
            value={slug}
            onChange={(e) => {
              setNameTouched(true);
              setName(e.target.value);
            }}
            error={show("name")}
            hint="Used in the registry id; derived from the display name"
            className="font-mono"
          />
          <Select label="Platform" value={platform} onValueChange={setPlatform} options={PLATFORMS[type]} />
          {platform === "other" ? (
            <Input label="Platform name" required value={otherPlatform} onChange={(e) => setOtherPlatform(e.target.value)} error={show("platform")} />
          ) : (
            <Input label="Publisher (optional)" value={publisher} onChange={(e) => setPublisher(e.target.value)} placeholder="Team or vendor" />
          )}
          {platform === "other" && <Input label="Publisher (optional)" value={publisher} onChange={(e) => setPublisher(e.target.value)} placeholder="Team or vendor" />}
          <Input label={type === "agent" ? "Endpoint URL (optional)" : "MCP URL (optional)"} type="url" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} error={show("endpoint")} placeholder="https://…" wrapperClassName={platform === "other" ? undefined : "sm:col-span-2"} />
        </div>
        <Input
          label="Purpose"
          required
          maxLength={140}
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          error={show("purpose")}
          hint={`${purpose.length}/140 · shown on cards and in search`}
        />
        <TextArea label="Description (optional, Markdown)" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Who it's for, inputs and outputs, limitations, support channel…" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Tags (comma separated)" value={tags} onChange={(e) => setTags(e.target.value)} hint={parseTags(tags).length ? parseTags(tags).join(" · ") : "Up to 10"} />
          <Select label="Data sensitivity" value={sensitivity} onValueChange={(v) => setSensitivity(v as Sensitivity)} options={SENSITIVITY} />
        </div>
      </Card>
      <div className="space-y-4">
        <Card className="space-y-2 text-ui-sm">
          <SectionTitle title="What happens next" />
          <ol className="list-decimal space-y-1.5 pl-4 text-muted-foreground">
            <li>It's added as <b className="text-foreground">Pending approval</b>, with you as owner.</li>
            <li>A steward reviews it in Governance → Curation, and approves or rejects it with a reason.</li>
            <li>Once approved it's in the catalog: people can request access, subscribe and see lineage.</li>
          </ol>
        </Card>
        <Button type="submit" size="lg" className="w-full" icon={<Send size={15} aria-hidden />} loading={pending === "asset"} disabled={submitted && invalid}>
          Register {type === "agent" ? "agent" : "MCP server"}
        </Button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------------------------------------ skill
const SAMPLE = `---
name: cohort-builder
description: Builds patient cohorts from the clinical lakehouse. Use when someone asks for a cohort, inclusion/exclusion criteria, or a cohort size estimate.
license: Apache-2.0
allowed-tools: Read Bash(databricks:*)
metadata:
  author: care-ops
  version: "1.0"
---

# Cohort builder

1. Clarify inclusion and exclusion criteria.
2. Draft the SQL against the governed tables.
`;

function FieldRow({ label, value, issues, counter }: { label: string; value: YamlValue | undefined; issues: Issue[]; counter?: string }) {
  const isErr = issues.some((i) => i.field === label);
  const shown = value === undefined ? <span className="text-muted-foreground">–</span> : typeof value === "string" ? value : Array.isArray(value) ? value.join(", ") : Object.entries(value).map(([k, v]) => `${k}: ${v}`).join(" · ");
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-2 border-t border-border/70 py-2 first:border-0">
      <dt className="font-mono text-ui-xs font-semibold text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-ui-sm">
        <div className={cx("break-words", isErr && "text-destructive")}>{shown}</div>
        {counter && <div className="text-ui-xs text-muted-foreground">{counter}</div>}
      </dd>
    </div>
  );
}

export function SkillForm() {
  const navigate = useNavigate();
  const { run, pending } = useWrite();
  const [md, setMd] = useState("");
  const [tags, setTags] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const parsed = useMemo(() => (md.trim() ? parseSkillMd(md) : null), [md]);
  const fm = parsed?.frontmatter ?? {};
  const str = (v: YamlValue | undefined) => (typeof v === "string" ? v : "");

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    setMd(await f.text());
    e.target.value = "";
  };

  const submit = async () => {
    if (!parsed?.valid) return;
    const t = parseTags(tags);
    const card = await run("skill", "Couldn't register the skill", () => api.post<AssetCard>("/api/skills", t.length ? { skill_md: md, tags: t } : { skill_md: md }), (c) => `Registered skill ${c.display_name}: pending steward approval`);
    if (card) navigate(assetHref(card.asset_id));
  };

  const errors = parsed?.errors ?? [];
  const warnings = parsed?.warnings ?? [];
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card className="space-y-3">
        <SectionTitle
          title="SKILL.md"
          subtitle="Paste the file or upload it. The frontmatter is checked against the Agent Skills spec as you type."
          actions={
            <>
              <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-secondary px-2.5 text-ui-sm font-semibold hover:border-primary/40 focus-within:outline-2 focus-within:outline-[hsl(var(--ring))]">
                <FileUp size={13} aria-hidden /> Upload
                <input type="file" accept=".md,text/markdown,text/plain" onChange={(e) => void onFile(e)} className="sr-only" aria-label="Upload SKILL.md" />
              </label>
              {!md && <Button size="sm" variant="ghost" onClick={() => setMd(SAMPLE)}>Insert example</Button>}
            </>
          }
        />
        {fileName && <p className="text-ui-xs text-muted-foreground">Loaded {fileName}</p>}
        <TextArea aria-label="SKILL.md content" rows={22} value={md} onChange={(e) => setMd(e.target.value)} spellCheck={false} placeholder={"---\nname: my-skill\ndescription: What it does and when to use it.\n---\n\n# Instructions…"} className="font-mono text-ui-sm" />
        <Input label="Tags (comma separated, optional)" value={tags} onChange={(e) => setTags(e.target.value)} />
      </Card>
      <div className="space-y-4">
        <Card aria-live="polite">
          <SectionTitle
            title="Preview"
            subtitle="Parsed frontmatter"
            actions={parsed ? parsed.valid ? <Badge variant="success" icon={<CircleCheck size={11} aria-hidden />}>Valid</Badge> : <Badge variant="destructive" icon={<CircleX size={11} aria-hidden />}>{errors.length} {errors.length === 1 ? "problem" : "problems"}</Badge> : undefined}
          />
          {!parsed ? (
            <p className="py-6 text-center text-ui-sm text-muted-foreground">Paste or upload a SKILL.md to preview it.</p>
          ) : (
            <>
              <dl>
                <FieldRow label="name" value={fm.name} issues={errors} counter={`${str(fm.name).length}/${NAME_MAX}`} />
                <FieldRow label="description" value={fm.description} issues={errors} counter={`${str(fm.description).length}/${DESCRIPTION_MAX}`} />
                <FieldRow label="license" value={fm.license} issues={errors} />
                {fm.compatibility !== undefined && <FieldRow label="compatibility" value={fm.compatibility} issues={errors} counter={`${str(fm.compatibility).length}/${COMPATIBILITY_MAX}`} />}
                <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-2 border-t border-border/70 py-2">
                  <dt className="font-mono text-ui-xs font-semibold text-muted-foreground">allowed-tools</dt>
                  <dd className="flex flex-wrap gap-1">{parsed.tools.length ? parsed.tools.map((t) => <Badge key={t} className="font-mono">{t}</Badge>) : <span className="text-ui-sm text-muted-foreground">–</span>}</dd>
                </div>
                {fm.metadata !== undefined && <FieldRow label="metadata" value={fm.metadata} issues={errors} />}
                <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-2 border-t border-border/70 py-2">
                  <dt className="font-mono text-ui-xs font-semibold text-muted-foreground">body</dt>
                  <dd className="text-ui-sm">{parsed.body.trim() ? `${parsed.body.trim().split("\n").length} lines of instructions` : <span className="text-muted-foreground">empty</span>}</dd>
                </div>
              </dl>
              {(errors.length > 0 || warnings.length > 0) && (
                <ul className="mt-3 space-y-1.5 border-t border-border pt-3 text-ui-sm">
                  {errors.map((e, i) => (
                    <li key={`e${i}`} className="flex items-start gap-2 text-destructive"><CircleX size={14} aria-hidden className="mt-0.5 shrink-0" /><span><span className="font-mono text-ui-xs">{e.field}</span> · {e.message}</span></li>
                  ))}
                  {warnings.map((w, i) => (
                    <li key={`w${i}`} className="flex items-start gap-2 text-warning"><TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0" /><span><span className="font-mono text-ui-xs">{w.field}</span> · {w.message}</span></li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Card>
        <Button size="lg" className="w-full" icon={<Send size={15} aria-hidden />} disabled={!parsed?.valid} loading={pending === "skill"} onClick={() => void submit()}>
          Register skill
        </Button>
        <p className="text-ui-xs text-muted-foreground">The skill lands as pending approval with you as owner. Its description becomes the purpose; the instructions are kept with it.</p>
      </div>
    </div>
  );
}

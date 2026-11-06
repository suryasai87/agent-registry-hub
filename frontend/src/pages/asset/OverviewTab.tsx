// Overview: the description widget (every field with provenance, inline editors, overrides with reason + lock
// mode, revert, drift resolution), a completeness meter, "At a glance" (incl. "Also registered in": Microsoft Agent 365
// IDs with provenance) and the field history drawer.
import { motion } from "framer-motion";
import { FileClock, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import AlsoRegisteredIn from "../../components/asset/AlsoRegisteredIn";
import { useAsset, endpointOf } from "../../components/asset/AssetContext";
import FieldEditor from "../../components/asset/FieldEditor";
import FieldHistoryDrawer from "../../components/asset/FieldHistoryDrawer";
import { fmtDate, isEmptyValue } from "../../components/asset/format";
import { humanize } from "../../components/asset/meta";
import { Banner, CopyButton, DefinitionList, Meter, toneForPct } from "../../components/asset/primitives";
import { Badge, Button, Card, SectionTitle } from "../../components/ui";
import { assetHref, fmtAgo } from "../../lib/assets";
import { stagger, staggerItem } from "../../lib/motion";
import type { FieldValue, Registration } from "../../lib/types";

function scalar(v: unknown): string {
  if (v == null) return "–";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export default function OverviewTab() {
  const { detail, assetId, patchDetail, reload, openUse, email } = useAsset();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  const a = detail.asset;
  const fields = detail.fields;
  const drifted = fields.filter((f) => f.drift);
  const missingRequired = fields.filter((f) => f.required && isEmptyValue(f.value));
  const empty = fields.filter((f) => isEmptyValue(f.value));
  const endpoint = endpointOf(detail);

  const onFieldChange = (next: FieldValue) => {
    patchDetail((d) => ({
      ...d,
      fields: d.fields.map((f) => (f.field_key === next.field_key ? next : f)),
      asset: next.field_key === "purpose" && typeof next.value === "string" ? { ...d.asset, purpose: next.value } : d.asset,
    }));
  };
  // Partition once per mount, so a field being edited never jumps between sections mid-save.
  const [undocKeys] = useState(() => new Set(fields.filter((f) => !f.required && !f.drift && isEmptyValue(f.value) && isEmptyValue(f.source_value)).map((f) => f.field_key)));
  const documented = fields.filter((f) => !undocKeys.has(f.field_key));
  const undocumented = fields.filter((f) => undocKeys.has(f.field_key));
  const editor = (f: FieldValue, compact = false) => (
    <FieldEditor
      assetId={assetId}
      field={f}
      permissions={detail.permissions}
      onChange={onFieldChange}
      onSaved={reload}
      onHistory={(key) => showHistory(key)}
      onCopyValue={(text) => openUse("copied_endpoint", text)}
      me={email}
      compactEmpty={compact}
    />
  );
  const showHistory = (key: string | null) => {
    setHistoryKey(key);
    setHistoryOpen(true);
  };

  const glance = [
    { key: "platform", label: "Platform", value: humanize(a.platform) },
    { key: "publisher", label: "Publisher", value: a.publisher ?? "–" },
    ...(endpoint
      ? [
          {
            key: "endpoint",
            label: a.asset_type === "mcp_server" ? "MCP URL" : "Endpoint",
            value: (
              <span className="flex items-center gap-1">
                <code className="min-w-0 break-all font-mono text-ui-xs">{endpoint}</code>
                <CopyButton value={endpoint} label="Copy endpoint" onCopied={() => openUse("copied_endpoint", endpoint)} />
              </span>
            ),
          },
        ]
      : []),
    ...(detail.parent ? [{ key: "parent", label: "Parent", value: <Link to={assetHref(detail.parent.asset_id)} className="text-primary hover:underline">{detail.parent.display_name}</Link> }] : []),
    { key: "domain", label: "Domain", value: a.domain ?? "–" },
    { key: "created", label: "Created", value: fmtDate(a.source_created_at ?? a.first_seen_at) },
    { key: "first_seen", label: "First seen", value: fmtDate(a.first_seen_at) },
    { key: "synced", label: "Last synced", value: a.last_synced_at ? fmtAgo(a.last_synced_at) : "Not synced (registered in the app)" },
    ...(a.created_by ? [{ key: "created_by", label: "Created by", value: a.created_by }] : []),
    {
      key: "tags",
      label: "Tags",
      value: a.tags.length ? (
        <span className="flex flex-wrap gap-1">
          {a.tags.map((t) => (
            <Link key={t} to={`/catalog?tag=${encodeURIComponent(t)}`}>
              <Badge>#{t}</Badge>
            </Link>
          ))}
        </span>
      ) : (
        "–"
      ),
    },
    {
      key: "also",
      label: "Also registered in",
      value: (
        <AlsoRegisteredIn
          assetId={assetId}
          items={a.also_registered_in}
          field={a.also_registered_in_field}
          canOverride={detail.permissions.can_override}
          onChanged={(next) => {
            const before = new Set(((a.also_registered_in_field?.value as Registration[] | null) ?? []).map((r) => `${r.registry}|${r.id}`));
            const manual = a.also_registered_in.filter((r) => !before.has(`${r.registry}|${r.id}`));
            patchDetail((d) => ({ ...d, asset: { ...d.asset, also_registered_in_field: next, also_registered_in: [...manual, ...((next.value as Registration[] | null) ?? [])] } }));
          }}
        />
      ),
    },
  ];
  const external = Object.entries(a.external_ref ?? {});

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-4">
        {drifted.length > 0 && (
          <Banner
            tone="warning"
            role="alert"
            icon={<TriangleAlert size={16} aria-hidden />}
            title={`Source changed ${drifted.length} overridden field${drifted.length === 1 ? "" : "s"}`}
            actions={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => document.querySelector(`[data-field="${drifted[0].field_key}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
              >
                Review {drifted[0].label}
              </Button>
            }
          >
            A sync brought a new value for {drifted.map((f) => f.label).join(", ")}. Compare it with the override and keep or accept it.
          </Banner>
        )}

        <SectionTitle
          title="Description"
          subtitle="Auto-pulled from the source system where possible. Owners fill in the rest; stewards can override synced values with a reason."
          actions={
            <Button size="sm" variant="ghost" icon={<FileClock size={14} aria-hidden />} onClick={() => showHistory(null)}>
              Field history
            </Button>
          }
        />
        <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-3">
          {documented.map((f) => (
            <motion.div key={f.field_key} variants={staggerItem}>
              {editor(f)}
            </motion.div>
          ))}
        </motion.div>
        {undocumented.length > 0 && (
          <section aria-labelledby="undocumented" className="space-y-2 pt-2">
            <h3 id="undocumented" className="text-ui-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Not documented yet ({undocumented.length})
            </h3>
            <div className="grid gap-2 lg:grid-cols-2">
              {undocumented.map((f) => (
                <div key={f.field_key} className="min-w-0">
                  {editor(f, true)}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      <aside className="space-y-4" aria-label="Asset summary">
        <Card className="space-y-3">
          <h3 className="text-ui-md font-bold">Completeness</h3>
          <Meter value={a.completeness_pct} label="Description completeness" tone={toneForPct(a.completeness_pct)} />
          <p className="text-ui-sm text-muted-foreground">
            {empty.length === 0 ? "Every field is documented." : `${empty.length} of ${fields.length} fields are empty.`}
            {missingRequired.length > 0 && <> Required and missing: <span className="font-semibold text-foreground">{missingRequired.map((f) => f.label).join(", ")}</span>.</>}
          </p>
        </Card>
        <Card className="space-y-3">
          <h3 className="text-ui-md font-bold">At a glance</h3>
          <DefinitionList items={glance} />
        </Card>
        {external.length > 0 && (
          <Card className="space-y-3">
            <h3 className="text-ui-md font-bold">Source reference</h3>
            <DefinitionList items={external.map(([k, v]) => ({ key: k, label: humanize(k), value: <span className="break-all font-mono text-ui-xs">{scalar(v)}</span> }))} />
          </Card>
        )}
      </aside>

      <FieldHistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} assetId={assetId} fields={fields} fieldKey={historyKey} onFieldKey={setHistoryKey} />
    </div>
  );
}

// Search the catalog (GET /api/catalog?q=) and pick one asset, e.g. the agent/app that consumes this asset.
// Results are a native radio group, so the choice is keyboard- and screen-reader-friendly.
import { Search } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { api } from "../../lib/api";
import type { AssetCard, AssetType, CatalogPage } from "../../lib/types";
import { cx } from "../../lib/cx";
import { Input, Skeleton } from "../ui";
import { AssetTypeBadge } from "./badges";

export interface PickedAsset {
  asset_id: string;
  display_name: string;
  asset_type: AssetType;
}

export default function AssetPicker({
  value,
  onChange,
  label = "Find the consuming asset",
  types,
  excludeId,
  autoFocus = false,
}: {
  value: PickedAsset | null;
  onChange: (asset: PickedAsset | null) => void;
  label?: string;
  /** Restrict results to these asset types (client-side). */
  types?: AssetType[];
  excludeId?: string;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<AssetCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = useId();
  const typesKey = (types ?? []).join(",");

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      const params = new URLSearchParams({ q: term, page_size: "8" });
      if (typesKey && !typesKey.includes(",")) params.set("type", typesKey);
      api.get<CatalogPage>(`/api/catalog?${params.toString()}`, { signal: controller.signal }).then(
        (env) => {
          if (controller.signal.aborted) return;
          const allowed = typesKey ? typesKey.split(",") : null;
          setResults(env.data.items.filter((a) => a.asset_id !== excludeId && (!allowed || allowed.includes(a.asset_type))));
          setError(null);
          setLoading(false);
        },
        (err: unknown) => {
          if (controller.signal.aborted) return;
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        },
      );
    }, 250);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [q, typesKey, excludeId]);

  return (
    <div className="space-y-2">
      <Input
        label={label}
        icon={<Search size={14} aria-hidden />}
        placeholder="Type 2+ characters to search agents, apps, MCP servers…"
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => setQ(e.target.value)}
        hint={value ? `Selected: ${value.display_name}` : undefined}
      />
      {loading && (
        <div aria-busy="true" className="space-y-1.5">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-2/3" />
        </div>
      )}
      {error && <p role="alert" className="text-ui-xs text-destructive">Search failed: {error}</p>}
      {!loading && results.length > 0 && (
        <fieldset className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border p-1">
          <legend className="sr-only">Search results</legend>
          {results.map((a) => {
            const checked = value?.asset_id === a.asset_id;
            return (
              <label key={a.asset_id} className={cx("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-ui-sm hover:bg-accent", checked && "bg-primary/10 ring-1 ring-primary/40")}>
                <input
                  type="radio"
                  name={name}
                  className="accent-primary"
                  checked={checked}
                  onChange={() => onChange({ asset_id: a.asset_id, display_name: a.display_name, asset_type: a.asset_type })}
                />
                <AssetTypeBadge type={a.asset_type} />
                <span className="min-w-0 flex-1 truncate font-medium">{a.display_name}</span>
                <span className="hidden max-w-[40%] truncate font-mono text-ui-xs text-muted-foreground sm:inline">{a.asset_id}</span>
              </label>
            );
          })}
        </fieldset>
      )}
      {!loading && q.trim().length >= 2 && results.length === 0 && !error && <p className="text-ui-xs text-muted-foreground">No registered asset matches “{q.trim()}”.</p>}
    </div>
  );
}

// Command-palette verbs for one asset (benchmark §3.3): open, request access, subscribe, lineage, usage, copy
// URN, open in Databricks, publish (owners). The entity page reads ?request=1 / ?subscribe=1 / ?use=1 /
// ?publish=1 and opens the matching dialog, so every verb runs in place.
import { Activity, ArrowUpRight, BellPlus, Copy, ExternalLink, GitBranch, KeyRound, Rocket } from "lucide-react";
import type { PaletteItem } from "../CommandPalette";
import { assetHref, TYPE_LABEL } from "../../lib/assets";
import type { AssetCard } from "../../lib/types";
import { copyText } from "./primitives";

export interface PaletteOptions {
  /** react-router navigate; falls back to a full page load. */
  navigate?: (to: string) => void;
}

function go(opts: PaletteOptions | undefined, to: string) {
  if (opts?.navigate) opts.navigate(to);
  else window.location.assign(to);
}

export function assetPaletteActions(asset: AssetCard, opts?: PaletteOptions): PaletteItem[] {
  const id = asset.asset_id;
  const name = asset.display_name;
  const kind = TYPE_LABEL[asset.asset_type] ?? "Asset";
  const keywords = [name, asset.name, id, kind, asset.platform, ...(asset.tags ?? [])].filter(Boolean) as string[];
  const items: PaletteItem[] = [
    { id: `asset:${id}:open`, label: `Open ${name}`, hint: `${kind} · ${id}`, group: kind, icon: ArrowUpRight, keywords, perform: () => go(opts, assetHref(id)) },
  ];
  if (!asset.my.has_access && !asset.my.requested && !asset.my.owner)
    items.push({ id: `asset:${id}:request`, label: `Request access to ${name}`, group: "Action", icon: KeyRound, keywords, perform: () => go(opts, `${assetHref(id, "access")}?request=1`) });
  if (!asset.my.subscribed)
    items.push({ id: `asset:${id}:subscribe`, label: `Subscribe to ${name}`, group: "Action", icon: BellPlus, keywords, perform: () => go(opts, `${assetHref(id, "subscribers")}?subscribe=1`) });
  items.push(
    { id: `asset:${id}:lineage`, label: `Open lineage for ${name}`, group: "Action", icon: GitBranch, keywords, perform: () => go(opts, `/lineage?focus=${encodeURIComponent(id)}`) },
    { id: `asset:${id}:usage`, label: `Usage & cost of ${name}`, group: "Action", icon: Activity, keywords, perform: () => go(opts, assetHref(id, "usage")) },
    { id: `asset:${id}:copy`, label: `Copy URN of ${name}`, hint: id, group: "Action", icon: Copy, keywords, perform: () => void copyText(id) },
  );
  if (asset.deep_link) {
    const link = asset.deep_link;
    items.push({ id: `asset:${id}:databricks`, label: `Open ${name} in Databricks`, group: "Action", icon: ExternalLink, keywords, perform: () => void window.open(link, "_blank", "noopener,noreferrer") });
  }
  if (asset.my.owner)
    items.push({ id: `asset:${id}:publish`, label: `Publish a change to ${name}`, group: "Action", icon: Rocket, keywords, perform: () => go(opts, `${assetHref(id, "changes")}?publish=1`) });
  return items;
}

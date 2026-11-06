// Shared state for one entity page: the AssetDetail, cross-tab actions (request / subscribe / use / runtime /
// review dialogs), tab navigation, and a refresh key that tabs add to their fetch deps after cross-cutting writes.
import { createContext, useContext } from "react";
import type { AssetDetail, Subscription } from "../../lib/types";
import type { RuntimeAction } from "./RuntimeActionDialog";
import type { UseOperation } from "./UseAssetDialog";

export interface AssetCtx {
  assetId: string;
  /** API prefix: /api/assets/{encoded id}. */
  base: string;
  detail: AssetDetail;
  /** The signed-in user's email (session). */
  email: string;
  isAuditor: boolean;
  reload: () => void;
  patchDetail: (fn: (d: AssetDetail) => AssetDetail) => void;
  openRequest: () => void;
  openSubscribe: () => void;
  openUse: (operation?: UseOperation, endpoint?: string | null) => void;
  openRuntime: (action: RuntimeAction) => void;
  openGovernance: () => void;
  goTab: (tab: string, query?: Record<string, string>) => void;
  /** Bumped after writes that change other tabs' data (subscribe, request, runtime, publish). */
  refreshKey: number;
  /** Optimistic subscriptions not yet confirmed by the server (shown as pending rows). */
  pendingSubscriptions: Subscription[];
}

export const AssetContext = createContext<AssetCtx | null>(null);

export function useAsset(): AssetCtx {
  const ctx = useContext(AssetContext);
  if (!ctx) throw new Error("useAsset() must be used inside the entity page");
  return ctx;
}

/** The asset's endpoint / MCP URL: the endpoint_url field, else a URL-ish attribute. */
export function endpointOf(detail: AssetDetail): string | null {
  const f = detail.fields.find((x) => x.field_key === "endpoint_url");
  if (f && typeof f.value === "string" && f.value.trim()) return f.value.trim();
  const a = detail.asset.attributes ?? {};
  for (const k of ["mcp_url", "endpoint_url", "url", "server_url", "app_url"]) {
    const v = a[k];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
  }
  return null;
}

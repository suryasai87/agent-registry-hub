// Warm an entity page on card hover/focus: load the route chunk and start GET /api/assets/{id}. The entity page
// takes the in-flight (or just-finished) response if it is fresh, so opening the card feels instant.
import { api, type Envelope } from "../../lib/api";
import { assetApi } from "../../lib/assets";
import type { AssetDetail } from "../../lib/types";

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; promise: Promise<Envelope<AssetDetail>> }>();

export function prefetchAsset(assetId: string): void {
  const path = assetApi(assetId);
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL_MS) return;
  const promise = api.get<AssetDetail>(path);
  promise.catch(() => {
    cache.delete(path);
  });
  cache.set(path, { at: Date.now(), promise });
  void import("../../pages/AssetPage");
}

/** A fresh prefetched response for ``path`` (consumed once), else null. */
export function takePrefetched(path: string): Promise<Envelope<AssetDetail>> | null {
  const hit = cache.get(path);
  cache.delete(path);
  return hit && Date.now() - hit.at < TTL_MS ? hit.promise : null;
}

// A method-aware fetch mock for page tests: answers routes by "METHOD path" (or plain path for GET) and records
// every call with its parsed JSON body and headers.
import { vi } from "vitest";
import { jsonResponse } from "../../test/utils";

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}

type Handler = unknown | ((call: RecordedCall) => unknown);

export function recordFetch(routes: Record<string, Handler | [number, Handler]>) {
  const calls: RecordedCall[] = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = init?.body;
    const call: RecordedCall = { method, path, body: typeof raw === "string" ? JSON.parse(raw) : undefined, headers: new Headers(init?.headers) };
    calls.push(call);
    const hit = routes[`${method} ${path}`] ?? (method === "GET" ? routes[path] : undefined);
    if (hit === undefined) return jsonResponse({ detail: `Not Found: ${path}` }, 404);
    const [status, handler] = Array.isArray(hit) && hit.length === 2 && typeof hit[0] === "number" ? (hit as [number, Handler]) : [200, hit];
    const value = typeof handler === "function" ? (handler as (c: RecordedCall) => unknown)(call) : handler;
    return jsonResponse(value, status);
  });
  return {
    calls,
    writes: () => calls.filter((c) => c.method !== "GET"),
    last: (method: string, prefix: string) => [...calls].reverse().find((c) => c.method === method && c.path.startsWith(prefix)),
  };
}

export const envelope = <T,>(data: T, source = "lakebase") => ({ data, source, degraded_reason: null, as_of: "2026-10-26T10:00:00+00:00" });

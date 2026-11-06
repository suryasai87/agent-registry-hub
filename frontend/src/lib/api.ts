// Typed API client. Reads come back as the backend's tier envelope ({data, source, degraded_reason, as_of},
// see app/core/tiers.py); a non-envelope JSON body (a live Databricks API passthrough) is wrapped with
// source "live". Any non-2xx response throws an ApiError carrying the HTTP status and FastAPI's detail.
import { useCallback, useEffect, useRef, useState } from "react";

export type DataSource = "lakebase" | "warehouse" | "synthetic" | "live" | "none";

export interface Envelope<T> {
  data: T;
  source: DataSource;
  degraded_reason: string | null;
  as_of: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** 503: Lakebase down or read-only kiosk mode. */
  get isUnavailable(): boolean {
    return this.status === 503;
  }
}

const SOURCES: readonly DataSource[] = ["lakebase", "warehouse", "synthetic", "live", "none"];

export function isEnvelope(body: unknown): body is Envelope<unknown> {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return "data" in b && typeof b.source === "string" && SOURCES.includes(b.source as DataSource);
}

export function toEnvelope<T>(body: unknown): Envelope<T> {
  if (isEnvelope(body)) {
    const b = body as Envelope<T>;
    return { data: b.data, source: b.source, degraded_reason: b.degraded_reason ?? null, as_of: b.as_of ?? new Date().toISOString() };
  }
  return { data: body as T, source: "live", degraded_reason: null, as_of: new Date().toISOString() };
}

/** FastAPI error bodies: {"detail": "text"} or a 422 list of {loc, msg}. */
export function errorDetail(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((d) => (typeof d === "object" && d !== null && "msg" in d ? String((d as { msg: unknown }).msg) : JSON.stringify(d)))
        .join("; ");
    }
    if (detail != null) return JSON.stringify(detail);
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 300);
  return fallback;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Headers added to every request (e.g. the admin "view as" role). null removes the header. */
const EXTRA_HEADERS = new Map<string, string>();
export function setRequestHeader(name: string, value: string | null): void {
  if (value) EXTRA_HEADERS.set(name, value);
  else EXTRA_HEADERS.delete(name);
}

export async function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  for (const [name, value] of EXTRA_HEADERS) if (!headers.has(name)) headers.set(name, value);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const res = await fetch(path, {
    ...init,
    method,
    headers,
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, errorDetail(parsed, res.statusText || `HTTP ${res.status}`));
  return parsed as T;
}

export const api = {
  /** A read through the tier choke point: always an envelope. */
  get: async <T,>(path: string, init?: RequestInit): Promise<Envelope<T>> => toEnvelope<T>(await request<unknown>("GET", path, undefined, init)),
  /** A GET whose body is returned as is (platform endpoints such as /api/health). */
  raw: <T,>(path: string, init?: RequestInit): Promise<T> => request<T>("GET", path, undefined, init),
  post: <T,>(path: string, body?: unknown, init?: RequestInit): Promise<T> => request<T>("POST", path, body, init),
  put: <T,>(path: string, body?: unknown, init?: RequestInit): Promise<T> => request<T>("PUT", path, body, init),
  patch: <T,>(path: string, body?: unknown, init?: RequestInit): Promise<T> => request<T>("PATCH", path, body, init),
  del: <T,>(path: string, init?: RequestInit): Promise<T> => request<T>("DELETE", path, undefined, init),
};

export const enc = encodeURIComponent;

export interface ApiState<T> {
  data: T | null;
  source: DataSource | null;
  degradedReason: string | null;
  asOf: string | null;
  loading: boolean;
  error: ApiError | Error | null;
}

export interface UseApi<T> extends ApiState<T> {
  /** Refetch (keeps the current data visible while loading). */
  reload: () => void;
  /** Replace the local data without a request: commit a confirmed server result, or pair with React's useOptimistic. */
  mutate: (next: T | ((prev: T | null) => T)) => void;
  /** Apply a change locally, run the request, roll back (and rethrow) if it fails, then optionally refetch. */
  optimistic: <R>(apply: (prev: T | null) => T, run: () => Promise<R>, options?: { reload?: boolean }) => Promise<R>;
}

const EMPTY: ApiState<never> = { data: null, source: null, degradedReason: null, asOf: null, loading: false, error: null };

/** Fetch an envelope for ``path`` (null = idle) and refetch when ``path`` or ``deps`` change. */
export function useApi<T>(path: string | null, deps: readonly unknown[] = []): UseApi<T> {
  const [state, setState] = useState<ApiState<T>>({ ...EMPTY, loading: path !== null });
  const [nonce, setNonce] = useState(0);
  const dataRef = useRef<T | null>(null);

  useEffect(() => {
    dataRef.current = state.data;
  }, [state.data]);

  useEffect(() => {
    if (path === null) {
      setState((s) => ({ ...s, loading: false }));
      return;
    }
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    api.get<T>(path, { signal: controller.signal }).then(
      (env) => {
        if (controller.signal.aborted) return;
        setState({ data: env.data, source: env.source, degradedReason: env.degraded_reason, asOf: env.as_of, loading: false, error: null });
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        setState((s) => ({ ...s, loading: false, error: err instanceof Error ? err : new Error(String(err)) }));
      },
    );
    return () => {
      controller.abort();
    };
    // `deps` are the caller's extra refetch triggers, spread into the dependency list on purpose.
  }, [path, nonce, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const mutate = useCallback((next: T | ((prev: T | null) => T)) => {
    setState((s) => ({ ...s, data: typeof next === "function" ? (next as (prev: T | null) => T)(s.data) : next }));
  }, []);

  const optimistic = useCallback(
    async <R,>(apply: (prev: T | null) => T, run: () => Promise<R>, options: { reload?: boolean } = {}): Promise<R> => {
      const before = dataRef.current;
      setState((s) => ({ ...s, data: apply(s.data) }));
      try {
        const result = await run();
        if (options.reload) setNonce((n) => n + 1);
        return result;
      } catch (err) {
        setState((s) => ({ ...s, data: before }));
        throw err;
      }
    },
    [],
  );

  return { ...state, reload, mutate, optimistic };
}

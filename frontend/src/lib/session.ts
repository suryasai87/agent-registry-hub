// The signed-in user for the shell: GET /api/me (roles, counts) plus /api/health for the status dot.
// Admins can preview a lower role ("view as"); the choice is persisted and sent on every API call as
// the x-registry-view-as header (the backend only ever lets it REDUCE privileges).
import { createContext, createElement, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, setRequestHeader } from "./api";
import { readStored, writeStored } from "./storage";
import type { Me, Role } from "./types";

export interface SessionUser {
  email: string;
  name: string;
  role?: string | null;
}

export interface Health {
  status: "ok" | "degraded" | "error";
  app: string;
  version: string;
  allow_mutations: boolean;
  lakebase: { ok: boolean; latency_ms: number | null; mode?: string; schema?: string; error?: string };
  warehouse: { configured: boolean; ok?: boolean; state?: string; error?: string };
  user: { email: string; name: string; source?: string } | null;
  time?: string;
}

export interface Session {
  user: SessionUser | null;
  me: Me | null;
  health: Health | null;
  loading: boolean;
  viewAs: Role | null;
  setViewAs: (role: Role | null) => void;
  refresh: () => void;
  /** True when the user (in the current view) holds any of ``roles``. */
  hasRole: (...roles: Role[]) => boolean;
}

const VIEW_AS_KEY = "arh.viewAs";
export const VIEW_AS_HEADER = "x-registry-view-as";

function initialViewAs(): Role | null {
  const v = readStored(VIEW_AS_KEY);
  return v ? (v as Role) : null;
}
setRequestHeader(VIEW_AS_HEADER, initialViewAs());

export async function loadSession(signal?: AbortSignal): Promise<{ user: SessionUser | null; me: Me | null; health: Health | null }> {
  const health = await api.raw<Health>("/api/health", { signal }).catch(() => null);
  try {
    const me = (await api.get<Me>("/api/me", { signal })).data;
    return { user: { email: me.email, name: me.display_name || me.email, role: me.primary_role }, me, health };
  } catch (err) {
    if (!signal?.aborted) console.warn("GET /api/me failed", err);
    const u = health?.user;
    return { user: u ? { email: u.email, name: u.name || u.email, role: null } : null, me: null, health };
  }
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ user: SessionUser | null; me: Me | null; health: Health | null; loading: boolean }>(
    { user: null, me: null, health: null, loading: true });
  const [viewAs, setViewAsState] = useState<Role | null>(initialViewAs);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    loadSession(controller.signal).then((s) => {
      if (!controller.signal.aborted) setState({ ...s, loading: false });
    });
    return () => {
      controller.abort();
    };
  }, [nonce, viewAs]);

  const setViewAs = useCallback((role: Role | null) => {
    writeStored(VIEW_AS_KEY, role ?? "");
    setRequestHeader(VIEW_AS_HEADER, role);
    setViewAsState(role);
  }, []);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const hasRole = useCallback((...roles: Role[]) => !!state.me && roles.some((r) => state.me!.roles.includes(r)), [state.me]);

  const value: Session = { ...state, viewAs, setViewAs, refresh, hasRole };
  return createElement(SessionContext.Provider, { value }, children);
}

/** The session. Outside a SessionProvider (unit tests) it loads its own copy. */
export function useSession(): Session {
  const ctx = useContext(SessionContext);
  const [local, setLocal] = useState<{ user: SessionUser | null; me: Me | null; health: Health | null; loading: boolean }>(
    { user: null, me: null, health: null, loading: !ctx });
  useEffect(() => {
    if (ctx) return;
    const controller = new AbortController();
    loadSession(controller.signal).then((s) => {
      if (!controller.signal.aborted) setLocal({ ...s, loading: false });
    });
    return () => {
      controller.abort();
    };
  }, [ctx]);
  if (ctx) return ctx;
  return {
    ...local, viewAs: null, setViewAs: () => undefined, refresh: () => undefined,
    hasRole: (...roles: Role[]) => !!local.me && roles.some((r) => local.me!.roles.includes(r)),
  };
}

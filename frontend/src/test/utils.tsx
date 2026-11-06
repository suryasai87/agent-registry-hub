// Render helpers: providers are passed through RTL's ``wrapper`` option (not inlined into the ui), so
// rerender() updates the same tree the way a state change does in the app.
import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { ToastProvider } from "../components/ui";

export function renderWithProviders(ui: ReactElement, { route = "/", ...options }: { route?: string } & Omit<RenderOptions, "wrapper"> = {}) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <ToastProvider>
      <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
    </ToastProvider>
  );
  return render(ui, { wrapper: Wrapper, ...options });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Route fetch by path: ``mockFetch({"/api/health": [200, {...}]})``; anything else is a JSON 404. */
export function mockFetch(routes: Record<string, [number, unknown]>) {
  return vi.mocked(fetch).mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const hit = routes[path];
    return hit ? jsonResponse(hit[1], hit[0]) : jsonResponse({ detail: `Not Found: ${path}` }, 404);
  });
}

export const HEALTH_OK = {
  status: "ok",
  app: "agent-registry-hub",
  version: "0.1.0",
  allow_mutations: true,
  lakebase: { ok: true, latency_ms: 4.2, mode: "dsn", schema: "registry" },
  warehouse: { configured: false },
  user: { email: "jane.doe@example.com", name: "Jane Doe", source: "apps" },
  time: "2026-10-25T12:00:00+00:00",
};

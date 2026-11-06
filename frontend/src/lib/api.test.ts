import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../test/utils";
import { ApiError, api, errorDetail, isEnvelope, toEnvelope, useApi } from "./api";

const ENVELOPE = { data: [{ id: "a1", name: "triage-agent" }], source: "warehouse", degraded_reason: "lakebase: LakebaseUnavailable: down", as_of: "2026-10-25T12:00:00+00:00" };

describe("envelope parsing", () => {
  it("passes a tier envelope through unchanged", () => {
    expect(isEnvelope(ENVELOPE)).toBe(true);
    expect(toEnvelope(ENVELOPE)).toEqual(ENVELOPE);
  });

  it("wraps a plain JSON body as a live API answer", () => {
    const env = toEnvelope<{ status: string }>({ status: "ok" });
    expect(env.source).toBe("live");
    expect(env.data).toEqual({ status: "ok" });
    expect(env.degraded_reason).toBeNull();
    expect(Number.isNaN(Date.parse(env.as_of))).toBe(false);
  });

  it("does not mistake an object with an unknown source for an envelope", () => {
    expect(isEnvelope({ data: 1, source: "cache" })).toBe(false);
    expect(isEnvelope(null)).toBe(false);
  });

  it("api.get returns the envelope from the server", async () => {
    mockFetch({ "/api/agents": [200, ENVELOPE] });
    const env = await api.get<typeof ENVELOPE.data>("/api/agents");
    expect(env.source).toBe("warehouse");
    expect(env.data[0].name).toBe("triage-agent");
    expect(env.degraded_reason).toContain("LakebaseUnavailable");
  });
});

describe("ApiError", () => {
  it("carries the status and FastAPI's string detail", async () => {
    mockFetch({ "/api/agents": [503, { detail: "Read-only kiosk mode (ALLOW_MUTATIONS=false): changes are disabled" }] });
    const err = await api.post("/api/agents", { name: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    expect((err as ApiError).isUnavailable).toBe(true);
    expect((err as ApiError).detail).toContain("Read-only kiosk mode");
    expect((err as ApiError).message).toBe((err as ApiError).detail);
  });

  it("flattens a 422 validation list and falls back to the status text", () => {
    expect(errorDetail({ detail: [{ loc: ["body", "name"], msg: "Field required" }, { msg: "too short" }] }, "x")).toBe("Field required; too short");
    expect(errorDetail(null, "Bad Gateway")).toBe("Bad Gateway");
    expect(errorDetail("<html>proxy error</html>", "x")).toBe("<html>proxy error</html>");
  });

  it("raises ApiError for a 404 on reads", async () => {
    const err = await api.get("/api/nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).isNotFound).toBe(true);
  });

  it("sends JSON bodies with the right method and headers", async () => {
    const spy = vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: 7 }, 201));
    await expect(api.put<{ id: number }>("/api/agents/7", { owner: "jane" })).resolves.toEqual({ id: 7 });
    const [path, init] = spy.mock.calls[0];
    expect(path).toBe("/api/agents/7");
    expect(init?.method).toBe("PUT");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ owner: "jane" }));
  });
});

describe("useApi", () => {
  it("loads the envelope, exposes source + reason, and reloads", async () => {
    const spy = mockFetch({ "/api/agents": [200, ENVELOPE] });
    const { result } = renderHook(() => useApi<typeof ENVELOPE.data>("/api/agents"));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(ENVELOPE.data);
    expect(result.current.source).toBe("warehouse");
    expect(result.current.degradedReason).toContain("LakebaseUnavailable");
    expect(result.current.error).toBeNull();

    const calls = spy.mock.calls.length;
    act(() => result.current.reload());
    await waitFor(() => expect(spy.mock.calls.length).toBe(calls + 1));
  });

  it("surfaces an ApiError and keeps idle when the path is null", async () => {
    const { result } = renderHook(() => useApi("/api/missing"));
    await waitFor(() => expect(result.current.error).toBeInstanceOf(ApiError));
    expect((result.current.error as ApiError).status).toBe(404);
    const idle = renderHook(() => useApi(null));
    expect(idle.result.current.loading).toBe(false);
  });

  it("rolls an optimistic change back when the request fails", async () => {
    mockFetch({ "/api/agents": [200, ENVELOPE] });
    const { result } = renderHook(() => useApi<{ id: string; name: string }[]>("/api/agents"));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    await act(async () => {
      await expect(
        result.current.optimistic(
          (prev) => [...(prev ?? []), { id: "b2", name: "new" }],
          () => Promise.reject(new Error("409 conflict")),
        ),
      ).rejects.toThrow("409 conflict");
    });
    expect(result.current.data).toEqual(ENVELOPE.data);

    act(() => result.current.mutate((prev) => [...(prev ?? []), { id: "c3", name: "confirmed" }]));
    expect(result.current.data?.map((r) => r.id)).toEqual(["a1", "c3"]);
  });
});
